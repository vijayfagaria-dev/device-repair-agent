// The judge for the LLM behaviour eval (P9-T03): pure, so it is unit-tested without a model. A fixture says which tool
// calls the model must make (a partial match on name and arguments), which it must never make, and what its speech must
// and must not contain. It judges the model's first response to the conversation, the one that starts the agent's turn.
import { z } from "zod";

/** An argument matcher: a literal (strings compare case-insensitively, trimmed), or `{ matches: "<regex>" }`. */
export const ArgMatcher = z.union([z.string(), z.number(), z.boolean(), z.object({ matches: z.string() }).strict()]);
export type ArgMatcher = z.infer<typeof ArgMatcher>;

const ToolExpectation = z.object({ name: z.string(), args: z.record(z.string(), ArgMatcher).default({}) }).strict();
export type ToolExpectation = z.infer<typeof ToolExpectation>;

export const Expectation = z
  .object({
    /** Each must be matched by some call the model made (order and extra calls don't matter). */
    calls: z.array(ToolExpectation).default([]),
    /** None may be matched by any call: the name, and the args if any are given. */
    forbidden: z.array(ToolExpectation).default([]),
    speech: z.object({ matches: z.array(z.string()).default([]), notMatches: z.array(z.string()).default([]) }).strict().default({ matches: [], notMatches: [] }),
  })
  .strict();
export type Expectation = z.infer<typeof Expectation>;

export interface ActualCall {
  name: string;
  args: Record<string, unknown>;
}

function argMatches(actual: unknown, matcher: ArgMatcher): boolean {
  if (typeof matcher === "object") return typeof actual === "string" && new RegExp(matcher.matches, "i").test(actual);
  if (typeof matcher === "string") return typeof actual === "string" && actual.trim().toLowerCase() === matcher.trim().toLowerCase();
  return actual === matcher;
}

export function callMatches(call: ActualCall, expected: ToolExpectation): boolean {
  return call.name === expected.name && Object.entries(expected.args).every(([key, matcher]) => argMatches(call.args[key], matcher));
}

export interface Verdict {
  pass: boolean;
  failures: string[];
}

const describeCall = (c: ToolExpectation) => `${c.name}(${Object.entries(c.args).map(([k, v]) => `${k}=${typeof v === "object" ? `/${v.matches}/` : JSON.stringify(v)}`).join(", ")})`;

export function judge(expectation: Expectation, calls: readonly ActualCall[], speech: string): Verdict {
  const failures: string[] = [];
  for (const expected of expectation.calls) {
    if (!calls.some((call) => callMatches(call, expected))) failures.push(`missing call ${describeCall(expected)}`);
  }
  for (const forbidden of expectation.forbidden) {
    const hit = calls.find((call) => callMatches(call, forbidden));
    if (hit) failures.push(`forbidden call made: ${describeCall(forbidden)}`);
  }
  for (const pattern of expectation.speech.matches) {
    if (!new RegExp(pattern, "i").test(speech)) failures.push(`speech should match /${pattern}/`);
  }
  for (const pattern of expectation.speech.notMatches) {
    if (new RegExp(pattern, "i").test(speech)) failures.push(`speech must not match /${pattern}/`);
  }
  return { pass: failures.length === 0, failures };
}
