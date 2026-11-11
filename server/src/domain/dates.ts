// Calendar dates in the claim's timezone (D14: Asia/Kolkata, UTC+05:30 all year, no daylight saving). "Today" always
// comes from the server clock, never from the model.

const IST_OFFSET_MS = 330 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A civil date "YYYY-MM-DD" in IST. */
export type CivilDate = string;

/** Today's date in IST at the instant `now`. */
export function istToday(now: Date): CivilDate {
  return new Date(now.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** "2026-11-07T10:02:11+05:30": the record's timestamp format (whole seconds, IST offset). */
export function toIstIso(instant: Date): string {
  if (Number.isNaN(instant.getTime())) throw new RangeError("invalid date");
  return `${new Date(instant.getTime() + IST_OFFSET_MS).toISOString().slice(0, 19)}+05:30`;
}

/** True only for a real calendar date in YYYY-MM-DD form (rejects 2026-02-30). */
export function isCivilDate(value: string): boolean {
  const match = ISO_DATE.exec(value);
  if (!match) return false;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.toISOString().slice(0, 10) === value && Number(match[1]) >= 1900;
}

/** Calendar arithmetic is done on UTC midnights, where every day is exactly 24 hours long. */
const toUtc = (date: CivilDate): Date => new Date(`${date}T00:00:00Z`);
const fromUtc = (date: Date): CivilDate => date.toISOString().slice(0, 10);

export function addDays(date: CivilDate, days: number): CivilDate {
  return fromUtc(new Date(toUtc(date).getTime() + days * DAY_MS));
}

/** Same day of the month `months` later (negative = earlier), clamped to the month's last day (Mar 31 − 1 → Feb 28). */
export function addMonths(date: CivilDate, months: number): CivilDate {
  const d = toUtc(date);
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d.getUTCDate(), lastDay));
  return fromUtc(target);
}

/** 0 = Sunday … 6 = Saturday. */
export const weekday = (date: CivilDate): number => toUtc(date).getUTCDay();

/** The Monday of the date's week (weeks start on Monday). */
export const startOfWeek = (date: CivilDate): CivilDate => addDays(date, -((weekday(date) + 6) % 7));

export const startOfMonth = (date: CivilDate): CivilDate => `${date.slice(0, 7)}-01`;

/** Builds a civil date from parts, or null if it doesn't exist. */
export function civilDate(year: number, month: number, day: number): CivilDate | null {
  const text = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return isCivilDate(text) ? text : null;
}
