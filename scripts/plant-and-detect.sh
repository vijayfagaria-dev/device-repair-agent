#!/usr/bin/env bash
# Plant-and-detect (P10-T02, MH6): proves the secret scanners can fail. A scan that passes is only worth something if the
# same scan fails on a planted secret, so this plants fake keys, built at run time (the literals would be flagged in this
# very file), in a throwaway repo directory and in a fake bundle, and requires both scanners to catch them, and to pass
# when nothing is planted.
#
#   GITLEAKS=./gitleaks scripts/plant-and-detect.sh
set -euo pipefail

gitleaks="${GITLEAKS:-gitleaks}"
here="$(cd "$(dirname "$0")" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

random() { LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom | head -c "$1" || true; }
# Shaped like a Groq key and an AWS access key id: both are well-known gitleaks rules.
groq_key="gsk_$(random 52)"
aws_key="AKIA$(random 16 | tr 'a-z' 'A-Z')"

fail=0
expect() { # expect <pass|fail> <description> <command...>
  local want="$1" what="$2"
  shift 2
  if "$@" >/dev/null 2>&1; then got=pass; else got=fail; fi
  if [ "$got" = "$want" ]; then echo "ok   $what ($got, as expected)"; else echo "FAIL $what: wanted $want, got $got" >&2; fail=1; fi
}

# 1. gitleaks on a source tree.
mkdir -p "$work/repo"
echo 'export const greeting = "hello";' >"$work/repo/clean.ts"
expect pass "gitleaks passes a clean tree" "$gitleaks" dir --no-banner --exit-code 1 "$work/repo"
printf 'const key = "%s";\nconst aws = "%s";\n' "$groq_key" "$aws_key" >"$work/repo/planted.ts"
expect fail "gitleaks fails on a planted key in the repo" "$gitleaks" dir --no-banner --exit-code 1 "$work/repo"

# 2. the bundle scan on a built-looking directory.
mkdir -p "$work/dist/assets"
echo 'console.log("app");' >"$work/dist/assets/app.js"
expect pass "bundle scan passes a clean bundle" "$here/check-bundle-secrets.sh" "$work/dist"
printf 'var k="%s";\n' "$groq_key" >"$work/dist/assets/app.js"
expect fail "bundle scan fails on a planted key in web/dist" "$here/check-bundle-secrets.sh" "$work/dist"
printf 'var url="postgresql://user:%s@db.example.com/app";\n' "$(random 16)" >"$work/dist/assets/app.js"
expect fail "bundle scan fails on a planted database URL in web/dist" "$here/check-bundle-secrets.sh" "$work/dist"

exit "$fail"
