"""Port of server/test/config.test.ts."""

from __future__ import annotations

import json
from typing import Any

import pytest
from pydantic import ValidationError

from app.config import Config, ConfigError, ConfigProblem, Secret, load_config
from tests.helpers.env import FAKE, valid_env


def config_error(env: dict[str, str | None]) -> ConfigError:
    with pytest.raises(ConfigError) as info:
        load_config(env)
    return info.value


class TestLoadConfig:
    def test_accepts_a_valid_environment_and_applies_defaults(self) -> None:
        config = load_config(valid_env())
        assert (config.env, config.host, config.port, config.log_level) == ("development", "0.0.0.0", 8080, "info")
        assert config.public_origin == "http://localhost:8080"
        assert config.groq_api_key.reveal() == FAKE["GROQ_API_KEY"]
        assert config.database_url.reveal() == FAKE["DATABASE_URL"]
        assert config.gemini_api_key is None
        assert config.test_api_token is None
        with pytest.raises(ValidationError):  # frozen
            config.port = 1  # type: ignore[misc]

    def test_parses_optional_and_typed_values(self) -> None:
        config = load_config(
            valid_env(
                PORT="3001",
                LOG_LEVEL="debug",
                GEMINI_API_KEY=FAKE["GEMINI_API_KEY"],
                ALLOW_TEST_API="true",
                TEST_API_TOKEN=FAKE["TEST_API_TOKEN"],
            )
        )
        assert config.port == 3001
        assert config.log_level == "debug"
        assert config.gemini_api_key is not None
        assert config.gemini_api_key.reveal() == FAKE["GEMINI_API_KEY"]
        assert config.test_api_token is not None
        assert config.test_api_token.reveal() == FAKE["TEST_API_TOKEN"]

    def test_defaults_and_parses_the_proxy_trust_and_new_session_limits(self) -> None:
        defaults = load_config(valid_env())
        assert (defaults.trust_proxy_hops, defaults.new_sessions_per_ip_per_hour) == (0, 20)
        custom = load_config(valid_env(TRUST_PROXY_HOPS="1", NEW_SESSIONS_PER_IP_PER_HOUR="50"))
        assert (custom.trust_proxy_hops, custom.new_sessions_per_ip_per_hour) == (1, 50)
        err = config_error(valid_env(TRUST_PROXY_HOPS="-1", NEW_SESSIONS_PER_IP_PER_HOUR="0"))
        assert err.problems == [
            ConfigProblem("TRUST_PROXY_HOPS", "is invalid (expected an integer from 0 to 5)"),
            ConfigProblem("NEW_SESSIONS_PER_IP_PER_HOUR", "is invalid (expected an integer from 1 to 10000)"),
        ]
        for bad in ["1.5", "abc", "999"]:
            message = str(config_error(valid_env(TRUST_PROXY_HOPS=bad)))
            assert "TRUST_PROXY_HOPS is invalid" in message
            assert bad not in message

    def test_names_every_missing_variable_at_once_treating_blank_values_as_missing(self) -> None:
        err = config_error(valid_env(GROQ_API_KEY=None, HOOK_SECRET="   ", PUBLIC_ORIGIN=""))
        assert sorted(err.problems, key=lambda p: p.name) == [
            ConfigProblem("GROQ_API_KEY", "is missing"),
            ConfigProblem("HOOK_SECRET", "is missing"),
            ConfigProblem("PUBLIC_ORIGIN", "is missing"),
        ]
        assert "GROQ_API_KEY is missing" in str(err)

    def test_never_includes_a_value_in_the_error_valid_or_invalid(self) -> None:
        invalid = {
            "DEEPGRAM_API_KEY": "short-dg-key",
            "FILE_URL_SECRET": "too-short-file-secret",
            "DATABASE_URL": "mysql://someone:hunter2-password@db.invalid/app",
            "PUBLIC_ORIGIN": "https://example.com/some/path",
            "PORT": "not-a-port-9999",
            "LOG_LEVEL": "loud-level",
            "TEST_API_TOKEN": "tiny-token",
        }
        err = config_error(valid_env(**invalid, GROQ_API_KEY=None))
        assert sorted(p.name for p in err.problems) == sorted([*invalid, "GROQ_API_KEY"])
        output = f"{err}\n{err.problems!r}\n{err!r}"
        for value in [*invalid.values(), *FAKE.values()]:
            assert value not in output
        assert "hunter2" not in output

    def test_requires_test_api_token_only_when_the_test_api_is_enabled(self) -> None:
        assert load_config(valid_env(ALLOW_TEST_API="false")).test_api_token is None
        err = config_error(valid_env(ALLOW_TEST_API="true"))
        assert err.problems == [ConfigProblem("TEST_API_TOKEN", "is missing (required when ALLOW_TEST_API=true)")]

    def test_requires_an_https_public_origin_in_production(self) -> None:
        err = config_error(valid_env(NODE_ENV="production"))
        assert err.problems == [ConfigProblem("PUBLIC_ORIGIN", "is invalid (must use https in production)")]
        config = load_config(valid_env(NODE_ENV="production", PUBLIC_ORIGIN="https://repair.example.com"))
        assert config.env == "production"

    def test_reads_os_environ_by_default(self, monkeypatch: pytest.MonkeyPatch) -> None:
        for name, value in valid_env().items():
            assert value is not None
            monkeypatch.setenv(name, value)
        assert load_config().public_origin == "http://localhost:8080"


class TestRecordDeliveryAndIdleCompletion:
    def test_defaults_auto_complete_on_idle_on_no_webhook(self) -> None:
        config = load_config(valid_env())
        assert config.auto_complete_on_idle is True
        assert config.record_webhook_url is None
        assert load_config(valid_env(AUTO_COMPLETE_ON_IDLE="false")).auto_complete_on_idle is False

    def test_record_webhook_url_must_be_http_and_is_a_secret(self) -> None:
        config = load_config(valid_env(RECORD_WEBHOOK_URL="https://hooks.example.com/abc123secret"))
        assert config.record_webhook_url is not None
        assert config.record_webhook_url.reveal() == "https://hooks.example.com/abc123secret"
        assert "abc123secret" not in config.model_dump_json()
        for bad in ["ftp://x.example.com/a", "not a url", "javascript:alert(1)"]:
            with pytest.raises(ConfigError, match="RECORD_WEBHOOK_URL"):
                load_config(valid_env(RECORD_WEBHOOK_URL=bad))
        with pytest.raises(ConfigError, match="AUTO_COMPLETE_ON_IDLE"):
            load_config(valid_env(AUTO_COMPLETE_ON_IDLE="maybe"))


class TestSecret:
    def test_does_not_reveal_its_value_when_stringified_serialised_or_inspected(self) -> None:
        secret = Secret("sk-test-value")
        config = load_config(valid_env())
        rendered = [
            str(secret),
            f"{secret}",
            repr(secret),
            json.dumps({"secret": str(secret)}),
            repr(config),
            str(config),
            config.model_dump_json(),
            json.dumps(config.model_dump(mode="json")),
        ]
        for text in rendered:
            assert "sk-test-value" not in text
        for value in FAKE.values():
            assert value not in config.model_dump_json()
            assert value not in repr(config)
        assert str(secret) == "[Redacted]"
        assert secret.reveal() == "sk-test-value"

    def test_p5_the_calls_routes_voice_and_limits_with_defaults(self) -> None:
        config = load_config(valid_env())
        assert config.llm_routes == (
            "groq:openai/gpt-oss-20b",
            "groq:openai/gpt-oss-120b",
            "gemini:gemini-flash-lite-latest",
        )
        assert config.tts_voice == "aura-2-thalia-en"
        assert config.max_concurrent_calls == 1
        assert config.max_call_seconds == 600
        assert config.daily_llm_request_budget == 800
        assert config.daily_audio_minutes_budget == 120
        custom = load_config(
            valid_env(
                LLM_MODEL="openai/gpt-oss-120b",
                LLM_FALLBACK_MODELS="gemini:gemini-flash-lite-latest",
                TTS_VOICE="aura-2-helena-en",
                MAX_CONCURRENT_CALLS="2",
            )
        )
        assert custom.llm_routes == ("groq:openai/gpt-oss-120b", "gemini:gemini-flash-lite-latest")
        assert (custom.tts_voice, custom.max_concurrent_calls) == ("aura-2-helena-en", 2)
        bad_values: list[tuple[str, str]] = [
            ("LLM_FALLBACK_MODELS", "openai:gpt-4"),
            ("TTS_VOICE", "thalia"),
            ("MAX_CONCURRENT_CALLS", "0"),
            ("MAX_CALL_SECONDS", "5"),
            ("DAILY_LLM_REQUEST_BUDGET", "0"),
            ("DAILY_AUDIO_MINUTES_BUDGET", "many"),
        ]
        for name, value in bad_values:
            overrides: dict[str, Any] = {name: value}
            with pytest.raises(ConfigError, match=name):
                load_config(valid_env(**overrides))


def test_config_type_is_exported() -> None:
    assert issubclass(Config, object)
