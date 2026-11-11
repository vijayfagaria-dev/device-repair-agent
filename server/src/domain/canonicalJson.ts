// Canonical JSON (P2-T07): object keys sorted at every level, no whitespace, arrays kept in order. Two values that are
// equal as data always serialize identically, so their SHA-256 is a stable content hash (D17 revision dedup).

export class CanonicalJsonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalJsonError";
  }
}

/** Serializes plain JSON data canonically. Throws on anything JSON can't represent faithfully. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new CanonicalJsonError("non-finite number");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new CanonicalJsonError("only plain objects are allowed");
    const entries = Object.keys(value)
      .sort()
      .map((key) => {
        const item = (value as Record<string, unknown>)[key];
        if (item === undefined) throw new CanonicalJsonError(`undefined value at "${key}"`);
        return `${JSON.stringify(key)}:${canonicalJson(item)}`;
      });
    return `{${entries.join(",")}}`;
  }
  throw new CanonicalJsonError(`unsupported type: ${typeof value}`);
}
