// String hygiene shared by every validator and the record builder (D14 "common to all strings"; architecture §7
// step 1): Unicode normalization, control and invisible formatting characters removed, whitespace collapsed.

/**
 * C0/C1 controls except tab and newline, zero-width and bidirectional formatting characters (spoofing), and the
 * invisible Unicode tag characters (U+E0000 to U+E007F) and supplementary variation selectors (U+E0100 to U+E01EF).
 * Those last two can carry hidden text that a person never sees but a language model reads (prompt-injection
 * smuggling). The variation selectors are a separate alternative so each one is matched (and removed) on its own.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point: they are stripped.
const UNSAFE_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u061C\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF\u{E0000}-\u{E007F}]|[\u{E0100}-\u{E01EF}]/gu;

export interface CleanOptions {
  /** NFKC for identifiers (full-width digits become ASCII); NFC elsewhere (keeps the user's characters). */
  form?: "NFC" | "NFKC";
  /** Keep line breaks (collapsing other whitespace); for free text such as notes. */
  multiline?: boolean;
}

/** Normalizes, strips unsafe characters, collapses whitespace and trims. Never throws. */
export function cleanText(raw: string, { form = "NFC", multiline = false }: CleanOptions = {}): string {
  const text = raw.normalize(form).replace(UNSAFE_CHARS, "");
  if (!multiline) return text.replace(/\s+/g, " ").trim();
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Length in user-perceived characters (code points), so emoji and Indic text aren't over-counted. */
export const charLength = (text: string): number => [...text].length;

/** Cuts to at most `max` code points, at a word boundary when one is reasonably close. */
export function truncate(text: string, max: number): string {
  const chars = [...text];
  if (chars.length <= max) return text;
  const cut = chars.slice(0, max).join("");
  if (/\s/.test(chars[max] ?? "")) return cut.trimEnd(); // already ends on a word boundary
  const space = cut.lastIndexOf(" ");
  return (space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd();
}

/** Lowercase words of a cleaned phrase (letters and digits), for matching against synonym lists. */
export function words(text: string): string[] {
  return cleanText(text, { form: "NFKC" })
    .toLowerCase()
    .replace(/[’']/g, "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/** Where `phrase` occurs as whole words in `tokens` (the index of its first word), in order. */
export function phraseStarts(tokens: readonly string[], phrase: string): number[] {
  const target = phrase.split(" ");
  const starts: number[] = [];
  for (let i = 0; i + target.length <= tokens.length; i++) {
    if (target.every((word, j) => tokens[i + j] === word)) starts.push(i);
  }
  return starts;
}

/** True when the phrase contains `phrase` as whole words ("not urgent" in "it's not urgent at all"). */
export const hasPhrase = (tokens: readonly string[], phrase: string): boolean => phraseStarts(tokens, phrase).length > 0;
