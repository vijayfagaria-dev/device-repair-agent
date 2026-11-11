// Splits streamed agent text into speakable chunks (P5-T11): at sentence ends (. ? !) followed by a space, except
// after common abbreviations and inside numbers (3.5, 1.2 s), or at a comma once a chunk is long (120 chars), so TTS
// starts early without breaking mid-sentence.
const ABBREVIATIONS = new Set(["mr", "mrs", "ms", "dr", "st", "sr", "jr", "vs", "etc", "e.g", "i.e", "approx", "no", "nos", "mt", "ft"]);
export const LONG_CHUNK_CHARS = 120;

export class SentenceChunker {
  #buffer = "";

  /** Adds streamed text; returns the chunks it completed. */
  push(delta: string): string[] {
    this.#buffer += delta;
    const chunks: string[] = [];
    for (;;) {
      const cut = this.#findCut();
      if (cut < 0) break;
      const chunk = this.#buffer.slice(0, cut).trim();
      this.#buffer = this.#buffer.slice(cut).replace(/^\s+/, "");
      if (chunk) chunks.push(chunk);
    }
    return chunks;
  }

  /** The rest, at the end of the turn. */
  flush(): string[] {
    const rest = this.#buffer.trim();
    this.#buffer = "";
    return rest ? [rest] : [];
  }

  #findCut(): number {
    const text = this.#buffer;
    for (let i = 0; i < text.length - 1; i++) {
      const ch = text[i];
      if ((ch === "." || ch === "?" || ch === "!") && /\s/.test(text[i + 1] ?? "")) {
        if (ch === "." && this.#isAbbreviation(text, i)) continue;
        return i + 1;
      }
    }
    if (text.length >= LONG_CHUNK_CHARS) {
      const comma = text.lastIndexOf(", ", LONG_CHUNK_CHARS);
      if (comma > 20) return comma + 1;
    }
    return -1;
  }

  #isAbbreviation(text: string, dot: number): boolean {
    const before = /([A-Za-z.]+)$/.exec(text.slice(0, dot))?.[1]?.toLowerCase() ?? "";
    if (ABBREVIATIONS.has(before)) return true;
    // A single capital letter ("A. Rao") is an initial.
    return /^[a-z]$/.test(before) && /[A-Z]/.test(text[dot - 1] ?? "");
  }
}
