// The record sanitization oracle (P6-T02, architecture §7). Deliberately independent of the builder: it re-states what
// a sanitized record may contain (its own caps, its own list of forbidden content) and scans a finished record or an
// API response. A violation names a path and a rule, never the offending value.
//
// Two layers:
//  - `leakViolations(value)`: infrastructure leaks anywhere in any JSON (internal paths, `file:` refs, provider ids,
//    credentials, secrets that are actually configured, hidden keys, signed links where none belong). For DTOs.
//  - `recordViolations(record)`: the above on every structural string of a record, plus hygiene (no control or
//    invisible characters, NFC, collapsed whitespace), per-field length caps, and the shape of signed file links.
//    Free text the user wrote (a problem description, notes) is held to hygiene and caps, and to configured secrets,
//    but not to the leak patterns: a person may legitimately type "see file: x" in their notes.
import { RECORD_FIELD_IDS } from "@device-repair/shared/fields";

export interface OracleOptions {
  /** Secret values the deployment really holds (keys, tokens, DB URL): none may appear anywhere, even in free text. */
  secrets?: readonly string[];
}

export interface Violation {
  path: string;
  rule: string;
}

/** Forbidden content in structural (system-controlled) strings and in DTOs. */
const LEAK_PATTERNS: readonly (readonly [rule: string, pattern: RegExp])[] = [
  ["internal path /data/", /\/data\//],
  ["internal path", /(^|[\s"'=(])\/(tmp|var|home|Users|etc|opt|srv|root|mnt)\//],
  ["internal file ref (file:)", /(?<![A-Za-z0-9_-])file:[A-Za-z0-9]/],
  ["api key (sk-)", /(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{4,}/],
  ["api key (gsk_)", /(?<![A-Za-z0-9_-])gsk_[A-Za-z0-9]{4,}/],
  ["api key (AIza)", /(?<![A-Za-z0-9_-])AIza[0-9A-Za-z_-]{8,}/],
  ["api key (dg_)", /(?<![A-Za-z0-9_-])dg_[A-Za-z0-9]{6,}/],
  ["bearer token", /\bBearer\s+\S{6,}/i],
  ["database url", /\bpostgres(ql)?:\/\//i],
  // Groq/OpenAI-style ids; our own ids (req_serialNumber_1, m_..., tu_c...) never look like these.
  ["provider request id", /(?<![A-Za-z0-9_-])(chatcmpl-[A-Za-z0-9]{6,}|(req|resp|msg|run)_0[0-9a-z]{10,})/],
  ["provider request id (uuid after a provider name)", /\b(deepgram|groq|gemini)[\w-]*[:=]\s*[0-9a-f]{8}-[0-9a-f]{4}-/i],
];

/** The same hidden keys the read API strips (http/sessions.ts), restated here on purpose. */
const HIDDEN_KEY = /(secret|token$|password|passwd|api_?key|authorization|cookie|path$|storage_?key|^evidence$|^provider\w*id$)/i;

/** C0/C1 controls (a newline is allowed only in notes, where it is removed before this test), zero-width, bidi and tag characters, BOM. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: the oracle looks for control characters.
const CONTROL = /[\u0000-\u001F\u007F-\u009F\u061C\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF\u{E0000}-\u{E007F}]|[\u{E0100}-\u{E01EF}]/u;
const SIGNED_URL = /^https?:\/\/[^\s?#]+\/files\/f[A-Za-z0-9_-]+\?exp=\d{1,12}&sig=[A-Za-z0-9_-]{6,}$/;
const IST_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+05:30$/;

/** Max length in code points per logical path (`[]` = any array index). Anything unlisted is capped at 1,000. */
const CAPS: readonly (readonly [RegExp, number])[] = [
  [/^fields\.(deviceType|email)\.value$/, 254],
  [/^fields\.additionalNotes\.value$/, 1000],
  [/^fields\.deviceModel\.value\.(brand|model)$/, 80],
  [/^fields\.problemDescription\.value\.summary$/, 300],
  [/^fields\.problemDescription\.value\.verbatim$/, 1000],
  [/^fields\.problemStartedAt\.value\.spoken$/, 200],
  [/^fields\.urgency\.value\.reason$/, 200],
  [/^fields\.serviceCentre\.value\.name$/, 100],
  [/^fields\.serviceCentre\.value\.city$/, 60],
  [/^fields\.serialNumber\.value\.value$/, 20],
  [/^outcomeReason$/, 1000],
  [/^reviewFlags\[\]\.reason$/, 300],
  [/^conflicts\[\]\.reason$/, 300],
];

/** Free text the user (or the model, quoting them) wrote. */
const FREE_TEXT: readonly RegExp[] = [
  /^fields\.deviceModel\.value\.(brand|model)$/, // what the user named ("SK-1200" is a real model)
  /^fields\.problemDescription\.value\.(summary|verbatim)$/,
  /^fields\.problemStartedAt\.value\.spoken$/,
  /^fields\.urgency\.value\.reason$/,
  /^fields\.additionalNotes\.value$/,
  /^reviewFlags\[\]\.reason$/,
];

/** A needsReview reason is "needs review: R-1 <flag reason>" (outcome.ts), so it carries the flags' free text. */
const isFreeText = (record: Record<string, unknown>, logical: string): boolean =>
  FREE_TEXT.some((pattern) => pattern.test(logical)) || (logical === "outcomeReason" && record.outcome === "needsReview");

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const length = (text: string) => [...text].length;

function walk(value: unknown, path: string, visit: (path: string, key: string | null, text: string) => void, onKey?: (path: string, key: string) => void): void {
  if (typeof value === "string") visit(path, null, value);
  else if (Array.isArray(value)) {
    for (const [i, item] of value.entries()) walk(item, `${path}[${i}]`, visit, onKey);
  }
  else if (isObject(value)) {
    for (const [key, item] of Object.entries(value)) {
      onKey?.(path, key);
      walk(item, path === "" ? key : `${path}.${key}`, visit, onKey);
    }
  }
}

const secretViolations = (path: string, text: string, secrets: readonly string[]): Violation[] =>
  secrets.some((secret) => secret.length >= 8 && text.includes(secret)) ? [{ path, rule: "configured secret" }] : [];

function leakRules(text: string): string[] {
  return LEAK_PATTERNS.filter(([, pattern]) => pattern.test(text)).map(([rule]) => rule);
}

/** Infrastructure leaks anywhere in a JSON value. `allowSignedUrls` is true only for records. */
export function leakViolations(value: unknown, { secrets = [] }: OracleOptions = {}, allowSignedUrls = false): Violation[] {
  const found: Violation[] = [];
  walk(
    value,
    "",
    (path, _key, text) => {
      for (const rule of leakRules(text)) found.push({ path, rule });
      found.push(...secretViolations(path, text, secrets));
      if (!allowSignedUrls && /[?&]sig=/.test(text)) found.push({ path, rule: "signed link outside a record" });
    },
    (path, key) => {
      if (HIDDEN_KEY.test(key)) found.push({ path: path === "" ? key : `${path}.${key}`, rule: "hidden key" });
      if (!allowSignedUrls && key === "url") found.push({ path: path === "" ? key : `${path}.${key}`, rule: "url key outside a record" });
    },
  );
  return found;
}

/** `conflicts[0].callValue.summary` is the same logical value as `fields.<field>.value.summary`. */
function logicalPath(record: Record<string, unknown>, path: string): string {
  const generic = path.replace(/\[\d+\]/g, "[]");
  const match = /^conflicts\[(\d+)\]\.(callValue|chatValue)(.*)$/.exec(path);
  if (!match) return generic;
  const conflict = Array.isArray(record.conflicts) ? record.conflicts[Number(match[1])] : undefined;
  const field = isObject(conflict) ? conflict.field : undefined;
  return typeof field === "string" ? `fields.${field}.value${match[3]?.replace(/\[\d+\]/g, "[]") ?? ""}` : generic;
}

/** Everything wrong with a record, in terms a failing test can print safely (paths and rules only). */
export function recordViolations(record: unknown, options: OracleOptions = {}): Violation[] {
  if (!isObject(record)) return [{ path: "", rule: "record is not an object" }];
  const found: Violation[] = [];
  const secrets = options.secrets ?? [];

  walk(
    record,
    "",
    (path, _key, text) => {
      const logical = logicalPath(record, path);
      const multiline = logical === "fields.additionalNotes.value";
      const isUrl = /\.url$/.test(path) && /^fields\.(purchaseInvoice|additionalPhotos)/.test(logical);

      // Hygiene (all strings).
      if (CONTROL.test(multiline ? text.replace(/\n/g, "") : text)) found.push({ path, rule: "control or invisible character" });
      if (text !== text.normalize("NFC")) found.push({ path, rule: "not NFC" });
      if (!multiline && (/\s{2,}/.test(text) || text !== text.trim())) found.push({ path, rule: "uncollapsed whitespace" });
      if (multiline && (text !== text.trim() || /\n{3,}/.test(text) || /[ \t]{2,}/.test(text))) found.push({ path, rule: "uncollapsed whitespace" });

      // Caps.
      const cap = CAPS.find(([pattern]) => pattern.test(logical))?.[1] ?? 1000;
      if (length(text) > cap) found.push({ path, rule: `longer than ${cap}` });

      // Secrets are forbidden everywhere; leak patterns only outside free text and outside a file's signed link.
      found.push(...secretViolations(path, text, secrets));
      if (isUrl) {
        if (!SIGNED_URL.test(text)) found.push({ path, rule: "file link is not a signed /files/ link" });
      } else if (!isFreeText(record, logical)) {
        for (const rule of leakRules(text)) found.push({ path, rule });
      }
    },
    (path, key) => {
      // The schema forbids extra keys; this catches a leak that happens to be a valid key name.
      if (HIDDEN_KEY.test(key)) found.push({ path: path === "" ? key : `${path}.${key}`, rule: "hidden key" });
    },
  );

  for (const key of ["createdAt", "endedAt"] as const) {
    if (typeof record[key] !== "string" || !IST_ISO.test(record[key] as string)) found.push({ path: key, rule: "timestamp is not IST ISO-8601" });
  }
  const fields = record.fields;
  if (!isObject(fields)) found.push({ path: "fields", rule: "missing" });
  else {
    for (const id of RECORD_FIELD_IDS) {
      const entry = fields[id];
      if (!isObject(entry)) {
        found.push({ path: `fields.${id}`, rule: "missing field entry" });
        continue;
      }
      if (typeof entry.collectedAt === "string" && !IST_ISO.test(entry.collectedAt)) found.push({ path: `fields.${id}.collectedAt`, rule: "timestamp is not IST ISO-8601" });
      // A field with no value says so (status), and a value never comes without a source.
      if (entry.value === null && (entry.status === "valid" || entry.status === "unverified")) found.push({ path: `fields.${id}`, rule: "valid or unverified field without a value" });
      if (entry.value !== null && entry.source === null) found.push({ path: `fields.${id}`, rule: "value without a source" });
    }
    for (const key of Object.keys(fields)) {
      if (!(RECORD_FIELD_IDS as readonly string[]).includes(key)) found.push({ path: `fields.${key}`, rule: "unknown field" });
    }
  }
  return found;
}

/** Throws with every violation (paths and rules) so a failing test shows what and where, never the values. */
export function expectSanitizedRecord(record: unknown, options: OracleOptions = {}): void {
  const found = recordViolations(record, options);
  if (found.length > 0) throw new Error(`record is not sanitized:\n${found.map((v) => `  ${v.path || "(root)"}: ${v.rule}`).join("\n")}`);
}

export function expectNoLeaks(value: unknown, options: OracleOptions = {}, allowSignedUrls = false): void {
  const found = leakViolations(value, options, allowSignedUrls);
  if (found.length > 0) throw new Error(`leaks found:\n${found.map((v) => `  ${v.path || "(root)"}: ${v.rule}`).join("\n")}`);
}
