import { FieldStatus } from "@device-repair/shared/protocol";

export const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export function formatValue(v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  if (Array.isArray(v)) return v.map(formatValue).join(", ");
  if (typeof v === "object") return JSON.stringify(v);
  if (typeof v === "string" && /^https?:\/\//.test(v)) return v.split("/").pop() || v;
  return String(v);
}

const LABELS: Record<string, string> = {
  deviceType: "Device type",
  deviceModel: "Device model",
  problemDescription: "Problem",
  problemStartedAt: "Started",
  urgency: "Urgency",
  serialNumber: "Serial number",
  purchaseInvoice: "Purchase invoice",
  serviceCentre: "Service centre",
  email: "Email",
  additionalPhotos: "Photos",
  additionalNotes: "Notes",
};

export const fieldLabel = (name: string): string => LABELS[name] ?? name.replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/_/g, " ").toLowerCase();

const capitalize = (text: string): string => (text ? text[0]?.toUpperCase() + text.slice(1) : text);
const text = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "2026-11-10" → "10 Nov 2026" (no timezone maths: the record's date is already a calendar date). */
function day(date: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}` : date;
}

const kb = (bytes: number): string => (bytes >= 1_000_000 ? `${(bytes / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1000))} KB`);

/**
 * A record value as a person would read it. The record carries structured values (a brand and a model, a date with its
 * precision, a file descriptor with a signed link); the card shows words, not JSON and not the link.
 */
export function formatField(name: string, v: unknown): string {
  if (v === null || v === undefined || v === "") return "—";
  if (!isPlainObject(v)) return Array.isArray(v) ? (v.length ? v.map((item) => formatField(name, item)).join(", ") : "—") : name === "deviceType" ? capitalize(String(v)) : formatValue(v);
  switch (name) {
    case "deviceModel":
      return [text(v.brand), text(v.model)].filter(Boolean).join(" ") || formatValue(v);
    case "problemDescription":
      return text(v.summary) || text(v.verbatim) || formatValue(v);
    case "problemStartedAt": {
      const date = text(v.date);
      if (!date) return formatValue(v);
      if (v.precision === "week") return `Week of ${day(date)}`;
      if (v.precision === "month") return `${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
      return day(date);
    }
    case "urgency": {
      const level = capitalize(text(v.level));
      const reason = text(v.reason);
      return reason ? `${level}: ${reason}` : level || formatValue(v);
    }
    case "serialNumber":
      return `${v.kind === "imei" ? "IMEI" : "Serial"} ${text(v.value)}`.trim();
    case "serviceCentre":
      return [text(v.name), text(v.city)].filter(Boolean).join(", ") || formatValue(v);
    case "purchaseInvoice":
    case "additionalPhotos": {
      const mime = text(v.mime);
      const kind = mime ? mime.split("/").pop()?.toUpperCase() : "";
      return [kind, typeof v.size === "number" ? kb(v.size) : ""].filter(Boolean).join(", ") || "File uploaded";
    }
    default:
      return formatValue(v);
  }
}

export function readField(field: unknown): { value: unknown; source: unknown; status: unknown; flagged: boolean } {
  const { value, source, status } = isPlainObject(field) ? field : { value: field, source: null, status: null };
  return { value, source, status, flagged: Boolean(status) && status !== FieldStatus.VALID };
}
