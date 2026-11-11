// Voice-field validators (P2-T02, D14): ≥ 8 table cases per field.
import { describe, expect, it } from "vitest";
import { istToday } from "../../src/domain/dates.js";
import {
  detectBrand,
  validateDeviceModel,
  validateDeviceType,
  validateProblemDescription,
  validateProblemStartedAt,
  validateUrgency,
} from "../../src/domain/validators/voiceFields.js";

const TODAY = "2026-11-10";

describe("validateDeviceType", () => {
  it.each([
    ["smartphone", "smartphone"],
    ["It's my phone", "smartphone"],
    ["an iPhone", "smartphone"],
    ["my Samsung Galaxy S23", "smartphone"],
    ["Galaxy Watch", "smartwatch"],
    ["galaxy tab", "tablet"],
    ["my iPad", "tablet"],
    ["MacBook Air", "laptop"],
    ["a notebook computer", "laptop"],
    ["AirPods", "headphones"],
    ["wireless earbuds", "headphones"],
    ["Apple Watch", "smartwatch"],
    ["a desktop PC", "other"],
    ["something else", "other"],
    ["  LAPTOP ", "laptop"],
  ])("%j → %s", (input, type) => {
    expect(validateDeviceType(input)).toEqual({ status: "valid", normalized: type });
  });

  it.each([["a thing"], [""], ["   "], ["I don't know"], [null], [3]])("rejects %j with a spoken re-ask", (input) => {
    expect(validateDeviceType(input)).toEqual({ status: "invalid", error: "Sorry, what kind of device is it: a phone, laptop, tablet, smartwatch or headphones?" });
  });

  it("doesn't read 'headphones' as a phone", () => {
    expect(validateDeviceType("my headphones")).toEqual({ status: "valid", normalized: "headphones" });
  });
});

describe("validateDeviceModel", () => {
  it.each([
    ["iPhone 14 Pro", { brand: "Apple", model: "iPhone 14 Pro" }],
    ["Apple iPhone 14 Pro", { brand: "Apple", model: "iPhone 14 Pro" }],
    ["Samsung Galaxy S23", { brand: "Samsung", model: "Galaxy S23" }],
    ["galaxy s23 ultra", { brand: "Samsung", model: "galaxy s23 ultra" }],
    ["Pixel 8", { brand: "Google", model: "Pixel 8" }],
    ["One Plus 12", { brand: "OnePlus", model: "12" }],
    ["Dell XPS 13", { brand: "Dell", model: "XPS 13" }],
    ["ThinkPad X1 Carbon", { brand: "Lenovo", model: "ThinkPad X1 Carbon" }],
    ["Samsung", { brand: "Samsung", model: null }], // brand only still helps
    ["Zorbo X1", { brand: null, model: "Zorbo X1" }], // unknown brand kept as said
  ])("%j → %j", (input, normalized) => {
    expect(validateDeviceModel(input)).toEqual({ status: "valid", normalized });
  });

  it("accepts the tool's structured { brand, model }", () => {
    expect(validateDeviceModel({ brand: "Apple", model: "iPhone 14" })).toEqual({ status: "valid", normalized: { brand: "Apple", model: "iPhone 14" } });
  });

  it("re-asks once on 'don't know', then accepts unknown when the controller allows it (D14)", () => {
    expect(validateDeviceModel("I don't know")).toEqual({
      status: "invalid",
      error: "No problem. Could you check the box, the label, or Settings, About? Even just the brand helps.",
    });
    expect(validateDeviceModel("not sure", { allowUnknown: true })).toEqual({ status: "valid", normalized: { brand: null, model: null } });
  });

  it.each([["Samsung, not sure of the model"], ["It's a Samsung but I don't know which model"], ["just Samsung, no idea about the model"]])(
    "keeps the brand when only the model is unknown: %j (P2 audit: it was re-asked, then stored as brand null)",
    (input) => {
      const expected = { status: "valid", normalized: { brand: "Samsung", model: null } };
      expect(validateDeviceModel(input)).toEqual(expected);
      expect(validateDeviceModel(input, { allowUnknown: true })).toEqual(expected);
    },
  );

  it.each([[""], ["1"], ["12345"], ["x".repeat(81)], [null], [{}]])("rejects %j", (input) => {
    expect(validateDeviceModel(input)).toEqual({ status: "invalid", error: "Which brand and model is it? For example, Samsung Galaxy S23." });
  });

  it("detects brands by whole words only", () => {
    expect(detectBrand("my hp laptop")).toBe("HP");
    expect(detectBrand("a happy phone")).toBeNull();
  });
});

describe("validateProblemDescription", () => {
  it.each([
    ["The screen flickers and goes black after a minute"],
    ["phone not charging"],
    ["battery drains very fast"],
    ["cracked screen after a drop"],
    ["um so like the speaker crackles at high volume"],
    ["it won't turn on at all"],
    ["water got inside and the camera is foggy"],
    ["keyboard keys stopped responding"],
  ])("accepts %j", (input) => {
    expect(validateProblemDescription(input)).toMatchObject({ status: "valid", normalized: { verbatim: input, summary: input } });
  });

  it.each([["it's broken"], ["it is broken"], ["my phone is not working"], ["um uh like you know"], ["problem"], [""], [null], ["screen cracked"]])(
    "asks for more on %j",
    (input) => {
      expect(validateProblemDescription(input)).toEqual({
        status: "invalid",
        error: "Could you tell me a bit more about what's wrong? For example, what happens when you use it?",
      });
    },
  );

  it("keeps the model's summary, capped at 300 characters, and caps the verbatim at 1,000", () => {
    const verbatim = `the screen flickers ${"and then goes dark ".repeat(80)}`;
    const result = validateProblemDescription({ summary: `Screen flickers ${"badly ".repeat(80)}`, verbatim });
    expect(result.status).toBe("valid");
    if (result.status !== "valid") return;
    expect([...result.normalized.summary].length).toBeLessThanOrEqual(300);
    expect(result.normalized.summary.startsWith("Screen flickers")).toBe(true);
    expect([...result.normalized.verbatim].length).toBeLessThanOrEqual(1000);
  });
});

describe("validateProblemStartedAt", () => {
  const today = { today: TODAY };
  it.each([
    ["yesterday", { date: "2026-11-09", precision: "day", spoken: "yesterday" }],
    ["last Tuesday", { date: "2026-11-03", precision: "day", spoken: "last Tuesday" }],
    ["two weeks ago", { date: "2026-10-27", precision: "week", spoken: "two weeks ago" }],
    ["last month", { date: "2026-10-01", precision: "month", spoken: "last month" }],
    ["2026-10-20", { date: "2026-10-20", precision: "day", spoken: null }], // the chat date card
    ["today", { date: "2026-11-10", precision: "day", spoken: "today" }],
    ["9 years ago", { date: "2017-11-10", precision: "month", spoken: "9 years ago" }],
    ["3rd November", { date: "2026-11-03", precision: "day", spoken: "3rd November" }],
  ])("%j → %j", (input, normalized) => {
    expect(validateProblemStartedAt(input, today)).toEqual({ status: "valid", normalized });
  });

  it("resolves the user's words and ignores the model's date arithmetic", () => {
    expect(validateProblemStartedAt({ spoken: "last Tuesday", date: "2026-11-02" }, today)).toEqual({
      status: "valid",
      normalized: { date: "2026-11-03", precision: "day", spoken: "last Tuesday" },
    });
    expect(validateProblemStartedAt({ spoken: "around Diwali", date: "2026-10-20" }, today)).toEqual({
      status: "invalid",
      error: "Roughly which date was that? For example, last Tuesday, or the 3rd of November.",
    });
    expect(validateProblemStartedAt({ date: "2026-11-02" }, today)).toEqual({ status: "valid", normalized: { date: "2026-11-02", precision: "day", spoken: null } });
  });

  it("'yesterday' at 00:30 IST is the IST calendar's yesterday, not UTC's", () => {
    const now = new Date("2026-11-09T19:00:00Z"); // 00:30 on 10 Nov in IST; still 9 Nov in UTC
    expect(istToday(now)).toBe("2026-11-10");
    expect(validateProblemStartedAt("yesterday", { today: istToday(now) })).toMatchObject({ status: "valid", normalized: { date: "2026-11-09" } });
  });

  it.each([
    ["tomorrow", "That date is in the future. When did the problem start?"],
    ["2049-01-01", "That date is in the future. When did the problem start?"],
    ["next week", "That date is in the future. When did the problem start?"],
    ["12 years ago", "That's more than 10 years ago. When did the problem start?"],
    ["2015-01-01", "That's more than 10 years ago. When did the problem start?"],
    ["I don't know", "No problem. Roughly when did it start: a few days ago, last week, or a month ago?"],
    ["around Diwali", "Roughly which date was that? For example, last Tuesday, or the 3rd of November."],
    ["2026-02-30", "Please choose a valid date."],
    ["", "Please choose a valid date."],
    [null, "Please choose a valid date."],
  ])("rejects %j", (input, error) => {
    expect(validateProblemStartedAt(input, today)).toEqual({ status: "invalid", error });
  });
});

describe("validateUrgency", () => {
  it.each([
    ["high", { level: "high", reason: null }],
    ["I need it for work tomorrow", { level: "high", reason: "I need it for work tomorrow" }],
    ["no rush really", { level: "low", reason: "no rush really" }],
    ["it's not urgent", { level: "low", reason: "it's not urgent" }],
    ["within a few days is fine", { level: "normal", reason: "within a few days is fine" }],
    ["it's an emergency, I can't manage without it", { level: "critical", reason: "it's an emergency, I can't manage without it" }],
    ["as soon as possible", { level: "high", reason: "as soon as possible" }],
    ["sometime next week", { level: "normal", reason: "sometime next week" }],
    ["whenever", { level: "low", reason: "whenever" }],
  ])("%j → %j", (input, normalized) => {
    expect(validateUrgency(input)).toEqual({ status: "valid", normalized });
  });

  it("takes the tool's { level, reason }, mapping the reason when the level isn't a known value", () => {
    expect(validateUrgency({ level: "critical", reason: "medical device" })).toEqual({ status: "valid", normalized: { level: "critical", reason: "medical device" } });
    expect(validateUrgency({ level: "very", reason: "need it for work" })).toEqual({ status: "valid", normalized: { level: "high", reason: "need it for work" } });
    expect(validateUrgency({ reason: `${"x".repeat(400)} urgent` }).status).toBe("valid");
  });

  it.each([
    ["the battery is low and I need it urgently", "high"], // "low" alone is not an urgency
    ["it's not critical, but I'd like it this week", "normal"],
    ["no, it's urgent", "high"], // a bare "no" doesn't negate
    ["not immediately, whenever is fine", "low"],
  ])("doesn't read negated or incidental words as a level: %j → %s (P2 audit)", (input, level) => {
    expect(validateUrgency(input)).toMatchObject({ status: "valid", normalized: { level } });
  });

  it.each([["hmm"], [""], [null], [{ level: "purple" }], ["it's not an emergency"], ["it's not critical"], ["I don't need it right away"]])("asks again for %j", (input) => {
    expect(validateUrgency(input)).toEqual({ status: "invalid", error: "How soon do you need it back: no rush, within a few days, urgently, or immediately?" });
  });
});
