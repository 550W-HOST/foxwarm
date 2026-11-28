#!/bin/sh
# Compose setup job, including upgrades of initialized volumes. The operator service
# never receives the database administrator credential used to enable its login.
set -eu
export PGPASSWORD="$(cat /run/secrets/postgres-password)"
export OPERATOR_PASSWORD="$(cat /run/secrets/operator-password)"
psql -X -h postgres -U postgres -d foxwarm -v ON_ERROR_STOP=1 <<'SQL'
\getenv operator_password OPERATOR_PASSWORD
ALTER ROLE foxwarm_operator LOGIN PASSWORD :'operator_password';
SQL
