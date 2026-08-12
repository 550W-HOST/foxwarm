#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DOCKER=(docker)
if ! docker info >/dev/null 2>&1; then
  if sudo -n docker info >/dev/null 2>&1; then DOCKER=(sudo -n docker); else echo 'Docker access is required.' >&2; exit 1; fi
fi
PROJECT="foxwarm-pg-journal-$PPID-$$"
DATA_DIR="$(mktemp -d "${TMPDIR:-/tmp}/foxwarm-pg-journal.XXXXXX")"
PORT="$(node -e "const n=require('net').createServer();n.listen(0,'127.0.0.1',()=>{console.log(n.address().port);n.close()})")"
CONTAINER="${PROJECT}-postgres"
cleanup() {
  "${DOCKER[@]}" rm -f "$CONTAINER" >/dev/null 2>&1 || true
  rm -rf "$DATA_DIR"
}
trap cleanup EXIT INT TERM

"${DOCKER[@]}" run -d --name "$CONTAINER" \
  -e POSTGRES_USER=foxwarm_test -e POSTGRES_PASSWORD=foxwarm_test_password -e POSTGRES_DB=foxwarm_test \
  -p "127.0.0.1:${PORT}:5432" postgres:16-alpine >/dev/null
for _ in $(seq 1 60); do
  if "${DOCKER[@]}" exec "$CONTAINER" pg_isready -U foxwarm_test -d foxwarm_test >/dev/null 2>&1; then break; fi
  sleep 1
done
"${DOCKER[@]}" exec "$CONTAINER" pg_isready -U foxwarm_test -d foxwarm_test >/dev/null
cat > "$DATA_DIR/config.yaml" <<YAML
storage:
  llmRequestJournal:
    backend: postgres
    connectionStringEnv: FOXWARM_POSTGRES_JOURNAL_TEST_URL
    schema: foxwarm_journal_integration
    poolMax: 1
    connectTimeoutMs: 5000
    idleTimeoutMs: 1000
YAML
export FOXWARM_DATA_DIR="$DATA_DIR"
export FOXWARM_CONFIG_PATH="$DATA_DIR/config.yaml"
export FOXWARM_POSTGRES_JOURNAL_TEST_URL="postgres://foxwarm_test:foxwarm_test_password@127.0.0.1:${PORT}/foxwarm_test"
export FOXWARM_POSTGRES_JOURNAL_TEST_SCHEMA="foxwarm_journal_integration"
cd "$ROOT"
npm run build
node --test lib/llmRequestJournal.test.js
node --test lib/llmRequestJournalPostgres.integration.test.js
