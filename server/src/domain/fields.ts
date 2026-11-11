// The field catalog (D14, P2-T01): one definition per field, the single source of truth for the chat planner, the
// agent prompt, validation, conflict resolution and the record. Validators live in ./validators/*.
import {
  ACCEPTED_FILE_TYPES,
  CALL_FIELDS,
  CHAT_FIELDS,
  DEVICE_TYPES,
  FIELD_IDS,
  type FieldDefinition,
  type FieldId,
  type RecordFieldId,
  OPTIONAL_FIELDS,
  URGENCY_LEVELS,
} from "@device-repair/shared/fields";
import { InputKind } from "@device-repair/shared/protocol";
import { SERVICE_CENTRES, serviceCentreLabel } from "./serviceCentres.js";

/** Upload limits (D10). The schema's CHECKs in 001_init.sql mirror the size limit. */
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_ADDITIONAL_PHOTOS = 5;
export const MAX_NOTES_CHARS = 1000;
/** After this many invalid answers to a required field, the controller stops asking (D14) and review rule R-3 applies. */
export const MAX_ATTEMPTS = 3;

const DEVICE_TYPE_LABELS: Record<(typeof DEVICE_TYPES)[number], string> = {
  smartphone: "Phone",
  laptop: "Laptop",
  tablet: "Tablet",
  smartwatch: "Smartwatch",
  headphones: "Headphones or earbuds",
  other: "Something else",
};

const URGENCY_LABELS: Record<(typeof URGENCY_LEVELS)[number], string> = {
  low: "No rush",
  normal: "Within a few days",
  high: "Urgently (in a day or two)",
  critical: "Immediately: I can't manage without it",
};

const IMAGE_TYPES = ACCEPTED_FILE_TYPES.filter((type) => type.startsWith("image/")).join(",");

/** Freezes the whole tree: the catalog (cards, option lists) is shared by every session, so no caller may change it. */
function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}

export const FIELDS: Readonly<Record<FieldId, Readonly<FieldDefinition>>> = deepFreeze({
  deviceType: {
    id: "deviceType",
    label: "device type",
    description: `the kind of device: one of ${DEVICE_TYPES.join(", ")}`,
    primaryChannel: "call",
    required: true,
    authority: "either",
    spokenCapture: true,
    conflictClass: "choice",
    card: {
      kind: InputKind.SELECT,
      label: "What kind of device is it?",
      required: true,
      options: DEVICE_TYPES.map((value) => ({ value, label: DEVICE_TYPE_LABELS[value] })),
    },
  },
  deviceModel: {
    id: "deviceModel",
    label: "device model",
    description: "the brand and model, e.g. Apple iPhone 14 Pro (if they don't know, ask once more, then accept that)",
    primaryChannel: "call",
    required: true,
    authority: "either",
    spokenCapture: true,
    conflictClass: "typedPreferred",
    card: {
      kind: InputKind.TEXT,
      label: "Which brand and model is it?",
      help: "For example: Samsung Galaxy S23 or Dell XPS 13. It's usually on the box or in Settings › About.",
      placeholder: "Brand and model",
      required: true,
    },
  },
  problemDescription: {
    id: "problemDescription",
    label: "problem description",
    description: "what is wrong with the device, in the customer's own words (at least a few words about the symptom)",
    primaryChannel: "call",
    required: true,
    authority: "either",
    spokenCapture: true,
    conflictClass: "narrative",
    card: {
      kind: InputKind.TEXT,
      label: "What's wrong with the device?",
      help: "Describe what happens, e.g. “the screen flickers and goes black after a minute”.",
      required: true,
    },
  },
  problemStartedAt: {
    id: "problemStartedAt",
    label: "start date",
    description: "when the problem started; pass the customer's exact words (e.g. 'last Tuesday'); dates are worked out by the system",
    primaryChannel: "call",
    required: true,
    authority: "either",
    spokenCapture: true,
    conflictClass: "narrative",
    card: {
      kind: InputKind.DATE,
      label: "When did the problem start?",
      help: "An approximate date is fine.",
      required: true,
    },
  },
  urgency: {
    id: "urgency",
    label: "urgency",
    description: `how soon they need the device back: ${URGENCY_LEVELS.join(", ")}, with the reason if they give one`,
    primaryChannel: "call",
    required: true,
    authority: "either",
    spokenCapture: true,
    conflictClass: "narrative",
    card: {
      kind: InputKind.SELECT,
      label: "How soon do you need it back?",
      required: true,
      options: URGENCY_LEVELS.map((value) => ({ value, label: URGENCY_LABELS[value] })),
    },
  },
  serialNumber: {
    id: "serialNumber",
    label: "serial number",
    description: "the IMEI or serial number; it must be typed in the chat card (a spoken one is only noted, never accepted)",
    primaryChannel: "chat",
    required: true,
    authority: "chatOnly",
    spokenCapture: true,
    conflictClass: "identifier",
    card: {
      kind: InputKind.TEXT,
      label: "Serial number or IMEI",
      help: "Dial *#06# on a phone to see the IMEI (15 digits). Laptops and other devices: 8–20 letters and digits, on the label or in Settings.",
      placeholder: "35 209900 176148 1",
      required: true,
      pattern: "^[A-Za-z0-9 \\-]{8,40}$",
    },
  },
  purchaseInvoice: {
    id: "purchaseInvoice",
    label: "purchase invoice",
    description: "a photo or PDF of the purchase invoice, uploaded in the chat card",
    primaryChannel: "chat",
    required: true,
    authority: "either",
    spokenCapture: false,
    conflictClass: "chatInput",
    card: {
      kind: InputKind.FILE,
      label: "Upload your purchase invoice",
      help: "A PDF, JPEG, PNG or WebP file up to 10 MB. HEIC photos aren't supported.",
      required: true,
      accept: ACCEPTED_FILE_TYPES.join(","),
    },
  },
  serviceCentre: {
    id: "serviceCentre",
    label: "service centre",
    description: "the service centre they prefer, chosen from the list in the chat card",
    primaryChannel: "chat",
    required: true,
    authority: "either",
    spokenCapture: true,
    conflictClass: "choice",
    card: {
      kind: InputKind.SELECT,
      label: "Which service centre suits you?",
      required: true,
      options: SERVICE_CENTRES.map((centre) => ({ value: centre.id, label: serviceCentreLabel(centre) })),
    },
  },
  email: {
    id: "email",
    label: "email address",
    description: "their email address for updates; it must be typed in the chat card (a spoken one is only noted, never accepted)",
    primaryChannel: "chat",
    required: true,
    authority: "chatOnly",
    spokenCapture: true,
    conflictClass: "identifier",
    card: {
      kind: InputKind.EMAIL,
      label: "Your email address",
      help: "We'll send claim updates here.",
      placeholder: "name@example.com",
      required: true,
    },
  },
  additionalPhotos: {
    id: "additionalPhotos",
    label: "photos",
    description: "optional photos of the device or the damage (up to 5), in the chat card",
    primaryChannel: "chat",
    required: false,
    authority: "either",
    spokenCapture: false,
    conflictClass: "chatInput",
    card: {
      kind: InputKind.FILE,
      label: "Any photos of the device or the damage? (optional)",
      help: `Up to ${MAX_ADDITIONAL_PHOTOS} JPEG, PNG or WebP images, 10 MB each.`,
      required: false,
      accept: IMAGE_TYPES,
      multiple: true,
    },
  },
  additionalNotes: {
    id: "additionalNotes",
    label: "notes",
    description: "optional notes for the technician, in the chat card",
    primaryChannel: "chat",
    required: false,
    authority: "either",
    spokenCapture: false,
    conflictClass: "chatInput",
    card: {
      kind: InputKind.TEXT,
      label: "Anything else the technician should know? (optional)",
      help: `Up to ${MAX_NOTES_CHARS.toLocaleString("en-US")} characters.`,
      required: false,
    },
  },
  submitConfirmation: {
    id: "submitConfirmation",
    label: "confirmation",
    description: "the customer's confirmation, given only by tapping Yes on the chat card (a spoken yes does not count)",
    primaryChannel: "chat",
    required: true,
    authority: "either",
    spokenCapture: false,
    conflictClass: "chatInput",
    card: {
      kind: InputKind.CONFIRM,
      label: "Submit your claim?",
      help: "Check the details above. You can still change anything.",
      required: true,
    },
  },
} satisfies Record<FieldId, FieldDefinition>);

export const isFieldId = (value: unknown): value is FieldId => typeof value === "string" && (FIELD_IDS as readonly string[]).includes(value);

/** Required fields that a `completed` record needs (the confirmation is checked separately). */
export const REQUIRED_RECORD_FIELDS: readonly RecordFieldId[] = [...CALL_FIELDS, ...CHAT_FIELDS];

/**
 * The field section of the call agent's system prompt (architecture §6). Deterministic, so the prompt prefix stays
 * byte-stable for provider-side caching.
 */
export function describeFieldsForPrompt(): string {
  const line = (id: FieldId) => `- ${id} (${FIELDS[id].required ? "required" : "optional"}): ${FIELDS[id].description}.`;
  return [
    "Collect on the call (easy to say):",
    ...CALL_FIELDS.map(line),
    "Collect in the chat (send the card with request_chat_input):",
    ...CHAT_FIELDS.map(line),
    "Optional, offered in the chat near the end:",
    ...OPTIONAL_FIELDS.map(line),
    "Submission:",
    line("submitConfirmation"),
  ].join("\n");
}
