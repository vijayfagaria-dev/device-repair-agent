// Grounding for save_field: a value is only saved when the evidence the model quotes was really said by the customer
// in their recent utterances. Real calls showed gpt-oss-20b saving values nobody had said yet (urgency "critical" with
// an invented quote, a problem description before the customer described anything, "...??" as a description).

const normalize = (text: string): string[] =>
  text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(" ")
    .filter(Boolean);

/** Share of the evidence's words that appear, as words, in what the customer said. */
export function groundedShare(evidence: string, utterances: readonly string[]): number {
  const words = normalize(evidence);
  if (words.length === 0) return 0;
  const said = new Set(utterances.flatMap(normalize));
  return words.filter((w) => said.has(w)).length / words.length;
}

/** How many of the customer's most recent utterances count (the one just spoken, and a little context). */
export const RECENT_UTTERANCES = 4;
export const MIN_GROUNDED_SHARE = 0.7;

/** Null when the evidence is grounded; otherwise the error the model is told. */
export function groundingError(evidence: string, utterances: readonly string[]): string | null {
  if (!/[\p{L}\p{N}]/u.test(evidence)) return "spoken_evidence must be the customer's exact words; save only what they actually said";
  if (groundedShare(evidence, utterances.slice(-RECENT_UTTERANCES)) >= MIN_GROUNDED_SHARE) return null;
  return "the customer has not said that. Save a field only from their own recent words, quoted exactly in spoken_evidence; ask them instead";
}
