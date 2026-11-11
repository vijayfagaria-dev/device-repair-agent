// The common validator result (P2-T02/T03): code decides whether a value is acceptable, never the LLM.
// `error` is one short sentence that can be spoken by the agent or shown under a chat card.

export type ValidationResult<T> =
  | { status: "valid"; normalized: T }
  | { status: "invalid"; error: string }
  /** An optional field the user explicitly skipped (the card's Skip sends null). */
  | { status: "skipped" };

export const valid = <T>(normalized: T): ValidationResult<T> => ({ status: "valid", normalized });
export const invalid = <T = never>(error: string): ValidationResult<T> => ({ status: "invalid", error });
export const skipped = <T = never>(): ValidationResult<T> => ({ status: "skipped" });
