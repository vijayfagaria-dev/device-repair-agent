// Session ids must be UUIDv4 (protocol.md §2); the server rejects anything else. crypto.randomUUID exists only in
// secure contexts (https, localhost), so plain-http pages build the same UUIDv4 from crypto.getRandomValues.
export const randomId = (): string =>
  typeof crypto.randomUUID === "function" ? crypto.randomUUID() : uuidV4FromRandomValues();

function uuidV4FromRandomValues(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

let lastKey = 0;

export const nextKey = (): string => String(++lastKey);
