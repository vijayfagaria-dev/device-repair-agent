// Relative-date resolution in code (P2-T02; P0-T03 finding). TODAY is a Tuesday.
import { describe, expect, it } from "vitest";
import { isUnknownDatePhrase, resolveSpokenDate } from "../../src/domain/validators/spokenDate.js";

const TODAY = "2026-11-10"; // Tuesday

describe("resolveSpokenDate", () => {
  it.each([
    ["today", "2026-11-10", "day"],
    ["It started this morning", "2026-11-10", "day"],
    ["yesterday", "2026-11-09", "day"],
    ["last night", "2026-11-09", "day"],
    ["the day before yesterday", "2026-11-08", "day"],
    ["3 days ago", "2026-11-07", "day"],
    ["about ten days back", "2026-10-31", "day"],
    ["a week ago", "2026-11-03", "week"],
    ["a couple of weeks ago", "2026-10-27", "week"],
    ["a fortnight ago", "2026-10-27", "week"],
    ["about a month ago", "2026-10-10", "month"],
    ["three months ago", "2026-08-10", "month"],
    ["two years ago", "2024-11-10", "month"],
    ["last week", "2026-11-02", "week"], // the Monday of the previous week
    ["Last week. Last Tuesday, I dropped it.", "2026-11-03", "day"], // live session 6e75: was the Monday, 2026-11-02
    ["last week on Friday", "2026-11-06", "day"],
    ["earlier this week", "2026-11-09", "week"],
    ["last month", "2026-10-01", "month"],
    ["sometime this month", "2026-11-01", "month"],
    ["last Tuesday", "2026-11-03", "day"], // strictly before today, as P0-T03 defined it
    ["It started last Tuesday.", "2026-11-03", "day"],
    ["this past Tuesday", "2026-11-03", "day"],
    ["this Tuesday", "2026-11-10", "day"],
    ["on Monday", "2026-11-09", "day"],
    ["Sunday", "2026-11-08", "day"],
    ["last Wednesday", "2026-11-04", "day"],
    ["2026-11-01", "2026-11-01", "day"],
    ["3rd November", "2026-11-03", "day"],
    ["the 3rd of Nov", "2026-11-03", "day"],
    ["November 3rd 2025", "2025-11-03", "day"],
    ["25 December", "2025-12-25", "day"], // this year's is still ahead, so last year's
    ["in October", "2026-10-01", "month"],
    ["December", "2025-12-01", "month"],
    ["October 2024", "2024-10-01", "month"],
    ["in May", "2026-05-01", "month"],
    ["it may have been in June", "2026-06-01", "month"],
    ["tomorrow", "2026-11-11", "day"],
    ["next week", "2026-11-16", "week"],
    ["ＹＥＳＴＥＲＤＡＹ", "2026-11-09", "day"], // full-width (NFKC)
    // P2 audit: these used to resolve silently to the wrong date.
    ["3rd November last year", "2025-11-03", "day"], // not this year's
    ["in October last year", "2025-10-01", "month"],
    ["next Tuesday", "2026-11-17", "day"], // the coming one, so the validator says "in the future"
    ["next Friday", "2026-11-13", "day"],
    ["the Tuesday before last", "2026-10-27", "day"], // a week before "last Tuesday"
  ])("%j → %s (%s)", (phrase, date, precision) => {
    expect(resolveSpokenDate(phrase, TODAY)).toEqual({ date, precision });
  });

  it.each([["around Diwali"], ["I sat on it"], ["it may be the battery"], ["31 November"], ["2026-02-30"], [""], ["a while ago"], ["last year"]])(
    "%j can't be resolved, so the agent asks again",
    (phrase) => {
      expect(resolveSpokenDate(phrase, TODAY)).toBeNull();
    },
  );

  it("handles month ends and year boundaries", () => {
    expect(resolveSpokenDate("a month ago", "2026-03-31")).toEqual({ date: "2026-02-28", precision: "month" });
    expect(resolveSpokenDate("yesterday", "2026-01-01")).toEqual({ date: "2025-12-31", precision: "day" });
    expect(resolveSpokenDate("last month", "2026-01-15")).toEqual({ date: "2025-12-01", precision: "month" });
    expect(resolveSpokenDate("last week", "2026-01-01")).toEqual({ date: "2025-12-22", precision: "week" });
  });

  it("recognises don't-know answers", () => {
    for (const phrase of ["I don't know", "not sure", "no idea really", "can't remember"]) expect(isUnknownDatePhrase(phrase), phrase).toBe(true);
    expect(isUnknownDatePhrase("last week")).toBe(false);
  });
});
