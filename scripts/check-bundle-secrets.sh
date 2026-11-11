#!/usr/bin/env bash
# Fails if the built web bundle (or any directory given) contains something that looks like a secret (P9-T05, MH6).
# The browser only ever talks to our own origin, so no key, token, connection string or secret variable name may be in it.
# Output names the file and the rule, never the matching text (it may be a real secret).
#
#   scripts/check-bundle-secrets.sh [dir]            default: web/dist
#   SECRETS_FILE=server/.env scripts/check-bundle-secrets.sh   also looks for each value in that env file, literally
set -euo pipefail

dir="${1:-web/dist}"
if [ ! -d "$dir" ]; then
  echo "check-bundle-secrets: no such directory: $dir" >&2
  exit 2
fi

status=0
fail() {
  echo "LEAK ($1): $2" >&2
  status=1
}

# Rule name | extended regex. Keys of the providers in use, bearer credentials, connection strings, private keys, and the
# names of the server-only variables (they appear in a bundle only if config was inlined into it).
rules=(
  "groq key|gsk_[A-Za-z0-9]{20,}"
  "google api key|AIza[0-9A-Za-z_-]{30,}"
  "openai-style key|sk-[A-Za-z0-9_-]{20,}"
  "bearer token|[Bb]earer [A-Za-z0-9._~+/=-]{20,}"
  "database url|postgres(ql)?://[^\"' ]+@"
  "private key|-----BEGIN [A-Z ]*PRIVATE KEY-----"
  "server secret name|(DEEPGRAM_API_KEY|GROQ_API_KEY|GEMINI_API_KEY|DATABASE_URL|FILE_URL_SECRET|HOOK_SECRET|TEST_API_TOKEN|QUOTA_OVERRIDE_TOKEN)"
  "hook secret header|[Xx]-[Hh]ook-[Ss]ecret"
)
for rule in "${rules[@]}"; do
  name="${rule%%|*}"
  pattern="${rule#*|}"
  while IFS= read -r file; do
    fail "$name" "$file"
  done < <(grep -rIlE -e "$pattern" "$dir" 2>/dev/null || true)
done

# The real values from an env file, if one is given (a local check on a developer machine).
if [ -n "${SECRETS_FILE:-}" ] && [ -f "$SECRETS_FILE" ]; then
  while IFS='=' read -r key value; do
    # Only the variables that hold secrets (PUBLIC_ORIGIN, ports and the like are meant to be public).
    case "$key" in
      *_KEY|*_SECRET|*_TOKEN|DATABASE_URL|RECORD_WEBHOOK_URL) ;;
      *) continue ;;
    esac
    value="${value%\"}"; value="${value#\"}"
    [ "${#value}" -ge 12 ] || continue
    while IFS= read -r file; do
      fail "value of $key" "$file"
    done < <(grep -rIlF -e "$value" "$dir" 2>/dev/null || true)
  done < "$SECRETS_FILE"
fi

if [ "$status" -eq 0 ]; then
  echo "check-bundle-secrets: $dir is clean"
fi
exit "$status"
