"""Server configuration from environment variables, validated once at boot (D02).

Errors name the variables that are wrong but never echo a value. Secrets are wrapped in `Secret`, so logging or
serialising the config can't leak them; callers use `.reveal()` at the point of use.

pydantic-settings is not used: `load_config` reads a mapping (``os.environ`` by default) with the same variable names,
defaults and messages as the TypeScript server's zod schema.
"""

from __future__ import annotations

import math
import os
import re
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from typing import Any, Literal
from urllib.parse import urlsplit

from pydantic import BaseModel, ConfigDict
from pydantic_core import core_schema

REDACTED = "[Redacted]"

NodeEnv = Literal["development", "test", "production"]
LogLevel = Literal["fatal", "error", "warn", "info", "debug", "trace", "silent"]


class Secret:
    """A string that never reveals itself by accident: str/repr/JSON all give "[Redacted]"; `reveal()` returns it."""

    __slots__ = ("_value",)

    def __init__(self, value: str) -> None:
        self._value = value

    def reveal(self) -> str:
        return self._value

    def __str__(self) -> str:
        return REDACTED

    def __repr__(self) -> str:
        return f"Secret({REDACTED})"

    def __format__(self, spec: str) -> str:
        return format(REDACTED, spec)

    def __reduce__(self) -> Any:
        raise TypeError("Secret cannot be pickled")

    def __copy__(self) -> Secret:
        return self

    def __deepcopy__(self, memo: Any) -> Secret:
        return self

    @classmethod
    def __get_pydantic_core_schema__(cls, _source: Any, _handler: Any) -> core_schema.CoreSchema:
        return core_schema.is_instance_schema(
            cls, serialization=core_schema.plain_serializer_function_ser_schema(lambda _value: REDACTED)
        )


class Config(BaseModel):
    """The validated configuration (frozen). Field names are the snake_case of the TypeScript `Config`."""

    model_config = ConfigDict(frozen=True, arbitrary_types_allowed=True)

    env: NodeEnv
    host: str
    port: int
    log_level: LogLevel
    #: Exact browser origin of the deployed page (`https://host`), used for Origin checks and signed URLs.
    public_origin: str
    deepgram_api_key: Secret
    groq_api_key: Secret
    #: Optional last-resort LLM fallback (D06).
    gemini_api_key: Secret | None
    database_url: Secret
    file_url_secret: Secret
    hook_secret: Secret
    #: Set only when ALLOW_TEST_API=true (D07 test-only HTTP API).
    test_api_token: Secret | None
    quota_override_token: Secret | None
    #: Reverse-proxy hops in front of the server whose X-Forwarded-For entries are trusted for the client IP
    #: (0 = use the socket address).
    trust_proxy_hops: int
    #: New sessions one client IP may create per hour (P1-T03; protocol.md section 2).
    new_sessions_per_ip_per_hour: int
    #: AUTO_COMPLETE_ON_IDLE (D16): an idle session with every required field valid but no confirmation is `completed`.
    auto_complete_on_idle: bool
    #: RECORD_WEBHOOK_URL (D17): where records are delivered; None means this server's own stub receiver.
    record_webhook_url: Secret | None
    #: IDLE_TIMEOUT_SECONDS (D16, PD3).
    idle_timeout_seconds: int
    #: SESSION_LIFETIME_SECONDS (PD3a): a session closes this long after its last activity.
    session_lifetime_seconds: int
    #: UPLOAD_BUDGET_BYTES (D10): the most all stored uploads may add up to (507 beyond it).
    upload_budget_bytes: int
    #: FILE_URL_TTL_SECONDS (P4-T03): how long a signed file link in a record stays valid.
    file_url_ttl_seconds: int
    #: LLM_MODEL + LLM_FALLBACK_MODELS (D06): the call agent's routes in order, as `provider:model`.
    llm_routes: tuple[str, ...]
    #: TTS_VOICE (D05): the Aura-2 voice.
    tts_voice: str
    #: MAX_CONCURRENT_CALLS: calls one instance runs at once.
    max_concurrent_calls: int
    #: MAX_CALL_SECONDS: a call ends after this long.
    max_call_seconds: int
    #: DAILY_LLM_REQUEST_BUDGET: LLM requests per model in a rolling 24 h before new calls are refused.
    daily_llm_request_budget: int
    #: DAILY_AUDIO_MINUTES_BUDGET: Deepgram audio minutes in a rolling 24 h before new calls are refused.
    daily_audio_minutes_budget: int


@dataclass(frozen=True, slots=True)
class ConfigProblem:
    name: str
    problem: str


class ConfigError(Exception):
    def __init__(self, problems: list[ConfigProblem]) -> None:
        lines = "\n".join(f"  - {p.name} {p.problem}" for p in problems)
        super().__init__(f"Invalid server configuration:\n{lines}")
        self.problems = list(problems)


# What each variable must look like. Used in error messages, so no input can be echoed.
EXPECTED: dict[str, str] = {
    "NODE_ENV": "one of development, test, production",
    "HOST": "a host name or IP address",
    "PORT": "an integer port from 0 to 65535",
    "LOG_LEVEL": "one of fatal, error, warn, info, debug, trace, silent",
    "PUBLIC_ORIGIN": "an origin such as https://example.com (scheme and host only, no path)",
    "DEEPGRAM_API_KEY": "an API key of at least 20 characters",
    "GROQ_API_KEY": "an API key of at least 20 characters",
    "GEMINI_API_KEY": "an API key of at least 20 characters, or unset",
    "DATABASE_URL": "a postgres:// or postgresql:// connection URL",
    "FILE_URL_SECRET": "a random secret of at least 32 characters",
    "HOOK_SECRET": "a random secret of at least 32 characters",
    "ALLOW_TEST_API": "true or false",
    "TEST_API_TOKEN": "a random token of at least 24 characters",
    "QUOTA_OVERRIDE_TOKEN": "a random token of at least 24 characters, or unset",
    "AUTO_COMPLETE_ON_IDLE": "true or false",
    "RECORD_WEBHOOK_URL": "an http:// or https:// URL, or unset for the built-in stub receiver",
    "TRUST_PROXY_HOPS": "an integer from 0 to 5",
    "NEW_SESSIONS_PER_IP_PER_HOUR": "an integer from 1 to 10000",
    "IDLE_TIMEOUT_SECONDS": "an integer from 60 to 86400",
    "SESSION_LIFETIME_SECONDS": "an integer from 3600 to 2592000",
    "UPLOAD_BUDGET_BYTES": "an integer number of bytes from 10485760 to 943718400",
    "FILE_URL_TTL_SECONDS": "an integer from 300 to 31536000",
    "LLM_MODEL": "a Groq model id such as openai/gpt-oss-20b",
    "LLM_FALLBACK_MODELS": "a comma-separated list of groq:<model> or gemini:<model>",
    "TTS_VOICE": "an Aura-2 voice id such as aura-2-thalia-en",
    "MAX_CONCURRENT_CALLS": "an integer from 1 to 20",
    "MAX_CALL_SECONDS": "an integer from 60 to 3600",
    "DAILY_LLM_REQUEST_BUDGET": "an integer from 1 to 1000000",
    "DAILY_AUDIO_MINUTES_BUDGET": "an integer from 1 to 1000000",
}


class _Invalid(Exception):
    """A value failed its check (the message is never shown; `EXPECTED` is)."""


# --- parsers: each takes the trimmed, non-blank text and returns the typed value, or raises _Invalid -----------------

_NUMBER = re.compile(r"[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?", re.ASCII)
_TRUE = frozenset({"true", "1", "yes", "on", "y", "enabled"})
_FALSE = frozenset({"false", "0", "no", "off", "n", "disabled"})


def _enum(*options: str) -> Callable[[str], str]:
    def parse(value: str) -> str:
        if value not in options:
            raise _Invalid
        return value

    return parse


def _min_length(minimum: int) -> Callable[[str], str]:
    def parse(value: str) -> str:
        if len(value) < minimum:
            raise _Invalid
        return value

    return parse


def _pattern(pattern: str) -> Callable[[str], str]:
    compiled = re.compile(pattern)

    def parse(value: str) -> str:
        if not compiled.fullmatch(value):
            raise _Invalid
        return value

    return parse


def _integer(minimum: int, maximum: int) -> Callable[[str], int]:
    def parse(value: str) -> int:
        # JS `Number(text)`: decimal, exponent and fraction forms; no underscores, no hex here.
        if not _NUMBER.fullmatch(value):
            raise _Invalid
        number = float(value)
        if not math.isfinite(number) or not number.is_integer() or not minimum <= number <= maximum:
            raise _Invalid
        return int(number)

    return parse


def _boolean(value: str) -> bool:
    lowered = value.lower()
    if lowered in _TRUE:
        return True
    if lowered in _FALSE:
        return False
    raise _Invalid


def _host_text(value: str) -> str:
    return value


def _origin(value: str) -> str:
    try:
        parts = urlsplit(value)
        host = parts.hostname
        port = parts.port
    except ValueError:
        raise _Invalid from None
    if parts.scheme not in ("http", "https") or not host:
        raise _Invalid
    rendered = f"[{host}]" if ":" in host else host
    default = 443 if parts.scheme == "https" else 80
    origin = f"{parts.scheme}://{rendered}" + ("" if port is None or port == default else f":{port}")
    if origin != value:
        raise _Invalid
    return value


def _http_url(value: str) -> str:
    try:
        parts = urlsplit(value)
        _ = parts.port
    except ValueError:
        raise _Invalid from None
    if parts.scheme not in ("http", "https") or not parts.hostname:
        raise _Invalid
    return value


def _postgres_url(value: str) -> str:
    try:
        parts = urlsplit(value)
        _ = parts.port
    except ValueError:
        raise _Invalid from None
    if parts.scheme not in ("postgres", "postgresql") or not parts.hostname:
        raise _Invalid
    return value


_MODEL = r"[A-Za-z0-9._/-]{1,100}"
_FALLBACKS = rf"((groq|gemini):{_MODEL})(,(groq|gemini):{_MODEL})*|"

# (name, default (None = required, "" = optional/unset), parser) in the order problems are reported.
_SPECS: list[tuple[str, str | None, Callable[[str], Any]]] = [
    ("NODE_ENV", "development", _enum("development", "test", "production")),
    ("HOST", "0.0.0.0", _host_text),
    ("PORT", "8080", _integer(0, 65535)),
    ("LOG_LEVEL", "info", _enum("fatal", "error", "warn", "info", "debug", "trace", "silent")),
    ("PUBLIC_ORIGIN", None, _origin),
    ("DEEPGRAM_API_KEY", None, _min_length(20)),
    ("GROQ_API_KEY", None, _min_length(20)),
    ("GEMINI_API_KEY", "", _min_length(20)),
    ("DATABASE_URL", None, _postgres_url),
    ("FILE_URL_SECRET", None, _min_length(32)),
    ("HOOK_SECRET", None, _min_length(32)),
    ("ALLOW_TEST_API", "false", _boolean),
    ("TEST_API_TOKEN", "", _min_length(24)),
    ("QUOTA_OVERRIDE_TOKEN", "", _min_length(24)),
    # D16 (signed off): on.
    ("AUTO_COMPLETE_ON_IDLE", "true", _boolean),
    ("RECORD_WEBHOOK_URL", "", _http_url),
    ("TRUST_PROXY_HOPS", "0", _integer(0, 5)),
    ("NEW_SESSIONS_PER_IP_PER_HOUR", "20", _integer(1, 10_000)),
    # PD3: 15 minutes by default, down to 60 s for demos.
    ("IDLE_TIMEOUT_SECONDS", "900", _integer(60, 86_400)),
    # PD3a: 7 days by default; at most 30.
    ("SESSION_LIFETIME_SECONDS", "604800", _integer(3_600, 2_592_000)),
    # D10: 600 MB by default; at least one 10 MB file, at most 900 MB (Neon's free storage is 1 GB).
    ("UPLOAD_BUDGET_BYTES", "629145600", _integer(10_485_760, 943_718_400)),
    # protocol.md section 8: 30 days by default.
    ("FILE_URL_TTL_SECONDS", "2592000", _integer(300, 31_536_000)),
    # D06: gpt-oss-20b on Groq, then gpt-oss-120b (its own rate bucket), then Gemini as the last resort.
    ("LLM_MODEL", "openai/gpt-oss-20b", _pattern(_MODEL)),
    ("LLM_FALLBACK_MODELS", "groq:openai/gpt-oss-120b,gemini:gemini-flash-lite-latest", _pattern(_FALLBACKS)),
    ("TTS_VOICE", "aura-2-thalia-en", _pattern(r"aura-2-[a-z]+-[a-z]{2}")),
    # architecture section 8: the concurrent-call cap starts at 1 (Groq free: 8,000 tokens/minute per model).
    ("MAX_CONCURRENT_CALLS", "1", _integer(1, 20)),
    ("MAX_CALL_SECONDS", "600", _integer(60, 3_600)),
    # Groq's free tier measured 1,000 requests/day per model (P0-T03): 800 leaves 20% headroom.
    ("DAILY_LLM_REQUEST_BUDGET", "800", _integer(1, 1_000_000)),
    # About 24 calls of the 5-minute length a claim takes.
    ("DAILY_AUDIO_MINUTES_BUDGET", "120", _integer(1, 1_000_000)),
]


def _blank(value: str | None) -> bool:
    return value is None or value.strip() == ""


def load_config(env: Mapping[str, str | None] | None = None) -> Config:
    """Validates `env` (default: ``os.environ``) and returns a frozen config.

    Raises `ConfigError` listing every bad variable by name (one line per variable, the first problem wins).
    """
    source: Mapping[str, str | None] = os.environ if env is None else env
    values: dict[str, Any] = {}
    problems: dict[str, ConfigProblem] = {}

    for name, default, parse in _SPECS:
        raw = source.get(name)
        if _blank(raw):
            if default is None:
                problems[name] = ConfigProblem(name, "is missing")
                continue
            if default == "":
                values[name] = None
                continue
            text = default
        else:
            assert raw is not None
            text = raw.strip()
        try:
            values[name] = parse(text)
        except _Invalid:
            problems[name] = ConfigProblem(name, f"is invalid (expected {EXPECTED.get(name, 'a valid value')})")

    # Cross-variable rules (their messages are written here and never include values).
    if values.get("ALLOW_TEST_API") and "TEST_API_TOKEN" not in problems and values["TEST_API_TOKEN"] is None:
        problems["TEST_API_TOKEN"] = ConfigProblem("TEST_API_TOKEN", "is missing (required when ALLOW_TEST_API=true)")
    if (
        values.get("NODE_ENV") == "production"
        and "PUBLIC_ORIGIN" in values
        and not values["PUBLIC_ORIGIN"].startswith("https://")
        and "PUBLIC_ORIGIN" not in problems
    ):
        problems["PUBLIC_ORIGIN"] = ConfigProblem("PUBLIC_ORIGIN", "is invalid (must use https in production)")

    if problems:
        order = {name: i for i, (name, _d, _p) in enumerate(_SPECS)}
        raise ConfigError(sorted(problems.values(), key=lambda p: order[p.name]))

    def secret(name: str) -> Secret | None:
        return None if values[name] is None else Secret(values[name])

    return Config(
        env=values["NODE_ENV"],
        host=values["HOST"],
        port=values["PORT"],
        log_level=values["LOG_LEVEL"],
        public_origin=values["PUBLIC_ORIGIN"],
        deepgram_api_key=Secret(values["DEEPGRAM_API_KEY"]),
        groq_api_key=Secret(values["GROQ_API_KEY"]),
        gemini_api_key=secret("GEMINI_API_KEY"),
        database_url=Secret(values["DATABASE_URL"]),
        file_url_secret=Secret(values["FILE_URL_SECRET"]),
        hook_secret=Secret(values["HOOK_SECRET"]),
        test_api_token=secret("TEST_API_TOKEN") if values["ALLOW_TEST_API"] else None,
        quota_override_token=secret("QUOTA_OVERRIDE_TOKEN"),
        auto_complete_on_idle=values["AUTO_COMPLETE_ON_IDLE"],
        record_webhook_url=secret("RECORD_WEBHOOK_URL"),
        trust_proxy_hops=values["TRUST_PROXY_HOPS"],
        new_sessions_per_ip_per_hour=values["NEW_SESSIONS_PER_IP_PER_HOUR"],
        idle_timeout_seconds=values["IDLE_TIMEOUT_SECONDS"],
        session_lifetime_seconds=values["SESSION_LIFETIME_SECONDS"],
        upload_budget_bytes=values["UPLOAD_BUDGET_BYTES"],
        file_url_ttl_seconds=values["FILE_URL_TTL_SECONDS"],
        llm_routes=(
            f"groq:{values['LLM_MODEL']}",
            *[route for route in values["LLM_FALLBACK_MODELS"].split(",") if route],
        ),
        tts_voice=values["TTS_VOICE"],
        max_concurrent_calls=values["MAX_CONCURRENT_CALLS"],
        max_call_seconds=values["MAX_CALL_SECONDS"],
        daily_llm_request_budget=values["DAILY_LLM_REQUEST_BUDGET"],
        daily_audio_minutes_budget=values["DAILY_AUDIO_MINUTES_BUDGET"],
    )
