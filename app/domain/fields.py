"""The field catalog (D14, P2-T01): one definition per field, the single source of truth for the chat planner, the
agent prompt, validation, conflict resolution and the record. Validators live in ./validators/*.

Also holds what shared/fields.ts defined: the field id lists, normalized value shapes and the FieldDefinition type.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from types import MappingProxyType
from typing import Any, Literal, TypedDict

from app.protocol.enums import InputKind

from .service_centres import SERVICE_CENTRES, service_centre_label

# Collected conversationally on the call (each also has a chat-card fallback, PD5).
CALL_FIELDS: tuple[str, ...] = ("deviceType", "deviceModel", "problemDescription", "problemStartedAt", "urgency")
# Awkward by voice, so collected in chat.
CHAT_FIELDS: tuple[str, ...] = ("serialNumber", "purchaseInvoice", "serviceCentre", "email")
# Offered once near the end and skippable (PD4).
OPTIONAL_FIELDS: tuple[str, ...] = ("additionalPhotos", "additionalNotes")
# The explicit "Submit claim?" confirmation (PD2). Not a record field: the record has a `submitConfirmation` block.
CONFIRMATION_FIELD = "submitConfirmation"

# Keys of `record.fields`, in record order.
RECORD_FIELD_IDS: tuple[str, ...] = (*CALL_FIELDS, *CHAT_FIELDS, *OPTIONAL_FIELDS)
FIELD_IDS: tuple[str, ...] = (*RECORD_FIELD_IDS, CONFIRMATION_FIELD)

# Ids are plain strings in Python (the TS literal unions CallFieldId / ChatFieldId / ... are not modelled).
FieldId = str
RecordFieldId = str

FieldChannel = Literal["call", "chat"]
# "chatOnly": an identifier that must be typed (D13). A value heard on the call is stored as `unverified` and never
# satisfies the field. "either": a valid value from either channel counts.
FieldAuthority = Literal["chatOnly", "either"]
# Conflict policy when both channels hold different valid values (D15):
#   identifier      serialNumber, email: the typed (chat) value always wins.
#   choice          deviceType, serviceCentre: the most recent explicit choice wins.
#   narrative       problemDescription, problemStartedAt, urgency: the spoken value wins; chat one kept as addendum.
#   typedPreferred  deviceModel: the typed value wins (spelling), else the spoken one.
#   chatInput       files, notes, the confirmation: chat only; call candidates are ignored.
ConflictClass = Literal["identifier", "choice", "narrative", "typedPreferred", "chatInput"]

# Normalized values (what `record.fields[id].value` holds when the field is valid).
DEVICE_TYPES: tuple[str, ...] = ("smartphone", "laptop", "tablet", "smartwatch", "headphones", "other")
URGENCY_LEVELS: tuple[str, ...] = ("low", "normal", "high", "critical")
DATE_PRECISIONS: tuple[str, ...] = ("day", "week", "month")
ACCEPTED_FILE_TYPES: tuple[str, ...] = ("application/pdf", "image/jpeg", "image/png", "image/webp")


class DeviceModelValue(TypedDict):
    """brand and model both None = the user didn't know, accepted after one re-ask (D14)."""

    brand: str | None
    model: str | None


class ProblemDescriptionValue(TypedDict):
    summary: str
    verbatim: str


class ProblemStartedAtValue(TypedDict):
    """`date` is YYYY-MM-DD in IST (best estimate), `precision` says how exact; `spoken` the user's words, if spoken."""

    date: str
    precision: str
    spoken: str | None


class UrgencyValue(TypedDict):
    level: str
    reason: str | None


class SerialNumberValue(TypedDict):
    kind: Literal["imei", "serial"]
    value: str


class ServiceCentreValue(TypedDict):
    id: str
    name: str
    city: str


class FileDescriptor(TypedDict):
    """A stored upload as it appears in the record: metadata plus a signed, expiring download URL (D10)."""

    fileId: str
    mime: str
    size: int
    sha256: str
    url: str


@dataclass(frozen=True, slots=True)
class InputOptionSpec:
    value: str
    label: str | None = None

    def to_dict(self) -> dict[str, str]:
        out = {"value": self.value}
        if self.label is not None:
            out["label"] = self.label
        return out


@dataclass(frozen=True, slots=True)
class CardSpec:
    """A chat card for the field: the wire `inputRequest` without its per-request parts (type, id, field)."""

    kind: InputKind
    label: str
    help: str | None = None
    placeholder: str | None = None
    required: bool | None = None
    pattern: str | None = None
    options: tuple[InputOptionSpec, ...] | None = None
    accept: str | None = None
    multiple: bool | None = None

    def to_dict(self) -> dict[str, Any]:
        """The wire keys of an inputRequest this card contributes (None values omitted)."""
        out: dict[str, Any] = {"kind": self.kind.value, "label": self.label}
        for key in ("help", "placeholder", "required", "pattern", "accept", "multiple"):
            value = getattr(self, key)
            if value is not None:
                out[key] = value
        if self.options is not None:
            out["options"] = [option.to_dict() for option in self.options]
        return out


@dataclass(frozen=True, slots=True)
class FieldDefinition:
    id: str
    # Short human label ("serial number"), used in messages and acknowledgements.
    label: str
    # One line for the agent's prompt: what the field means and how to collect it.
    description: str
    primary_channel: FieldChannel
    required: bool
    authority: FieldAuthority
    # Whether the call agent may store a spoken value for it (save_field).
    spoken_capture: bool
    conflict_class: ConflictClass
    card: CardSpec


# Upload limits (D10). The schema's CHECKs in 001_init.sql mirror the size limit.
MAX_FILE_BYTES = 10 * 1024 * 1024
MAX_ADDITIONAL_PHOTOS = 5
MAX_NOTES_CHARS = 1000
# After this many invalid answers to a required field, the controller stops asking (D14) and review rule R-3 applies.
MAX_ATTEMPTS = 3

DEVICE_TYPE_LABELS = {
    "smartphone": "Phone",
    "laptop": "Laptop",
    "tablet": "Tablet",
    "smartwatch": "Smartwatch",
    "headphones": "Headphones or earbuds",
    "other": "Something else",
}

URGENCY_LABELS = {
    "low": "No rush",
    "normal": "Within a few days",
    "high": "Urgently (in a day or two)",
    "critical": "Immediately: I can't manage without it",
}

IMAGE_TYPES = ",".join(t for t in ACCEPTED_FILE_TYPES if t.startswith("image/"))

_DEFINITIONS: tuple[FieldDefinition, ...] = (
    FieldDefinition(
        id="deviceType",
        label="device type",
        description=f"the kind of device: one of {', '.join(DEVICE_TYPES)}",
        primary_channel="call",
        required=True,
        authority="either",
        spoken_capture=True,
        conflict_class="choice",
        card=CardSpec(
            kind=InputKind.SELECT,
            label="What kind of device is it?",
            required=True,
            options=tuple(InputOptionSpec(v, DEVICE_TYPE_LABELS[v]) for v in DEVICE_TYPES),
        ),
    ),
    FieldDefinition(
        id="deviceModel",
        label="device model",
        description="the brand and model, e.g. Apple iPhone 14 Pro (if they don't know, ask once more, then accept that)",
        primary_channel="call",
        required=True,
        authority="either",
        spoken_capture=True,
        conflict_class="typedPreferred",
        card=CardSpec(
            kind=InputKind.TEXT,
            label="Which brand and model is it?",
            help="For example: Samsung Galaxy S23 or Dell XPS 13. It's usually on the box or in Settings › About.",  # noqa: RUF001
            placeholder="Brand and model",
            required=True,
        ),
    ),
    FieldDefinition(
        id="problemDescription",
        label="problem description",
        description="what is wrong with the device, in the customer's own words (at least a few words about the symptom)",
        primary_channel="call",
        required=True,
        authority="either",
        spoken_capture=True,
        conflict_class="narrative",
        card=CardSpec(
            kind=InputKind.TEXT,
            label="What's wrong with the device?",
            help="Describe what happens, e.g. “the screen flickers and goes black after a minute”.",
            required=True,
        ),
    ),
    FieldDefinition(
        id="problemStartedAt",
        label="start date",
        description="when the problem started; pass the customer's exact words (e.g. 'last Tuesday'); dates are worked out by the system",
        primary_channel="call",
        required=True,
        authority="either",
        spoken_capture=True,
        conflict_class="narrative",
        card=CardSpec(
            kind=InputKind.DATE,
            label="When did the problem start?",
            help="An approximate date is fine.",
            required=True,
        ),
    ),
    FieldDefinition(
        id="urgency",
        label="urgency",
        description=f"how soon they need the device back: {', '.join(URGENCY_LEVELS)}, with the reason if they give one",
        primary_channel="call",
        required=True,
        authority="either",
        spoken_capture=True,
        conflict_class="narrative",
        card=CardSpec(
            kind=InputKind.SELECT,
            label="How soon do you need it back?",
            required=True,
            options=tuple(InputOptionSpec(v, URGENCY_LABELS[v]) for v in URGENCY_LEVELS),
        ),
    ),
    FieldDefinition(
        id="serialNumber",
        label="serial number",
        description="the IMEI or serial number; it must be typed in the chat card (a spoken one is only noted, never accepted)",
        primary_channel="chat",
        required=True,
        authority="chatOnly",
        spoken_capture=True,
        conflict_class="identifier",
        card=CardSpec(
            kind=InputKind.TEXT,
            label="Serial number or IMEI",
            help="Dial *#06# on a phone to see the IMEI (15 digits). Laptops and other devices: 8–20 letters and digits, on the label or in Settings.",  # noqa: RUF001
            placeholder="35 209900 176148 1",
            required=True,
            pattern=r"^[A-Za-z0-9 \-]{8,40}$",
        ),
    ),
    FieldDefinition(
        id="purchaseInvoice",
        label="purchase invoice",
        description="a photo or PDF of the purchase invoice, uploaded in the chat card",
        primary_channel="chat",
        required=True,
        authority="either",
        spoken_capture=False,
        conflict_class="chatInput",
        card=CardSpec(
            kind=InputKind.FILE,
            label="Upload your purchase invoice",
            help="A PDF, JPEG, PNG or WebP file up to 10 MB. HEIC photos aren't supported.",
            required=True,
            accept=",".join(ACCEPTED_FILE_TYPES),
        ),
    ),
    FieldDefinition(
        id="serviceCentre",
        label="service centre",
        description="the service centre they prefer, chosen from the list in the chat card",
        primary_channel="chat",
        required=True,
        authority="either",
        spoken_capture=True,
        conflict_class="choice",
        card=CardSpec(
            kind=InputKind.SELECT,
            label="Which service centre suits you?",
            required=True,
            options=tuple(InputOptionSpec(c.id, service_centre_label(c)) for c in SERVICE_CENTRES),
        ),
    ),
    FieldDefinition(
        id="email",
        label="email address",
        description="their email address for updates; it must be typed in the chat card (a spoken one is only noted, never accepted)",
        primary_channel="chat",
        required=True,
        authority="chatOnly",
        spoken_capture=True,
        conflict_class="identifier",
        card=CardSpec(
            kind=InputKind.EMAIL,
            label="Your email address",
            help="We'll send claim updates here.",
            placeholder="name@example.com",
            required=True,
        ),
    ),
    FieldDefinition(
        id="additionalPhotos",
        label="photos",
        description="optional photos of the device or the damage (up to 5), in the chat card",
        primary_channel="chat",
        required=False,
        authority="either",
        spoken_capture=False,
        conflict_class="chatInput",
        card=CardSpec(
            kind=InputKind.FILE,
            label="Any photos of the device or the damage? (optional)",
            help=f"Up to {MAX_ADDITIONAL_PHOTOS} JPEG, PNG or WebP images, 10 MB each.",
            required=False,
            accept=IMAGE_TYPES,
            multiple=True,
        ),
    ),
    FieldDefinition(
        id="additionalNotes",
        label="notes",
        description="optional notes for the technician, in the chat card",
        primary_channel="chat",
        required=False,
        authority="either",
        spoken_capture=False,
        conflict_class="chatInput",
        card=CardSpec(
            kind=InputKind.TEXT,
            label="Anything else the technician should know? (optional)",
            help=f"Up to {MAX_NOTES_CHARS:,} characters.",
            required=False,
        ),
    ),
    FieldDefinition(
        id="submitConfirmation",
        label="confirmation",
        description="the customer's confirmation, given only by tapping Yes on the chat card (a spoken yes does not count)",
        primary_channel="chat",
        required=True,
        authority="either",
        spoken_capture=False,
        conflict_class="chatInput",
        card=CardSpec(
            kind=InputKind.CONFIRM,
            label="Submit your claim?",
            help="Check the details above. You can still change anything.",
            required=True,
        ),
    ),
)

# Immutable and shared by every session: the mapping is read-only, definitions and cards are frozen dataclasses and
# option lists are tuples.
FIELDS: Mapping[str, FieldDefinition] = MappingProxyType({d.id: d for d in _DEFINITIONS})


def is_field_id(value: object) -> bool:
    return isinstance(value, str) and value in FIELD_IDS


# Required fields that a `completed` record needs (the confirmation is checked separately).
REQUIRED_RECORD_FIELDS: tuple[str, ...] = (*CALL_FIELDS, *CHAT_FIELDS)


def describe_fields_for_prompt() -> str:
    """The field section of the call agent's system prompt (architecture section 6). Deterministic, so the prompt
    prefix stays byte-stable for provider-side caching."""

    def line(field_id: str) -> str:
        field = FIELDS[field_id]
        return f"- {field_id} ({'required' if field.required else 'optional'}): {field.description}."

    return "\n".join(
        [
            "Collect on the call (easy to say):",
            *(line(i) for i in CALL_FIELDS),
            "Collect in the chat (send the card with request_chat_input):",
            *(line(i) for i in CHAT_FIELDS),
            "Optional, offered in the chat near the end:",
            *(line(i) for i in OPTIONAL_FIELDS),
            "Submission:",
            line(CONFIRMATION_FIELD),
        ]
    )
