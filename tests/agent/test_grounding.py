"""Live-call regressions: the model saved values the customer never said (urgency "critical" with an invented quote)."""

from __future__ import annotations

import json
import re

from app.agent.grounding import grounding_error
from app.agent.tools import parse_tool_call

SAID = ["It's a phone.", "IPhone 14.", "Last week. Last Tuesday, I dropped it."]


class TestGroundingError:
    def test_accepts_the_customers_own_words(self) -> None:
        assert grounding_error("It's a phone.", SAID) is None
        assert grounding_error("last Tuesday", SAID) is None
        assert grounding_error("IPhone 14", SAID) is None

    def test_rejects_an_invented_quote(self) -> None:
        error = grounding_error("I need it back as soon as possible, it's critical for my work", SAID)
        assert error is not None and re.search(r"not said", error)

    def test_rejects_filler_evidence_and_empty_evidence(self) -> None:
        for evidence in ("...??", ""):
            error = grounding_error(evidence, SAID)
            assert error is not None and re.search(r"exact words", error)

    def test_only_counts_recent_utterances_and_nothing_before_the_customer_spoke(self) -> None:
        assert grounding_error("It's a phone.", []) is not None
        many = ["laptop", "a", "b", "c", "d"]
        assert grounding_error("laptop", many) is not None


class TestSaveFieldValue:
    def test_rejects_markup_copied_from_the_state_message(self) -> None:
        result = parse_tool_call(
            "save_field",
            json.dumps(
                {"field": "deviceModel", "value": '<customer_words field="deviceModel">', "spoken_evidence": "x"}
            ),
        )
        assert result.ok is False

    def test_accepts_plain_words(self) -> None:
        result = parse_tool_call(
            "save_field",
            json.dumps({"field": "deviceModel", "value": "Apple iPhone 14", "spoken_evidence": "IPhone 14"}),
        )
        assert result.ok is True
