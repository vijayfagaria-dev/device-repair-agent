# Porting the server from TypeScript to Python (FastAPI)

Working document for the port; deleted when it is finished. The TypeScript server in `server/` is the **reference
implementation**: read it, do not edit it. Everything else (`web/`, `shared/`, `docs/`, `e2e/`, `scripts/`) is unchanged:
the React UI, the WebSocket protocol, the JSON record schema and the REST API stay byte-for-byte compatible, so the
existing UI, `shared/record.schema.json` and `scripts/check-api-examples.sh` work against the Python server.

Goal: same behaviour, same tests, idiomatic Python. Every TS test case gets a Python test.

## Stack

Python 3.12+ (3.13 locally), FastAPI + uvicorn, pydantic v2, **asyncpg** (so SQL keeps its `$1` placeholders), httpx,
`websockets` (Deepgram), `openai` SDK (Groq and Gemini via their OpenAI-compatible endpoints), `jsonschema`
(replaces Ajv), structlog, pytest + pytest-asyncio (`asyncio_mode = auto`), ruff. Run with `uv`:

```
uv run pytest tests/<dir> -q          # tests
uv run ruff check app tests           # lint   (uv run ruff format app tests)
```

Postgres for tests is started automatically (see `tests/conftest.py`); `TEST_DATABASE_URL` overrides it.

## Layout (package `app/`, tests in `tests/` mirroring it)

| TS (`server/src/…`, `shared/…`) | Python |
|---|---|
| `shared/fields.ts`, `shared/protocol/*` | `app/protocol/` (pydantic models, enums, constants), field ids in `app/domain/fields.py` |
| `domain/**` | `app/domain/**` (`validators/` subpackage) |
| `db/pool.ts tx.ts migrate.ts` | **done**: `app/db/pool.py tx.py migrate.py` |
| `db/repos/*.ts` | `app/db/repos/*.py` |
| `session/**` | `app/session/**` |
| `agent/**` | `app/agent/**` |
| `voice/**` (incl. `fakes/`) | `app/voice/**` |
| `ws/**` | `app/ws/**` |
| `http/**` | `app/api/**` |
| `delivery/ jobs/ metrics/ limits/ boot/ files/` | `app/delivery/ jobs/ metrics/ limits/ boot/ files/` |
| `config.ts log.ts app.ts index.ts` | `app/config.py app/logging.py app/main.py` |
| `server/migrations/*.sql` | **done**: `app/db/migrations/` (identical bytes; never edit) |
| `server/test/**`, `shared/test/**` | `tests/**` (same sub-folders; `test/fixtures` → `tests/fixtures`) |

## Naming and style rules (so modules written in parallel fit together)

- File `fooBar.ts` → `foo_bar.py`. Function/variable `fooBarBaz` → `foo_bar_baz`. Class and type names stay
  `PascalCase`. Constants stay `UPPER_SNAKE`. Enum members stay `UPPER_SNAKE`; enum **values** (the wire strings) are unchanged.
- **Wire and storage JSON is unchanged**: keys stay `camelCase` in WebSocket messages, `events.payload`, `records.payload`,
  field candidates, the final record. Pydantic wire models use
  `model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)`; dump with `by_alias=True`. Python attribute
  names are `snake_case`. DB column names are already `snake_case` (migration `001_init.sql`).
- Domain values: `@dataclass(frozen=True, slots=True)`; wire messages and config: pydantic; JSON payloads that stay
  dicts: `dict[str, Any]` / `TypedDict`. No dataclass/pydantic mixing for the same concept.
- Options objects in TS become keyword-only arguments. TS `interface X { … }` implemented by several classes becomes a
  `typing.Protocol`. TS `Promise<T>` becomes `async def … -> T`. `null`/`undefined` → `None`.
- Dates: `datetime` with tzinfo (UTC from the DB). Serialize as ISO-8601 exactly as the TS did (read the TS tests).
- Errors: keep the TS error class names; carry the same fields. Do not swallow exceptions the TS did not.
- Logging: `structlog.get_logger()`; `log.info("event name", key=value)`. No `print`.
- Time and randomness are injected where the TS injected them (`Clock`, `now`, id generators) so tests stay deterministic.
- Canonical JSON and the content hash must be **identical** to the TS output (the record hash is part of the contract):
  sorted keys, same number formatting, same escaping. The golden files in `server/test/domain/golden/` and any hashes in
  TS tests are the oracle; copy them into `tests/fixtures` and assert equality.
- Type hints everywhere in `app/` (`from __future__ import annotations`). ruff clean (line length 120).

## Database layer (already written; use it)

```python
from app.db.pool import Database, create_database           # Database(pool=asyncpg.Pool, stats)
from app.db.tx import Queryable, Tx, transaction            # async with transaction(db.pool, snapshot=False) as tx:
```

`Queryable` has `fetch / fetchrow / fetchval / execute` (asyncpg API, `$1` placeholders); both `asyncpg.Pool` and `Tx`
satisfy it. Rows are `asyncpg.Record` (use `row["col"]`); repos convert them to dataclasses like the TS `rows.ts` does.
`jsonb` columns come back as Python objects and `uuid` columns as `str` (codecs are set on every connection); pass dicts
directly for `jsonb` parameters. `count(*)` returns `int`.

Test fixtures (`tests/conftest.py`): `db` (a `Database` on a fresh migrated schema, dropped afterwards), `schema`
(`TestSchema` with `.db`, `.url`, `.name`, `.open()`), `admin` (a raw connection to the test database),
`test_database_url`. Helper `tests.helpers.db.create_migrated_schema(url, label)` for per-module schemas.

## Ground rules for every agent

1. Work only inside your assigned directories (below). Other agents write the other directories at the same time. Import
   other modules by the names the rules above produce, even if they do not exist yet; if something you need is missing
   when you test, wait/ re-check rather than writing your own copy.
2. Port behaviour exactly. When the TS is odd, port it anyway and note it; do not "improve" semantics. Bug fixes that
   exist in the TS stay (they came from live calls).
3. Port **every** test case from the matching TS test files into `tests/…`. Same names (in snake_case), same assertions.
   Use the fakes and fixtures the TS tests used (ported into `tests/helpers/` or `app/voice/fakes/`).
4. Run your tests and ruff before finishing. Do not leave failing tests; if one cannot pass because a dependency from
   another agent is missing, say so precisely in your report.
5. **Do not run `git` commands that change anything** (no add/commit/checkout/reset/stash). The lead commits.
6. Do not edit `server/`, `web/`, `shared/`, `docs/`, `e2e/`, `scripts/`, `pyproject.toml` (ask in your report if you need a
   dependency), or other agents' directories.
7. Final report (short): files written, test count passing, any behaviour you could not port or changed, and the exact
   public names other modules will import from yours.

## Ownership

| Agent | Directories (src → tests) | Reads from TS |
|---|---|---|
| A protocol + domain | `app/protocol/`, `app/domain/` → `tests/protocol/`, `tests/domain/` | `shared/**`, `server/src/domain/**`, `server/test/domain/**`, `shared/test/**` |
| B repos + files + metrics | `app/db/repos/`, `app/files/`, `app/metrics/` → `tests/repos/`, `tests/files/`, `tests/metrics/` | `server/src/db/repos/**`, `files/**`, `metrics/**`, `util/**`, `server/test/repos/**`, `metrics/**` |
| C agent + voice | `app/agent/`, `app/voice/` → `tests/agent/`, `tests/voice/` | `server/src/agent/**`, `voice/**`, `server/test/agent/**`, `voice/**`, `server/test/fixtures/providers` |
| D session | `app/session/` → `tests/session/` | `server/src/session/**`, `server/test/session/**` |
| E transport and runtime | `app/ws/ app/api/ app/limits/ app/delivery/ app/jobs/ app/boot/ app/config.py app/logging.py app/main.py` → matching `tests/` | the matching `server/src/**` and `server/test/**` |

Phase 1 runs A, B, C together; phase 2 runs D and E once A and B exist.
