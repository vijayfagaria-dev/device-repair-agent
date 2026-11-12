"""Structured JSON logs (structlog) with secret redaction from day one (D02, D19).

One JSON object per line with the field names the TypeScript server's pino logs had: `level` (a label), `time`
(ISO-8601 with milliseconds, UTC), `service`, `msg`, then the event's own fields. Redaction is by key name at any depth;
config secrets are also `Secret` objects, which render as "[Redacted]" wherever they appear.
"""

from __future__ import annotations

import dataclasses
import datetime as dt
import json
import sys
from collections.abc import Mapping
from typing import Any, TextIO

import structlog

from app.config import REDACTED, LogLevel, Secret

SERVICE_NAME = "voice-chat-agent"

#: Keys whose values are never logged (compared exactly, as pino's redact paths were). The snake_case spellings are
#: there because Python code logs `api_key`, not `apiKey`.
SENSITIVE_KEYS = frozenset(
    {
        "apiKey",
        "api_key",
        "token",
        "secret",
        "password",
        "authorization",
        "cookie",
        "set-cookie",
    }
)

#: pino's levels, as stdlib numbers for structlog's filtering logger (trace is below debug; silent drops everything in a processor).
_LEVELS: dict[str, int] = {"trace": 0, "debug": 10, "info": 20, "warn": 30, "error": 40, "fatal": 50, "silent": 50}

#: The method a call came through, as the label pino used.
_LABELS: dict[str, str] = {
    "debug": "debug",
    "info": "info",
    "warn": "warn",
    "warning": "warn",
    "error": "error",
    "exception": "error",
    "critical": "fatal",
    "fatal": "fatal",
    "msg": "info",
    "log": "info",
}


def _redact(value: Any) -> Any:
    if isinstance(value, Secret):
        return REDACTED
    if isinstance(value, Mapping):
        return {k: (REDACTED if k in SENSITIVE_KEYS else _redact(v)) for k, v in value.items()}
    if isinstance(value, list | tuple):
        return [_redact(item) for item in value]
    return value


def _iso_now() -> str:
    now = dt.datetime.now(dt.UTC)
    return now.strftime("%Y-%m-%dT%H:%M:%S.") + f"{now.microsecond // 1000:03d}Z"


def _shape(_logger: Any, method_name: str, event_dict: dict[str, Any]) -> dict[str, Any]:
    """pino's layout: level, time, service, the fields, msg."""
    message = event_dict.pop("event", "")
    exc = event_dict.pop("exc_info", None)
    out: dict[str, Any] = {"level": _LABELS.get(method_name, method_name), "time": _iso_now(), "service": SERVICE_NAME}
    for key, value in event_dict.items():
        out[key] = REDACTED if key in SENSITIVE_KEYS else _redact(value)
    if exc:
        out["err"] = {"type": type(exc).__name__, "message": str(exc)} if isinstance(exc, BaseException) else str(exc)
    out["msg"] = message
    return out


def _default(value: Any) -> Any:
    if isinstance(value, Secret):
        return REDACTED
    if isinstance(value, dt.datetime):
        utc = value.astimezone(dt.UTC) if value.tzinfo else value.replace(tzinfo=dt.UTC)
        return utc.strftime("%Y-%m-%dT%H:%M:%S.") + f"{utc.microsecond // 1000:03d}Z"
    if dataclasses.is_dataclass(value) and not isinstance(value, type):
        return _redact(dataclasses.asdict(value))
    if isinstance(value, BaseException):
        return {"type": type(value).__name__, "message": str(value)}
    if isinstance(value, bytes | bytearray):
        return f"<{len(value)} bytes>"
    if hasattr(value, "model_dump"):
        return _redact(value.model_dump(mode="json"))
    return str(value)


def _render(_logger: Any, _method: str, event_dict: dict[str, Any]) -> str:
    return json.dumps(event_dict, default=_default, ensure_ascii=False, separators=(",", ":"))


def _drop(_logger: Any, _method: str, _event_dict: dict[str, Any]) -> dict[str, Any]:
    raise structlog.DropEvent


def _processors(level: str) -> list[Any]:
    return [_drop] if level == "silent" else [_shape, _render]


def create_logger(level: LogLevel = "info", destination: TextIO | None = None) -> Any:
    """A logger at `level` writing JSON lines to `destination` (default stdout). `level="silent"` logs nothing.

    Returns a structlog bound logger: `log.info("event name", key=value)`, `log.bind(k=v)` for a child.
    """
    wrapper = structlog.make_filtering_bound_logger(_LEVELS[level])
    printer = structlog.PrintLogger(file=destination if destination is not None else sys.stdout)
    return structlog.wrap_logger(printer, processors=_processors(level), wrapper_class=wrapper)


def configure_logging(level: LogLevel = "info", destination: TextIO | None = None) -> None:
    """Sets structlog's global default, so `structlog.get_logger()` logs this way (call once at boot)."""
    structlog.configure(
        processors=_processors(level),
        wrapper_class=structlog.make_filtering_bound_logger(_LEVELS[level]),
        logger_factory=structlog.PrintLoggerFactory(file=destination if destination is not None else sys.stdout),
        cache_logger_on_first_use=False,
    )
