#!/usr/bin/env bash
# Checks the local toolchain against the pinned versions. Reads nothing
# secret and changes nothing.
set -uo pipefail

cd "$(dirname "$0")/.."

EXPECTED_NODE="22.23.2"
EXPECTED_PNPM="12.4.1"
problems=0

ok() { printf '  ok    %s\n' "$1"; }
bad() { printf '  FAIL  %s\n' "$1"; problems=$((problems + 1)); }

echo "toolchain"
node_version="$(node --version 2>/dev/null | sed 's/^v//')"
if [ "$node_version" = "$EXPECTED_NODE" ]; then ok "node $node_version"; else bad "node ${node_version:-missing}, expected $EXPECTED_NODE"; fi

pnpm_version="$(pnpm --version 2>/dev/null)"
if [ "$pnpm_version" = "$EXPECTED_PNPM" ]; then ok "pnpm $pnpm_version"; else bad "pnpm ${pnpm_version:-missing}, expected $EXPECTED_PNPM"; fi

if docker version --format '{{.Server.Version}}' >/dev/null 2>&1; then
  ok "docker $(docker version --format '{{.Server.Version}}')"
else
  bad "docker daemon not reachable"
fi

if docker-compose version >/dev/null 2>&1; then
  ok "$(docker-compose version | head -n 1)"
else
  bad "docker-compose plugin missing"
fi

echo "project"
if [ -d node_modules ]; then ok "dependencies installed"; else bad "run: pnpm install --frozen-lockfile"; fi

if [ -f .env ]; then
  for name in DATABASE_URL XRPL_PRIMARY_URL XRPL_SECONDARY_URL; do
    if grep -Eq "^${name}=.+" .env; then ok ".env sets $name"; else bad ".env lacks $name"; fi
  done
else
  printf '  info  no .env (only needed for pnpm start; tests and compose do not use it)\n'
fi

if docker-compose ps --status running --services 2>/dev/null | grep -qx postgres; then
  ok "postgres container running"
else
  printf '  info  postgres not running (docker-compose up -d postgres)\n'
fi

if [ "$problems" -gt 0 ]; then
  echo "$problems problem(s) found"
  exit 1
fi
echo "all good"
