"""Conflict detection and resolution (D15, P2-T05). Pure: the append-only candidate history of one field in, its
effective value out. Nothing is ever overwritten; corrections are new candidates and the latest valid one counts."""

from __future__ import annotations

from collections.abc import Callable, Sequence
from dataclasses import dataclass
from typing import Any, Literal

from .canonical_json import canonical_json
from .fields import FIELDS

CandidateStatus = Literal["valid", "invalid", "skipped", "unverified"]
ResolvedStatus = Literal["valid", "invalid", "missing", "skipped", "unverified"]
ConflictResolution = Literal["callValue", "chatValue", "same"]


@dataclass(frozen=True, slots=True)
class Candidate:
    """One offered value (a `field_candidates` row, architecture section 4)."""

    source: Literal["call", "chat"]
    # The event seq that recorded it: assigned under the session lock, so it is the commit order.
    seq: int
    # Server time it was collected (ISO 8601).
    collected_at: str
    status: CandidateStatus
    # The validator's normalized value (None unless the validator accepted it, or for chatOnly values heard on the call).
    normalized: Any
    # The user explicitly confirmed this value (read back on the call, or picked on a "which is correct?" card).
    user_confirmed: bool = False


@dataclass(frozen=True, slots=True)
class FieldConflict:
    field: str
    call_value: Any
    chat_value: Any
    resolution: ConflictResolution
    reason: str
    # An identifier conflict where the user had confirmed the losing (spoken) value: the agent should ask which is
    # correct (a conflictChoice card), and if it stays unresolved at finalization the outcome is needsReview (R-2).
    unresolved: bool = False


@dataclass(frozen=True, slots=True)
class ResolvedField:
    value: Any
    source: Literal["call", "chat"] | None
    collected_at: str | None
    status: ResolvedStatus
    # Present whenever both channels hold a value, including equal ones (reported as corroboration).
    conflict: FieldConflict | None = None


def _lower(value: Any) -> Any:
    return value.lower() if isinstance(value, str) else value


def _pick(value: Any, key: str) -> Any:
    return value.get(key) if isinstance(value, dict) else None


# What "the same value" means per field, after normalization.
_COMPARABLE: dict[str, Callable[[Any], Any]] = {
    "email": _lower,
    "serialNumber": lambda v: _pick(v, "value"),
    "serviceCentre": lambda v: _pick(v, "id"),
    "deviceModel": lambda v: [_lower(_pick(v, "brand")), _lower(_pick(v, "model"))],
    "problemDescription": lambda v: _lower(_pick(v, "verbatim")),
    "problemStartedAt": lambda v: _pick(v, "date"),
    "urgency": lambda v: _pick(v, "level"),
}


def same_value(field: str, a: Any, b: Any) -> bool:
    comparable = _COMPARABLE.get(field, lambda v: v)
    ca, cb = comparable(a), comparable(b)
    return canonical_json(None if ca is None else ca) == canonical_json(None if cb is None else cb)


def _utf16(text: str) -> bytes:
    """JS compares strings by UTF-16 code unit; big-endian bytes give the same order."""
    return text.encode("utf-16-be", "surrogatepass")


def _is_later(a: Candidate, b: Candidate) -> bool:
    """A total order on candidates: commit order (seq) first. Ties (several candidates from one event) fall back to
    time, then source, then the value itself, so the result never depends on the order rows were read in."""
    if a.seq != b.seq:
        return a.seq > b.seq
    if a.collected_at != b.collected_at:
        return _utf16(a.collected_at) > _utf16(b.collected_at)
    if a.source != b.source:
        return a.source == "chat"
    if a.status != b.status:
        return _utf16(a.status) > _utf16(b.status)
    return _utf16(canonical_json(a.normalized)) > _utf16(canonical_json(b.normalized))


def _latest(candidates: Sequence[Candidate], test: Callable[[Candidate], bool]) -> Candidate | None:
    found: Candidate | None = None
    for candidate in candidates:
        if test(candidate) and (found is None or _is_later(candidate, found)):
            found = candidate
    return found


def _from_candidate(
    candidate: Candidate, status: ResolvedStatus, conflict: FieldConflict | None = None
) -> ResolvedField:
    return ResolvedField(
        value=candidate.normalized if status in ("valid", "unverified") else None,
        source=candidate.source,
        collected_at=candidate.collected_at,
        status=status,
        conflict=conflict,
    )


def _resolve_both(field: str, call: Candidate, chat: Candidate) -> ResolvedField:
    """Both channels hold a value: apply the field's conflict class (D15)."""

    def conflict(resolution: ConflictResolution, reason: str, unresolved: bool = False) -> FieldConflict:
        return FieldConflict(
            field=field,
            call_value=call.normalized,
            chat_value=chat.normalized,
            resolution=resolution,
            reason=reason,
            unresolved=unresolved,
        )

    definition = FIELDS[field]

    if same_value(field, call.normalized, chat.normalized):
        # Corroboration, not a conflict. The value shown comes from the source the policy would have preferred.
        if definition.conflict_class == "narrative" or (
            definition.conflict_class == "choice" and _is_later(call, chat)
        ):
            winner = call
        else:
            winner = chat
        return _from_candidate(winner, "valid", conflict("same", "values equal after normalization"))
    match definition.conflict_class:
        case "identifier":
            # Typed always wins. If the user had confirmed the spoken value (and hasn't since confirmed the typed
            # one), a human or a "which is correct?" card must decide (D15 escalation).
            unresolved = call.user_confirmed and not chat.user_confirmed
            reason = (
                "typed value used, but the user had confirmed the spoken value; needs confirmation"
                if unresolved
                else "typed value preferred over spoken for identifiers"
            )
            return _from_candidate(chat, "valid", conflict("chatValue", reason, unresolved))
        case "typedPreferred":
            return _from_candidate(chat, "valid", conflict("chatValue", "typed value preferred for spelling"))
        case "narrative":
            return _from_candidate(
                call, "valid", conflict("callValue", "spoken account preferred; typed version kept as an addendum")
            )
        case "choice":
            recent = call if _is_later(call, chat) else chat
            return _from_candidate(
                recent, "valid", conflict("callValue" if recent is call else "chatValue", "most recent explicit choice")
            )
        case _:
            # chatInput fields never get here: their call candidates are ignored.
            return _from_candidate(chat, "valid")


def resolve_field(field: str, history: Sequence[Candidate]) -> ResolvedField:
    """The effective value of one field from its full candidate history. Deterministic: the same history always gives
    the same result, in any input order."""
    definition = FIELDS[field]
    candidates = (
        [c for c in history if c.source == "chat"] if definition.conflict_class == "chatInput" else list(history)
    )
    chat = _latest(candidates, lambda c: c.source == "chat" and c.status == "valid")
    # chatOnly identifiers: a value heard on the call never counts as valid; it is "heard, needs typing".
    if definition.authority == "chatOnly":
        call = _latest(candidates, lambda c: c.source == "call" and c.status in ("valid", "unverified"))
    else:
        call = _latest(candidates, lambda c: c.source == "call" and c.status == "valid")

    if chat and call:
        return _resolve_both(field, call, chat)
    if chat:
        return _from_candidate(chat, "valid")
    if call:
        return _from_candidate(call, "unverified" if definition.authority == "chatOnly" else "valid")

    last = _latest(candidates, lambda _c: True)
    if last is None:
        return ResolvedField(value=None, source=None, collected_at=None, status="missing", conflict=None)
    return _from_candidate(last, "skipped" if last.status == "skipped" else "invalid")
