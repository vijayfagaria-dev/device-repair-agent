#!/usr/bin/env bash
# Runs every curl example in the README's "API reference" against a server and fails when a status or a body
# differs from what the README documents (P12-T02). It also fails when the README stops mentioning an endpoint
# this script exercises, so the docs and the code can't drift apart silently.
#
#   scripts/check-api-examples.sh                          # http://localhost:8080
#   scripts/check-api-examples.sh https://<app>.onrender.com
#
# Needs only bash and curl. Optional, from the shell environment (never from arguments, never printed):
#   TEST_API_TOKEN  the server's test-API token, to also check the token-gated examples on a server that enables them
# The one session it creates is made by an upload (creating sessions is rate limited per IP: about 20 an hour),
# holds a 1x1 PNG, and expires like any other session.
set -u -o pipefail

BASE="${1:-http://localhost:8080}"
BASE="${BASE%/}"
README="$(cd "$(dirname "$0")/.." && pwd)/README.md"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

command -v curl >/dev/null || { echo "curl is required" >&2; exit 2; }
case "$BASE" in http://*|https://*) ;; *) echo "usage: $0 [http(s)://host[:port]]" >&2; exit 2 ;; esac
[ -f "$README" ] || { echo "README.md not found at $README" >&2; exit 2; }

failed=0
passed=0
pass() { passed=$((passed + 1)); echo "PASS  $1"; }
fail() { failed=$((failed + 1)); echo "FAIL  $1: $2"; }

uuid() {
  if command -v uuidgen >/dev/null; then uuidgen | tr 'A-Z' 'a-z'; else cat /proc/sys/kernel/random/uuid; fi
}

# (LC_ALL=C: a WebSocket frame isn't valid UTF-8, and grep would refuse to match it otherwise.)
# check <name> <expected status(es), e.g. "200" or "401|404"> <body must contain, or ""> <curl args...>
# The body of the last call is left in $WORK/body.
check() {
  local name="$1" expected="$2" contains="$3"
  shift 3
  local status
  # -m 3: the WebSocket examples never close by themselves; curl reports the status it saw before the timeout.
  status="$(curl -s -m 3 -o "$WORK/body" -w '%{http_code}' "$@" 2>/dev/null)"
  case "|$expected|" in
    *"|$status|"*) ;;
    *) fail "$name" "expected HTTP $expected, got $status"; return ;;
  esac
  if [ -n "$contains" ] && ! LC_ALL=C grep -aqF -- "$contains" "$WORK/body"; then
    fail "$name" "HTTP $status, but the body doesn't contain $contains"
    return
  fi
  pass "$name (HTTP $status)"
}

# documented <endpoint>: the README must list it (an endpoint this script exercises).
documented() {
  # The endpoint in backticks, as the table writes it, and followed by the closing backtick or a query string
  # (a bare substring would let "GET /a/b" be satisfied by a README that only mentions "GET /a/b/c").
  if grep -qF -- "\`$1\`" "$README" || grep -qF -- "\`$1?" "$README"; then pass "README documents $1"; else fail "README documents $1" "not found in README.md"; fi
}

# A fresh random handshake key (any 16 random bytes, base64) for the WebSocket examples.
WS_KEY="$(head -c 16 /dev/urandom | base64)"
SESSION="$(uuid)"
UNKNOWN="$(uuid)"
printf '\x89PNG\r\n\x1a\n\0\0\0\rIHDR\0\0\0\1\0\0\0\1\x08\x06\0\0\0\x1f\x15\xc4\x89' > "$WORK/pixel.png"
echo "not an image" > "$WORK/note.txt"

echo "== $BASE (session $SESSION)"

# Health
check "GET /healthz" 200 '"status":"ok"' "$BASE/healthz"
check "GET /readyz" 200 '"status":"ok"' "$BASE/readyz"

# Upload (also creates the session lazily)
check "POST /sessions/:sessionId/files (PNG)" 200 '"url":"file:' -X POST -F "file=@$WORK/pixel.png" "$BASE/sessions/$SESSION/files"
check "POST /sessions/:sessionId/files (text file)" 415 '"unsupported_type"' -X POST -F "file=@$WORK/note.txt" "$BASE/sessions/$SESSION/files"
check "POST /sessions/:sessionId/files (no file)" 400 '"bad_request"' -X POST "$BASE/sessions/$SESSION/files"

# Read API
check "GET /api/sessions/:id" 200 '"status":"active"' "$BASE/api/sessions/$SESSION"
check "GET /api/sessions/:id/timeline" 200 '"session.created"' "$BASE/api/sessions/$SESSION/timeline"
check "GET /api/sessions/:id/records" 200 '"records":[]' "$BASE/api/sessions/$SESSION/records"
check "GET /api/sessions/:id (unknown)" 404 '"not_found"' "$BASE/api/sessions/$UNKNOWN"
check "GET /api/sessions/:id (not a UUID)" 400 '"invalid_session_id"' "$BASE/api/sessions/not-a-uuid"

# Signed files
check "GET /files/:fileId (no signature)" 403 '"forbidden"' "$BASE/files/f7ZIrgocLlJQS_L26"
check "GET /files/:fileId (bad signature)" 403 '"forbidden"' "$BASE/files/f7ZIrgocLlJQS_L26?exp=1&sig=x"

# Record receiver (the stub that delivery POSTs to)
check "POST /hooks/records (no secret)" 401 '"unauthorized"' -X POST -H 'Content-Type: application/json' -d '{}' "$BASE/hooks/records"

# Test API: registered only where ALLOW_TEST_API=true. Without a token it answers 401 there and 404 where it is off.
check "POST /api/sessions (no token)" "401|404" "" -X POST "$BASE/api/sessions"

# WebSockets: the Origin check, seen through the upgrade (the server completes it only to say why it refuses)
check "WS /chat from a foreign Origin" 101 '"code":4403' -H 'Origin: https://evil.example' -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' -H "Sec-WebSocket-Key: $WS_KEY" --http1.1 -N "$BASE/chat?sessionId=$SESSION"
check "WS /call without a session id" 101 '"code":4400' -H "Origin: $BASE" -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
  -H 'Sec-WebSocket-Version: 13' -H "Sec-WebSocket-Key: $WS_KEY" --http1.1 -N "$BASE/call"

# Security headers on every response
HEADERS="$(curl -s -m 5 -D - -o /dev/null "$BASE/healthz" | tr -d '\r' | tr 'A-Z' 'a-z')"
for h in "content-security-policy: default-src 'none'" "x-content-type-options: nosniff" "referrer-policy: no-referrer"; do
  if printf '%s\n' "$HEADERS" | grep -qF -- "$h"; then pass "security header $h"; else fail "security header $h" "missing from GET /healthz"; fi
done

# Token-gated examples, only when the caller supplies the token
if [ -n "${TEST_API_TOKEN:-}" ]; then
  check "POST /api/sessions (token)" 201 '"sessionId"' -X POST -H "Authorization: Bearer $TEST_API_TOKEN" "$BASE/api/sessions"
  check "POST /api/sessions (wrong token)" 401 '"unauthorized"' -X POST -H "Authorization: Bearer wrong-$TEST_API_TOKEN" "$BASE/api/sessions"
  check "GET /hooks/records (token)" 200 '"records"' -H "Authorization: Bearer $TEST_API_TOKEN" "$BASE/hooks/records"
  check "POST /api/sessions/:id/finalize (no token)" 401 '"unauthorized"' -X POST "$BASE/api/sessions/$SESSION/finalize"
else
  echo "SKIP  token-gated examples (set TEST_API_TOKEN to run them)"
fi

# The README must still document each endpoint exercised above.
for endpoint in \
  "GET /healthz" "GET /readyz" "POST /sessions/:sessionId/files" "GET /api/sessions/:id" "GET /api/sessions/:id/timeline" \
  "GET /api/sessions/:id/records" "GET /files/:fileId" "POST /hooks/records" "GET /hooks/records" "POST /api/sessions" \
  "POST /api/sessions/:id/finalize" "WS /chat" "WS /call"; do
  documented "$endpoint"
done

echo
echo "$passed passed, $failed failed"
[ "$failed" -eq 0 ]
