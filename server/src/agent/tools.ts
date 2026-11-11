// The call agent's tools (P5-T05, D13): JSON-schema definitions (OpenAI-compatible, deterministic order, sent with
// the frozen system prompt) and strict zod validators. Arguments are validated server-side before anything runs
// (provider-side `strict` mode isn't relied on); an invalid call gets an error result, never an effect.
import { CHAT_FIELDS, OPTIONAL_FIELDS, RECORD_FIELD_IDS } from "@device-repair/shared/fields";
import { z } from "zod";
import { FIELDS } from "../domain/fields.js";
import type { ToolDefinition } from "../voice/types.js";

/** Fields the agent may save from speech (catalog `spokenCapture`): the call fields plus identifiers heard aloud. */
export const SPOKEN_FIELDS = RECORD_FIELD_IDS.filter((id) => FIELDS[id].spokenCapture);
/** Cards the agent may send: the chat fields, the optional ones and the submit confirmation. */
export const CARD_FIELDS = [...CHAT_FIELDS, ...OPTIONAL_FIELDS, "submitConfirmation"] as const;

export const ToolArgs = {
  save_field: z.strictObject({
    field: z.enum(SPOKEN_FIELDS as [string, ...string[]]),
    value: z.string().min(1).max(1000),
    spoken_evidence: z.string().max(1000),
    user_confirmed: z.boolean().optional(),
  }),
  request_chat_input: z.strictObject({ field: z.enum(CARD_FIELDS) }),
  flag_for_review: z.strictObject({ kind: z.enum(["safety", "other"]), reason: z.string().min(1).max(300) }),
  opt_out: z.strictObject({ confirmed: z.boolean() }),
  end_call: z.strictObject({ reason: z.string().max(200).optional() }),
} as const;

export type ToolName = keyof typeof ToolArgs;
export type ToolCallArgs<N extends ToolName> = z.infer<(typeof ToolArgs)[N]>;
export const isToolName = (name: string): name is ToolName => Object.hasOwn(ToolArgs, name);

export const TOOLS: readonly ToolDefinition[] = Object.freeze([
  {
    name: "save_field",
    description:
      "Save a value the customer said on the call. Call it once per field you learned this turn. For serialNumber and email it only notes what you heard: they must still type it in the chat card.",
    parameters: {
      type: "object",
      properties: {
        field: { type: "string", enum: SPOKEN_FIELDS },
        value: { type: "string", description: "Your normalized value, e.g. 'Apple iPhone 14 Pro', 'high'. For dates pass the customer's words, e.g. 'last Tuesday'." },
        spoken_evidence: { type: "string", description: "The customer's exact words." },
        user_confirmed: { type: "boolean", description: "True only if the customer confirmed this value when you read it back." },
      },
      required: ["field", "value", "spoken_evidence"],
      additionalProperties: false,
    },
  },
  {
    name: "request_chat_input",
    description: "Send an input card to the customer's chat. Use it for fields that are awkward to say, and for submitConfirmation when everything required is collected.",
    parameters: {
      type: "object",
      properties: { field: { type: "string", enum: [...CARD_FIELDS] } },
      required: ["field"],
      additionalProperties: false,
    },
  },
  {
    name: "flag_for_review",
    description: "Flag the claim for a human: kind 'safety' for a swollen battery, smoke, burning, sparks or liquid while charging; 'other' for anything you shouldn't decide.",
    parameters: {
      type: "object",
      properties: { kind: { type: "string", enum: ["safety", "other"] }, reason: { type: "string" } },
      required: ["kind", "reason"],
      additionalProperties: false,
    },
  },
  {
    name: "opt_out",
    description: "The customer wants to stop the claim. Ask them to confirm first; call with confirmed true only after they said yes.",
    parameters: {
      type: "object",
      properties: { confirmed: { type: "boolean" } },
      required: ["confirmed"],
      additionalProperties: false,
    },
  },
  {
    name: "end_call",
    description: "End the call, after you have said goodbye.",
    parameters: { type: "object", properties: { reason: { type: "string" } }, additionalProperties: false },
  },
]);

export type ParsedToolCall = { [N in ToolName]: { name: N; args: ToolCallArgs<N> } }[ToolName];

/** Validates one call's name and JSON arguments; the error is what the model is told. */
export function parseToolCall(name: string, rawArguments: string): { ok: true; call: ParsedToolCall } | { ok: false; error: string } {
  if (!isToolName(name)) return { ok: false, error: `unknown tool "${name.slice(0, 40)}"` };
  let json: unknown;
  try {
    json = JSON.parse(rawArguments || "{}");
  } catch {
    return { ok: false, error: "arguments are not valid JSON" };
  }
  const parsed = ToolArgs[name].safeParse(json);
  if (!parsed.success) return { ok: false, error: `invalid arguments: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"} ${i.message}`).join("; ")}` };
  return { ok: true, call: { name, args: parsed.data } as ParsedToolCall };
}
