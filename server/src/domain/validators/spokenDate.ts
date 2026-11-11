// Resolves spoken dates ("last Tuesday", "two weeks ago", "3rd November") against the session's IST date (P2-T02).
// P0-T03 measured the model getting "last Tuesday" wrong in 3 of 3 passes, so relative dates are resolved here, in
// code, from the user's words; the model's own date arithmetic is never trusted.
import type { DatePrecision } from "@device-repair/shared/fields";
import {
  addDays,
  addMonths,
  type CivilDate,
  civilDate,
  isCivilDate,
  startOfMonth,
  startOfWeek,
  weekday,
} from "../dates.js";
import { cleanText } from "./strings.js";

export interface ResolvedDate {
  date: CivilDate;
  precision: DatePrecision;
}

const NUMBER_WORDS: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  couple: 2,
  three: 3,
  few: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
};
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const MONTH_PATTERN = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
// Full names only: abbreviations collide with ordinary words ("I sat on it", "mar the screen").
const WEEKDAY_PATTERN = `(${WEEKDAYS.join("|")})`;
const FULL_MONTH_PATTERN = `(${MONTHS.join("|")})`;

/** Phrases meaning the user doesn't know, so the agent asks for a rough answer instead of a date. */
const UNKNOWN = /\b(?:dont know|do not know|not sure|no idea|cant remember|can not remember|cannot remember|dont remember|no clue|unsure)\b/;

const monthIndex = (name: string): number => MONTHS.findIndex((month) => month.startsWith(name.slice(0, 3)));
const weekdayIndex = (name: string): number => WEEKDAYS.findIndex((day) => day.startsWith(name.slice(0, 3)));

function parseCount(token: string): number | null {
  if (/^\d{1,3}$/.test(token)) return Number(token);
  return NUMBER_WORDS[token] ?? null;
}

/** The most recent `day` strictly before `today` (1–7 days back), as the P0-T03 test defined "last Tuesday". */
function previousWeekday(today: CivilDate, day: number): CivilDate {
  return addDays(today, -((weekday(today) - day + 7) % 7 || 7));
}

/**
 * A month/day with no year means its most recent occurrence: this year, or last year if that's still ahead.
 * "… last year" means last year's, always.
 */
function latestPast(today: CivilDate, month: number, day: number, lastYear: boolean): CivilDate | null {
  const year = Number(today.slice(0, 4));
  if (lastYear) return civilDate(year - 1, month, day);
  const thisYear = civilDate(year, month, day);
  if (thisYear && thisYear <= today) return thisYear;
  return civilDate(year - 1, month, day);
}

export function isUnknownDatePhrase(phrase: string): boolean {
  return UNKNOWN.test(normalizePhrase(phrase));
}

function normalizePhrase(phrase: string): string {
  return cleanText(phrase, { form: "NFKC" })
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[,.!?]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Returns the date the phrase means (relative to `today`, in IST), or null when it can't be resolved. */
export function resolveSpokenDate(phrase: string, today: CivilDate): ResolvedDate | null {
  const text = normalizePhrase(phrase);
  if (text === "") return null;
  let match: RegExpExecArray | null;

  // Future phrases resolve too, so the caller can say "that's in the future" instead of "which date?".
  if (/\bday after tomorrow\b/.test(text)) return { date: addDays(today, 2), precision: "day" };
  if (/\btomorrow\b/.test(text)) return { date: addDays(today, 1), precision: "day" };
  if (/\bnext week\b/.test(text)) return { date: addDays(startOfWeek(today), 7), precision: "week" };
  if (/\bnext month\b/.test(text)) return { date: startOfMonth(addMonths(startOfMonth(today), 1)), precision: "month" };
  if (/\bday before yesterday\b/.test(text)) return { date: addDays(today, -2), precision: "day" };
  if (/\b(?:yesterday|last night)\b/.test(text)) return { date: addDays(today, -1), precision: "day" };
  if (/\b(?:today|this morning|this afternoon|this evening|tonight|just now|an hour ago|few hours ago)\b/.test(text)) {
    return { date: today, precision: "day" };
  }

  // "3 days ago", "a couple of weeks back", "about a month ago", "a fortnight ago"
  if (/\b(?:a )?fortnight (?:ago|back)\b/.test(text)) return { date: addDays(today, -14), precision: "week" };
  match = /\b(\d{1,3}|an?|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|couple|few)(?: of)? (day|week|month|year)s? (?:ago|back|before)\b/.exec(text);
  if (match) {
    const count = parseCount(match[1] ?? "");
    if (count === null) return null;
    switch (match[2]) {
      case "day":
        return { date: addDays(today, -count), precision: "day" };
      case "week":
        return { date: addDays(today, -7 * count), precision: "week" };
      case "month":
        return { date: addMonths(today, -count), precision: "month" };
      default:
        return { date: addMonths(today, -12 * count), precision: "month" };
    }
  }

  if (/\blast week\b/.test(text)) return { date: addDays(startOfWeek(today), -7), precision: "week" };
  if (/\bthis week\b/.test(text)) return { date: startOfWeek(today), precision: "week" };
  if (/\blast month\b/.test(text)) return { date: startOfMonth(addMonths(startOfMonth(today), -1)), precision: "month" };
  if (/\bthis month\b/.test(text)) return { date: startOfMonth(today), precision: "month" };

  // ISO date (the chat date card, or a model that passed one as the phrase)
  match = /\b(\d{4})-(\d{2})-(\d{2})\b/.exec(text);
  if (match) {
    const date = `${match[1]}-${match[2]}-${match[3]}`;
    return isCivilDate(date) ? { date, precision: "day" } : null;
  }

  // "3rd November", "3 nov 2025", "November 3rd", "nov 3 2025", "3rd November last year"
  const lastYear = /\blast year\b/.test(text);
  match = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?(?: of)? ${MONTH_PATTERN}\\b(?: (\\d{4}))?`).exec(text);
  const dayMonth = match ? { day: Number(match[1]), month: monthIndex(match[2] ?? "") + 1, year: match[3] } : null;
  match = new RegExp(`\\b${MONTH_PATTERN} (\\d{1,2})(?:st|nd|rd|th)?\\b(?: (\\d{4}))?`).exec(text);
  const monthDay = match ? { day: Number(match[2]), month: monthIndex(match[1] ?? "") + 1, year: match[3] } : null;
  const dated = dayMonth ?? monthDay;
  if (dated) {
    const date = dated.year ? civilDate(Number(dated.year), dated.month, dated.day) : latestPast(today, dated.month, dated.day, lastYear);
    return date ? { date, precision: "day" } : null;
  }

  // "last Tuesday", "on Monday", "this past Friday", "Wednesday", "the Tuesday before last", "next Friday"
  match = new RegExp(`\\b${WEEKDAY_PATTERN}\\b`).exec(text);
  if (match) {
    const day = weekdayIndex(match[1] ?? "");
    if (day < 0) return null;
    // The coming one: resolved (not re-asked), so the caller can say "that's in the future".
    if (new RegExp(`\\bnext ${WEEKDAY_PATTERN}\\b`).test(text)) return { date: addDays(today, (day - weekday(today) + 7) % 7 || 7), precision: "day" };
    if (new RegExp(`\\b${WEEKDAY_PATTERN} before last\\b`).test(text)) return { date: addDays(previousWeekday(today, day), -7), precision: "day" };
    if (new RegExp(`\\bthis ${WEEKDAY_PATTERN}\\b`).test(text) && !/\bthis past\b/.test(text) && weekday(today) === day) {
      return { date: today, precision: "day" };
    }
    return { date: previousWeekday(today, day), precision: "day" };
  }

  // "in October", "October 2025", "early March". "May" alone is usually the verb, so it needs a preposition.
  const months = new RegExp(`(?:\\b(in|since|during|early|mid|late|around|of) )?\\b${FULL_MONTH_PATTERN}\\b(?: (\\d{4}))?`, "g");
  for (const found of text.matchAll(months)) {
    if (found[2] === "may" && found[1] === undefined && found[3] === undefined) continue;
    const month = monthIndex(found[2] ?? "") + 1;
    const year = found[3] ? Number(found[3]) : Number(today.slice(0, 4)) - (lastYear || month > Number(today.slice(5, 7)) ? 1 : 0);
    const date = civilDate(year, month, 1);
    return date ? { date, precision: "month" } : null;
  }

  return null;
}
