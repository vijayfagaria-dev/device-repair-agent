// The free-tier quota guard (P10-T03, architecture §8/§9). The URL is public and every provider is on a free tier, so
// running out mid-review would look like downtime. Before a call starts, the guard reads the usage ledger (P3-T07)
// and refuses new calls (close 4429 `quota`, chat keeps working) once either budget is spent:
//   - LLM requests: the busiest Groq model in the last 24 h against DAILY_LLM_REQUEST_BUDGET (Groq's limit is per model);
//   - Deepgram audio minutes in the last 24 h against DAILY_AUDIO_MINUTES_BUDGET.
// A provider that refuses us outright (Deepgram 401/402/403: key revoked or credit gone) latches the guard for a
// cooldown, so each new caller doesn't spend a connection attempt finding out. The owner can lift the guard for 24 h
// with QUOTA_OVERRIDE_TOKEN (POST /api/quota/override). The window is rolling, not a calendar day: providers reset at
// different times and the rolling count is never below the count inside any one of them.
import { createHash, timingSafeEqual } from "node:crypto";
import type { Secret } from "../config.js";
import type { Queryable } from "../db/tx.js";
import { type DailyUsage, rollingDayUsage } from "../metrics/usage.js";

export type QuotaRefusal = "llm_budget" | "audio_budget" | "provider_unavailable";
export type QuotaVerdict = { ok: true } | { ok: false; reason: QuotaRefusal };

export interface QuotaSettings {
  /** LLM requests per Groq model per rolling 24 h. */
  llmRequestsPerDay: number;
  audioMinutesPerDay: number;
  overrideToken: Secret | null;
  /** How long a ledger reading is reused (default 15 s: one query per window, however many callers). */
  cacheMs?: number;
  /** How long a provider refusal (401/402/403) keeps calls refused (default 10 min). */
  providerCooldownMs?: number;
  /** How long an override lifts the guard (default 24 h). */
  overrideMs?: number;
}

export interface QuotaLog {
  warn(object: Record<string, unknown>, message: string): void;
  info(object: Record<string, unknown>, message: string): void;
}

const DEFAULTS = { cacheMs: 15_000, providerCooldownMs: 10 * 60_000, overrideMs: 24 * 60 * 60_000 } as const;

const digest = (value: string) => createHash("sha256").update(value).digest();

/** Provider errors that mean "we are not allowed", not "try again": a bad or revoked key, or no credit left. */
export function isProviderRefusal(error: unknown): boolean {
  const status = (error as { status?: unknown; statusCode?: unknown } | null)?.status ?? (error as { statusCode?: unknown } | null)?.statusCode;
  if (status === 401 || status === 402 || status === 403) return true;
  // `ws` reports a refused upgrade as "Unexpected server response: 401".
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === "string" && /Unexpected server response: (401|402|403)\b/.test(message);
}

export class QuotaGuard {
  readonly #db: Queryable;
  readonly #settings: Required<Omit<QuotaSettings, "overrideToken">> & Pick<QuotaSettings, "overrideToken">;
  readonly #log: QuotaLog;
  readonly #now: () => number;
  #verdict: QuotaVerdict = { ok: true };
  #readAt = Number.NEGATIVE_INFINITY;
  #reading: Promise<QuotaVerdict> | null = null;
  #latchedUntil = 0;
  #overriddenUntil = 0;

  constructor(db: Queryable, settings: QuotaSettings, log: QuotaLog, now: () => number = Date.now) {
    this.#db = db;
    this.#settings = {
      ...settings,
      cacheMs: settings.cacheMs ?? DEFAULTS.cacheMs,
      providerCooldownMs: settings.providerCooldownMs ?? DEFAULTS.providerCooldownMs,
      overrideMs: settings.overrideMs ?? DEFAULTS.overrideMs,
    };
    this.#log = log;
    this.#now = now;
  }

  /** Whether QUOTA_OVERRIDE_TOKEN is configured (the override route exists only then). */
  get canOverride(): boolean {
    return this.#settings.overrideToken !== null;
  }

  /** True while an override is in force. */
  get overridden(): boolean {
    return this.#now() < this.#overriddenUntil;
  }

  /**
   * Whether a call may start now. Reads the ledger at most once per `cacheMs`. If the ledger can't be read, the call
   * is allowed (a database outage already fails the call itself; locking everyone out on a blip would be worse).
   */
  async check(): Promise<QuotaVerdict> {
    if (this.overridden) return { ok: true };
    if (this.#now() < this.#latchedUntil) return { ok: false, reason: "provider_unavailable" };
    if (this.#now() - this.#readAt < this.#settings.cacheMs) return this.#verdict;
    this.#reading ??= this.#read().finally(() => {
      this.#reading = null;
    });
    return this.#reading;
  }

  /**
   * What the client is told in `sessionState.voiceAvailable`: the last verdict, without waiting for the database. A stale
   * verdict starts a refresh in the background (at most one per cache window), so a "voice unavailable" notice doesn't
   * outlive the budget; the client learns the new value when its next state message goes out.
   */
  voiceAvailable(): boolean {
    if (this.overridden) return true;
    if (this.#now() - this.#readAt >= this.#settings.cacheMs) void this.check();
    if (this.#now() < this.#latchedUntil) return false;
    return this.#verdict.ok;
  }

  async #read(): Promise<QuotaVerdict> {
    let usage: DailyUsage;
    try {
      usage = await rollingDayUsage(this.#db, new Date(this.#now()));
    } catch (err) {
      this.#log.warn({ code: (err as { code?: string }).code, message: (err as Error).message }, "quota guard could not read the usage ledger; allowing the call");
      return { ok: true };
    }
    const groq = Object.entries(usage.llmRequests).filter(([name]) => name.startsWith("groq:"));
    const busiest = groq.reduce<[string, number]>((top, entry) => (entry[1] > top[1] ? entry : top), ["", 0]);
    let verdict: QuotaVerdict = { ok: true };
    if (busiest[1] >= this.#settings.llmRequestsPerDay) verdict = { ok: false, reason: "llm_budget" };
    else if (usage.audioMinutes >= this.#settings.audioMinutesPerDay) verdict = { ok: false, reason: "audio_budget" };
    if (!verdict.ok && this.#verdict.ok) {
      this.#log.warn({ reason: verdict.reason, model: busiest[0] || undefined, requests: busiest[1], audioMinutes: usage.audioMinutes }, "quota guard: new calls refused");
    }
    this.#verdict = verdict;
    this.#readAt = this.#now();
    return verdict;
  }

  /** A provider refused our credentials or credit: refuse calls for a cooldown instead of failing each one. */
  providerRefused(provider: string): void {
    if (this.overridden) return;
    this.#latchedUntil = this.#now() + this.#settings.providerCooldownMs;
    this.#log.warn({ provider, cooldownMs: this.#settings.providerCooldownMs }, "quota guard: a provider refused the request; new calls refused for the cooldown");
  }

  /** Lifts the guard for `overrideMs` when `token` is the configured override token (constant-time compare). */
  override(token: string): boolean {
    const configured = this.#settings.overrideToken;
    if (!configured || !timingSafeEqual(digest(token), digest(configured.reveal()))) return false;
    this.#overriddenUntil = this.#now() + this.#settings.overrideMs;
    this.#latchedUntil = 0;
    this.#readAt = Number.NEGATIVE_INFINITY;
    this.#log.info({ untilMs: this.#overriddenUntil }, "quota guard: overridden by the owner");
    return true;
  }
}
