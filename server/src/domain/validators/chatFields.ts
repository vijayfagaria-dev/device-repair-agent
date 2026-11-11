// Validators for the fields collected in chat (D14, P2-T03). Every rejection says exactly what is wrong, in one
// short sentence the chat card shows under the input.
import { domainToASCII } from "node:url";
import type { SerialNumberValue, ServiceCentreValue } from "@device-repair/shared/fields";
import { MAX_NOTES_CHARS } from "../fields.js";
import { findServiceCentre, SERVICE_CENTRES } from "../serviceCentres.js";
import { invalid, skipped, valid, type ValidationResult } from "./result.js";
import { charLength, cleanText, words } from "./strings.js";

/** protocol.md §7: inputResponse strings are capped per field before validation. */
export const MAX_SERIAL_INPUT_CHARS = 64;
export const MAX_EMAIL_CHARS = 254;

/** Luhn check digit validation (ISO/IEC 7812), used by IMEIs. */
export function passesLuhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let digit = digits.charCodeAt(digits.length - 1 - i) - 48;
    if (i % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
}

const isOneRepeatedChar = (value: string) => /^(.)\1*$/.test(value);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * IMEI or serial number. Normalized: NFKC (full-width digits → ASCII), spaces and hyphens removed, uppercase.
 * All digits → an IMEI (exactly 15 digits, passes Luhn). Otherwise a serial: 8–20 letters and digits, with at least
 * one letter, and not one character repeated.
 */
export function validateSerialNumber(raw: unknown): ValidationResult<SerialNumberValue> {
  if (typeof raw !== "string" || cleanText(raw) === "") return invalid("Please type the serial number or IMEI.");
  if (charLength(raw) > MAX_SERIAL_INPUT_CHARS) return invalid("That's too long for a serial number or IMEI.");
  const value = cleanText(raw, { form: "NFKC" }).replace(/[\s-]/g, "").toUpperCase();
  if (/^\d+$/.test(value)) {
    if (value.length !== 15) return invalid(`That IMEI has ${plural(value.length, "digit")}; IMEIs have 15.`);
    if (isOneRepeatedChar(value)) return invalid("That doesn't look like a real IMEI. Please check it.");
    if (!passesLuhn(value)) return invalid("That IMEI's last digit doesn't match the others. Please check each digit.");
    return valid({ kind: "imei", value });
  }
  if (!/^[A-Z0-9]+$/.test(value)) return invalid("Serial numbers use only letters and digits.");
  if (value.length < 8 || value.length > 20) {
    return invalid(`That serial number has ${plural(value.length, "character")}; serial numbers have 8 to 20.`);
  }
  if (isOneRepeatedChar(value)) return invalid("That doesn't look like a real serial number. Please check it.");
  return valid({ kind: "serial", value });
}

/** Characters RFC 5322 allows unquoted in a local part (plus any non-ASCII letter, for internationalized mail). */
const LOCAL_PART = /^[\p{L}\p{N}!#$%&'*+/=?^_`{|}~.-]+$/u;
const DOMAIN_LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
const TLD = /^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;

/**
 * Permissive structural email check (D14): one @, a plausible local part, a domain with a TLD. Normalized: trimmed,
 * the domain lowercased and converted to its ASCII (punycode) form; the local part is kept as typed. `+tags` are fine.
 */
export function validateEmail(raw: unknown): ValidationResult<string> {
  if (typeof raw !== "string" || cleanText(raw) === "") return invalid("Please type your email address.");
  const text = cleanText(raw, { form: "NFC" });
  if (/\s/.test(text)) return invalid("Email addresses can't contain spaces.");
  if (charLength(text) > MAX_EMAIL_CHARS) return invalid("That email address is too long.");
  const at = text.split("@");
  if (at.length === 1) return invalid("That email address is missing the @.");
  if (at.length > 2) return invalid("That email address has more than one @.");
  const [local = "", domain = ""] = at;
  if (local === "") return invalid("Something is missing before the @.");
  if (charLength(local) > 64) return invalid("The part before the @ is too long.");
  if (!LOCAL_PART.test(local) || local.startsWith(".") || local.endsWith(".") || local.includes("..")) {
    return invalid("The part before the @ has characters an email address can't use.");
  }
  const asciiDomain = domain.includes("..") ? "" : domainToASCII(domain.toLowerCase());
  const labels = asciiDomain.split(".");
  if (asciiDomain === "" || labels.length < 2 || !labels.every((label) => DOMAIN_LABEL.test(label)) || !TLD.test(labels.at(-1) ?? "")) {
    return invalid("The part after the @ needs a domain like example.com.");
  }
  // Re-checked after the punycode conversion: "ä.ä.ä…" grows about fourfold ("xn--4ca.…"), and the stored address
  // must still fit the limit (the record schema caps it at 254).
  const address = `${local}@${asciiDomain}`;
  if (asciiDomain.length > 253 || charLength(address) > MAX_EMAIL_CHARS) return invalid("That email address is too long.");
  return valid(address);
}

/**
 * A service centre from the server's list (never the client's). From the chat card the value is a centre id; when
 * `spoken`, it may also be a place name heard on the call ("the Koramangala one").
 */
export function validateServiceCentre(raw: unknown, { spoken = false } = {}): ValidationResult<ServiceCentreValue> {
  const pick = "Please choose a service centre from the list.";
  if (typeof raw !== "string" || cleanText(raw) === "") return invalid(pick);
  const byId = findServiceCentre(cleanText(raw));
  if (byId) return valid(byId);
  if (!spoken) return invalid(pick);

  const heard = words(raw);
  const matches = SERVICE_CENTRES.filter((centre) => {
    const place = words(centre.name.replace(/ Demo Repair Centre$/, ""));
    return place.every((word) => heard.includes(word));
  });
  if (matches.length === 1 && matches[0]) return valid({ ...matches[0] });
  const inCity = SERVICE_CENTRES.filter((centre) => heard.includes(centre.city.toLowerCase()));
  if (inCity.length > 1) {
    const places = inCity.map((centre) => centre.name.replace(/ Demo Repair Centre$/, ""));
    return invalid(`There are ${inCity.length} centres in ${inCity[0]?.city}: ${places.join(" or ")}. Which one?`);
  }
  return invalid("I couldn't match that to one of our centres. I'll send you the list in the chat.");
}

/** Optional free text for the technician. Null or empty means skipped. */
export function validateAdditionalNotes(raw: unknown): ValidationResult<string> {
  if (raw === null || raw === undefined) return skipped();
  if (typeof raw !== "string") return invalid("Please type your notes as text.");
  const text = cleanText(raw, { form: "NFC", multiline: true });
  if (text === "") return skipped();
  if (charLength(text) > MAX_NOTES_CHARS) {
    return invalid(`Notes can be up to ${MAX_NOTES_CHARS.toLocaleString("en-US")} characters; this is ${charLength(text).toLocaleString("en-US")}.`);
  }
  return valid(text);
}

/** The "Submit claim?" card: Yes or No. What No leads to (the edit card) is the controller's business. */
export function validateSubmitConfirmation(raw: unknown): ValidationResult<boolean> {
  return typeof raw === "boolean" ? valid(raw) : invalid("Please tap Yes or No.");
}
