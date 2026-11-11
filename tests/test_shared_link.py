"""Port of server/test/shared-link.test.ts: the server reaches the wire protocol through its own package."""

from __future__ import annotations

from app.protocol.constants import MIC_FRAME_BYTES
from app.protocol.enums import Outcome


def test_resolves_the_protocol_package_with_runtime_values() -> None:
    assert MIC_FRAME_BYTES == 640
    assert Outcome.NEEDS_REVIEW == "needsReview"
