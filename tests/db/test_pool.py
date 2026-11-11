"""Port of server/test/pool.test.ts (the cases test_db_core.py does not already cover)."""

from __future__ import annotations

import ssl

import asyncpg

from app.db.pool import connection_settings, is_transient_db_error


def verifies(setting: object) -> bool:
    return isinstance(setting, ssl.SSLContext) and setting.verify_mode == ssl.CERT_REQUIRED and setting.check_hostname


class TestConnectionSettings:
    def test_verifies_tls_for_remote_hosts_and_strips_sslmode_from_the_string(self) -> None:
        dsn, tls = connection_settings(
            "postgresql://u:p@ep-x-pooler.us-east-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require"
        )
        assert verifies(tls)
        assert "sslmode" not in dsn
        assert "channel_binding=require" in dsn

    def test_verifies_tls_for_a_remote_host_even_without_sslmode(self) -> None:
        assert verifies(connection_settings("postgresql://u:p@db.example.com/app")[1])

    def test_uses_plain_tcp_for_local_hosts_without_sslmode_and_whenever_sslmode_disable(self) -> None:
        assert connection_settings("postgresql://postgres@127.0.0.1:5432/postgres")[1] is False
        assert connection_settings("postgresql://postgres@localhost/postgres")[1] is False
        assert connection_settings("postgresql://u@db.example.com/app?sslmode=disable")[1] is False
        assert verifies(connection_settings("postgresql://postgres@localhost/postgres?sslmode=require")[1])


class TestIsTransientDbError:
    @staticmethod
    def with_sqlstate(code: str) -> Exception:
        err = Exception("x")
        err.sqlstate = code  # type: ignore[attr-defined]
        return err

    def test_retries_connection_level_failures(self) -> None:
        for code in ["08006", "08001", "57P01", "57P03"]:
            assert is_transient_db_error(self.with_sqlstate(code)), code
        assert is_transient_db_error(ConnectionRefusedError())
        assert is_transient_db_error(ConnectionResetError())
        assert is_transient_db_error(TimeoutError("timeout exceeded when trying to connect"))
        assert is_transient_db_error(asyncpg.PostgresConnectionError("Connection terminated unexpectedly"))

    def test_never_retries_sql_errors_or_protocol_violations(self) -> None:
        for code in ["42P01", "23505", "42601", "28P01", "08P01", "P0001"]:
            assert not is_transient_db_error(self.with_sqlstate(code)), code
        assert not is_transient_db_error("not an error")  # type: ignore[arg-type]
