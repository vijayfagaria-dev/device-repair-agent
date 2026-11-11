// The eval fixtures (P9-T03): a conversation and the state message the model is shown, and what it must do.
// `reference` is one answer that satisfies the expectation: it is only used to prove a fixture can be passed (dry run),
// never as a measurement of the model.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { Expectation } from "./match.js";

const Turn = z.object({ role: z.enum(["user", "assistant"]), text: z.string().min(1) }).strict();

export const Fixture = z
  .object({
    id: z.string().regex(/^[a-z0-9-]+$/),
    description: z.string().min(10),
    transcript: z.array(Turn).min(1),
    /** The state message's JSON, as agent/stateMessage.ts builds it. */
    state: z.record(z.string(), z.unknown()),
    expect: Expectation,
    reference: z.object({ calls: z.array(z.object({ name: z.string(), args: z.record(z.string(), z.unknown()) })), speech: z.string() }).strict(),
  })
  .strict();
export type Fixture = z.infer<typeof Fixture>;

const DIR = fileURLToPath(new URL("../../eval/fixtures/", import.meta.url));

export type FixtureSet = "main" | "heldout";

export function loadFixtures(set: FixtureSet, dir = DIR): Fixture[] {
  const raw = JSON.parse(readFileSync(`${dir}${set}.json`, "utf8")) as unknown;
  return z.array(Fixture).parse(raw);
}
