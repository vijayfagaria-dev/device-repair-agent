"""Port of server/test/log.test.ts."""

from __future__ import annotations

import io
import json
import re
from typing import Any

from app.config import Secret, load_config
from app.logging import create_logger
from tests.helpers.env import FAKE, valid_env


def capture() -> tuple[Any, io.StringIO]:
    stream = io.StringIO()
    return create_logger("info", stream), stream


def parsed(stream: io.StringIO) -> list[dict[str, Any]]:
    return [json.loads(line) for line in stream.getvalue().splitlines() if line]


def test_redacts_api_key_to_redacted() -> None:
    logger, stream = capture()
    logger.info("provider call", apiKey="sk-test")
    assert "sk-test" not in stream.getvalue()
    line = parsed(stream)[0]
    assert line["apiKey"] == "[Redacted]"
    assert (line["msg"], line["level"]) == ("provider call", "info")


def test_redacts_the_plans_paths() -> None:
    logger, stream = capture()
    logger.info(
        "",
        provider={"apiKey": "sk-nested"},
        headers={"authorization": "Bearer sk-header", "cookie": "sid=sk-cookie"},
        req={"headers": {"authorization": "Bearer sk-req"}},
        upload={"token": "sk-token"},
        hook={"secret": "sk-secret"},
        token="sk-top-token",
    )
    output = stream.getvalue()
    for value in ["sk-nested", "sk-header", "sk-cookie", "sk-req", "sk-token", "sk-secret", "sk-top-token"]:
        assert value not in output
    line = parsed(stream)[0]
    assert line["provider"] == {"apiKey": "[Redacted]"}
    assert line["headers"]["authorization"] == "[Redacted]"
    assert line["upload"] == {"token": "[Redacted]"}
    assert line["hook"] == {"secret": "[Redacted]"}


def test_never_prints_config_secrets_even_when_the_whole_config_is_logged() -> None:
    logger, stream = capture()
    logger.info("config", config=load_config(valid_env()))
    output = stream.getvalue()
    for value in FAKE.values():
        assert value not in output
    assert "[Redacted]" in output
    logger.info("a secret on its own", value=Secret("sk-loose-secret"))
    assert "sk-loose-secret" not in stream.getvalue()


def test_writes_one_json_object_per_line_with_an_iso_timestamp() -> None:
    logger, stream = capture()
    logger.warning("hello")
    line = parsed(stream)[0]
    assert (line["level"], line["msg"], line["service"]) == ("warn", "hello", "device-repair-agent")
    assert re.match(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$", line["time"])


def test_levels_filter_and_silent_logs_nothing() -> None:
    stream = io.StringIO()
    create_logger("warn", stream).info("hidden")
    assert stream.getvalue() == ""
    silent = io.StringIO()
    create_logger("silent", silent).error("hidden")
    assert silent.getvalue() == ""
