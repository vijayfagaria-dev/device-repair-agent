"""The commands the chat socket dispatches for client messages (protocol.md section 3.4), and their reply contract (P3-T04).

Handlers: submit_chat_input.py (P4-T02) and opt_out.py (P4-T05). Replies are dicts with the TS key names:

- ``{"status": "accepted", "finalized"?: {"revision", "outcome", "schemaProblems"?}}`` / ``{"status": "rejected"}``:
  decided and persisted; the client hears about it through the committed events (``chat.message``, ``input.rejected``
  -> inputError, ...), live and on replay. ``finalized`` is set when this answer finalized the session (Yes on a
  confirm card, P6-T01).
- ``{"status": "stale", "message", "open"?}``: the request isn't the session's open one; nothing is written, so the
  socket answers directly with inputError "This request is no longer active" (protocol.md section 3.4). ``open`` is
  the session's open card when it isn't the one answered (``{"id", "field", "spec"}``); the socket sends it again
  after the error, so a page that still shows the stale card shows the right one.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, ClassVar

STALE_REQUEST_MESSAGE = "This request is no longer active."


@dataclass(frozen=True, slots=True)
class SubmitChatInput:
    type: ClassVar[str] = "SubmitChatInput"
    request_id: str
    field: str
    value: Any


@dataclass(frozen=True, slots=True)
class OptOutRequested:
    type: ClassVar[str] = "OptOutRequested"
