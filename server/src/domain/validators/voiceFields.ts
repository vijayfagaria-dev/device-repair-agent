// Validators for the fields collected on the call (D14, P2-T02). The LLM proposes values through save_field; these
// decide. Inputs are the tool's arguments (a string, or an object with the model's normalized guess plus the user's
// words) or a chat fallback card's answer. Every `error` is one short sentence the agent can say.
import {
  DEVICE_TYPES,
  type DeviceModelValue,
  type DeviceType,
  type ProblemDescriptionValue,
  type ProblemStartedAtValue,
  URGENCY_LEVELS,
  type UrgencyLevel,
  type UrgencyValue,
} from "@device-repair/shared/fields";
import { addMonths, type CivilDate, isCivilDate } from "../dates.js";
import { invalid, valid, type ValidationResult } from "./result.js";
import { isUnknownDatePhrase, resolveSpokenDate } from "./spokenDate.js";
import { charLength, cleanText, hasPhrase, phraseStarts, truncate, words } from "./strings.js";

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const stringField = (value: unknown, key: string): string | undefined => {
  const field = isRecord(value) ? value[key] : undefined;
  return typeof field === "string" ? field : undefined;
};

const UNKNOWN_ANSWER = /\b(?:dont know|do not know|not sure|no idea|unknown|cant remember|dont remember|no clue)\b/;
const isUnknownAnswer = (text: string) => UNKNOWN_ANSWER.test(words(text).join(" "));

// ---------------------------------------------------------------------------------------------------------------------
// deviceType

/** Checked in this order, so "galaxy watch" is a smartwatch and "galaxy tab" a tablet, not a phone. */
const DEVICE_TYPE_PHRASES: readonly [DeviceType, readonly string[]][] = [
  ["headphones", ["headphones", "headphone", "earphones", "earphone", "earbuds", "earbud", "airpods", "headset", "buds", "neckband"]],
  ["smartwatch", ["smartwatch", "smart watch", "watch", "fitness band", "fitbit"]],
  ["tablet", ["tablet", "ipad", "tab"]],
  ["laptop", ["laptop", "notebook", "macbook", "chromebook", "ultrabook", "thinkpad"]],
  ["smartphone", ["smartphone", "phone", "mobile", "cellphone", "iphone", "android", "galaxy", "pixel", "handset"]],
  ["other", ["other", "something else", "desktop", "camera", "speaker", "console", "tv", "television", "printer", "kindle"]],
];

export function validateDeviceType(raw: unknown): ValidationResult<DeviceType> {
  const ask = "Sorry, what kind of device is it: a phone, laptop, tablet, smartwatch or headphones?";
  if (typeof raw !== "string") return invalid(ask);
  const exact = cleanText(raw).toLowerCase();
  if ((DEVICE_TYPES as readonly string[]).includes(exact)) return valid(exact as DeviceType);
  const tokens = words(raw);
  for (const [type, phrases] of DEVICE_TYPE_PHRASES) {
    if (phrases.some((phrase) => hasPhrase(tokens, phrase))) return valid(type);
  }
  return invalid(ask);
}

// ---------------------------------------------------------------------------------------------------------------------
// deviceModel

/** Canonical brand names, keyed by the words that identify them (D14: brand canonicalized from an alias list). */
const BRANDS: readonly [string, readonly string[]][] = [
  ["Apple", ["apple", "iphone", "ipad", "macbook", "imac", "airpods"]],
  ["Samsung", ["samsung", "galaxy"]],
  ["Google", ["google", "pixel", "fitbit"]],
  ["OnePlus", ["oneplus", "one plus"]],
  ["Xiaomi", ["xiaomi", "redmi", "poco"]],
  ["OPPO", ["oppo"]],
  ["vivo", ["vivo"]],
  ["realme", ["realme"]],
  ["Motorola", ["motorola", "moto"]],
  ["Nokia", ["nokia"]],
  ["Sony", ["sony", "xperia"]],
  ["Dell", ["dell", "xps", "inspiron", "alienware"]],
  ["HP", ["hp", "pavilion", "elitebook", "hewlett packard"]],
  ["Lenovo", ["lenovo", "thinkpad", "ideapad"]],
  ["ASUS", ["asus", "zenbook", "vivobook"]],
  ["Acer", ["acer", "aspire"]],
  ["Microsoft", ["microsoft", "surface"]],
  ["Huawei", ["huawei"]],
  ["Honor", ["honor"]],
  ["LG", ["lg"]],
  ["boAt", ["boat"]],
  ["JBL", ["jbl"]],
  ["Bose", ["bose"]],
  ["Sennheiser", ["sennheiser"]],
  ["Garmin", ["garmin"]],
];

export function detectBrand(text: string): string | null {
  const tokens = words(text);
  for (const [brand, aliases] of BRANDS) {
    if (aliases.some((alias) => hasPhrase(tokens, alias))) return brand;
  }
  return null;
}

export interface DeviceModelOptions {
  /** After one re-ask, "I don't know" is accepted as unknown (D14); the controller tracks the attempt. */
  allowUnknown?: boolean;
}

/** Brand and model: "iPhone 14 Pro" → { brand: "Apple", model: "iPhone 14 Pro" }. */
export function validateDeviceModel(raw: unknown, { allowUnknown = false }: DeviceModelOptions = {}): ValidationResult<DeviceModelValue> {
  const ask = "Which brand and model is it? For example, Samsung Galaxy S23.";
  const text = cleanText(typeof raw === "string" ? raw : [stringField(raw, "brand"), stringField(raw, "model")].filter(Boolean).join(" "));
  if (text === "") return invalid(ask);
  if (isUnknownAnswer(text)) {
    // "It's a Samsung, not sure which model": the brand is what they know, the same as answering just "Samsung".
    const knownBrand = detectBrand(text);
    if (knownBrand) return valid({ brand: knownBrand, model: null });
    return allowUnknown
      ? valid({ brand: null, model: null })
      : invalid("No problem. Could you check the box, the label, or Settings, About? Even just the brand helps.");
  }
  if (charLength(text) < 2 || charLength(text) > 80 || !/\p{L}/u.test(text)) return invalid(ask);
  const brand = detectBrand(text);
  // The model is what was said, minus a leading brand name ("Samsung Galaxy S23" → "Galaxy S23"); product-line
  // words stay ("iPhone 14 Pro" keeps "iPhone").
  const leadingBrand = brand === "OnePlus" ? /^one ?plus(?:\s+|$)/i : brand ? new RegExp(`^${brand}(?:\\s+|$)`, "i") : null;
  const model = leadingBrand ? text.replace(leadingBrand, "").trim() : text;
  return valid({ brand, model: model === "" ? null : model });
}

// ---------------------------------------------------------------------------------------------------------------------
// problemDescription

const FILLERS = new Set(["um", "uh", "er", "erm", "hmm", "like", "so", "well", "basically", "actually", "okay", "ok", "yeah", "yes", "you", "know", "mean"]);
/** Words that don't describe a symptom by themselves: "it's broken", "my phone is not working". */
const VAGUE = new Set([
  "a", "an", "the", "it", "its", "is", "was", "are", "my", "this", "that", "has", "have", "been", "just", "i", "me", "not", "isnt",
  "doesnt", "dont", "very", "really", "some", "there", "and", "or", "of", "to", "at", "in", "on",
  "broken", "working", "work", "works", "problem", "problems", "issue", "issues", "bad", "damaged", "faulty", "wrong", "properly",
  "anymore", "thing", "stuff", "device", "phone", "laptop", "tablet", "watch", "headphones",
]);
export const MAX_SUMMARY_CHARS = 300;
export const MAX_VERBATIM_CHARS = 1000;

/** At least three non-filler words, at least one of which describes something specific (D14). */
export function validateProblemDescription(raw: unknown): ValidationResult<ProblemDescriptionValue> {
  const probe = "Could you tell me a bit more about what's wrong? For example, what happens when you use it?";
  const verbatimRaw = typeof raw === "string" ? raw : (stringField(raw, "verbatim") ?? stringField(raw, "summary"));
  if (verbatimRaw === undefined) return invalid(probe);
  const verbatim = truncate(cleanText(verbatimRaw), MAX_VERBATIM_CHARS);
  const content = words(verbatim).filter((word) => !FILLERS.has(word));
  if (content.length < 3 || !content.some((word) => !VAGUE.has(word))) return invalid(probe);
  const summaryRaw = typeof raw === "string" ? undefined : stringField(raw, "summary");
  const summary = truncate(summaryRaw && cleanText(summaryRaw) !== "" ? cleanText(summaryRaw) : verbatim, MAX_SUMMARY_CHARS);
  return valid({ summary, verbatim });
}

// ---------------------------------------------------------------------------------------------------------------------
// problemStartedAt

export interface DateOptions {
  /** The session's current date in IST (from the server clock). */
  today: CivilDate;
}

export const MAX_PROBLEM_AGE_YEARS = 10;

/**
 * When the problem started. The user's words are resolved in code (P0-T03). Input: the spoken phrase (string or
 * `{ spoken }`), or a YYYY-MM-DD from the chat date card (or `{ date }` with no phrase). When a phrase is given, the
 * model's own `date` is ignored: if the phrase can't be resolved, the agent asks again rather than trusting it.
 */
export function validateProblemStartedAt(raw: unknown, { today }: DateOptions): ValidationResult<ProblemStartedAtValue> {
  const spoken = typeof raw === "string" ? raw : stringField(raw, "spoken");
  const modelDate = stringField(raw, "date");
  let resolved: { date: string; precision: ProblemStartedAtValue["precision"] } | null;
  let phrase: string | null = null;

  if (spoken !== undefined && cleanText(spoken) !== "") {
    phrase = cleanText(spoken);
    if (/^\d{4}-\d{2}-\d{2}$/.test(phrase) && !isCivilDate(phrase)) return invalid("Please choose a valid date.");
    if (isCivilDate(phrase)) {
      resolved = { date: phrase, precision: "day" };
      phrase = typeof raw === "string" ? null : phrase;
    } else {
      if (isUnknownDatePhrase(phrase)) return invalid("No problem. Roughly when did it start: a few days ago, last week, or a month ago?");
      resolved = resolveSpokenDate(phrase, today);
      if (!resolved) return invalid("Roughly which date was that? For example, last Tuesday, or the 3rd of November.");
    }
  } else if (modelDate !== undefined && isCivilDate(cleanText(modelDate))) {
    resolved = { date: cleanText(modelDate), precision: "day" };
  } else {
    return invalid("Please choose a valid date.");
  }

  if (resolved.date > today) return invalid("That date is in the future. When did the problem start?");
  if (resolved.date < addMonths(today, -12 * MAX_PROBLEM_AGE_YEARS)) {
    return invalid(`That's more than ${MAX_PROBLEM_AGE_YEARS} years ago. When did the problem start?`);
  }
  return valid({ date: resolved.date, precision: resolved.precision, spoken: phrase });
}

// ---------------------------------------------------------------------------------------------------------------------
// urgency

/**
 * Checked in this order: the "low" phrases (which are themselves negations, "not urgent") first, then the strongest
 * level that matches. Bare level words ("low", "high") aren't phrases: "the battery is low" says nothing about urgency.
 */
const URGENCY_PHRASES: readonly [UrgencyLevel, readonly string[]][] = [
  ["low", ["no rush", "no hurry", "not urgent", "not really urgent", "not in a hurry", "whenever", "take your time", "no pressure", "not important", "not a priority", "can wait", "low priority"]],
  ["critical", ["critical", "emergency", "immediately", "right now", "right away", "medical", "cant manage without", "cant live without", "cant work at all"]],
  ["high", ["urgent", "urgently", "asap", "as soon as possible", "quickly", "soon", "tomorrow", "today", "for work", "important", "high priority", "fast"]],
  ["normal", ["normal", "few days", "this week", "next week", "within a week", "regular", "standard", "medium", "moderate", "no particular"]],
];
/** A level phrase within three words after one of these is negated ("not an emergency", "don't need it right away"). */
const NEGATIONS = new Set(["not", "dont", "doesnt", "isnt", "wont", "never"]);
const NEGATION_WINDOW = 3;
const isAffirmed = (tokens: readonly string[], phrase: string) =>
  phraseStarts(tokens, phrase).some((start) => !tokens.slice(Math.max(0, start - NEGATION_WINDOW), start).some((word) => NEGATIONS.has(word)));
export const MAX_URGENCY_REASON_CHARS = 200;

export function validateUrgency(raw: unknown): ValidationResult<UrgencyValue> {
  const ask = "How soon do you need it back: no rush, within a few days, urgently, or immediately?";
  const levelText = typeof raw === "string" ? raw : stringField(raw, "level");
  const reasonText = typeof raw === "string" ? undefined : stringField(raw, "reason");
  const reason = (text: string | undefined) => {
    const cleaned = text === undefined ? "" : truncate(cleanText(text), MAX_URGENCY_REASON_CHARS);
    return cleaned === "" || (URGENCY_LEVELS as readonly string[]).includes(cleaned.toLowerCase()) ? null : cleaned;
  };

  const exact = levelText === undefined ? "" : cleanText(levelText).toLowerCase();
  if ((URGENCY_LEVELS as readonly string[]).includes(exact)) return valid({ level: exact as UrgencyLevel, reason: reason(reasonText) });

  const said = [levelText, reasonText].filter((text): text is string => text !== undefined).join(" ");
  const tokens = words(said);
  for (const [level, phrases] of URGENCY_PHRASES) {
    const matches = level === "low" ? (phrase: string) => hasPhrase(tokens, phrase) : (phrase: string) => isAffirmed(tokens, phrase);
    if (phrases.some(matches)) return valid({ level, reason: reason(reasonText ?? levelText) });
  }
  // Nothing matched, or only negated phrases ("it's not an emergency"): ask rather than guess.
  return invalid(ask);
}
