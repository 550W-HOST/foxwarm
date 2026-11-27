#!/bin/sh
# Runs once, when the postgres image initializes an empty data directory. Creates the schema
# owner (runs `foxwarm db migrate`), the runtime role the replicas use (no superuser, no
# BYPASSRLS: row-level security applies to it), the operator role that owns tenant
# administration and the foxwarm
# database. The passwords are the ones in the database URL secrets.
set -eu
owner="$(cat /run/secrets/owner-password)"
app="$(cat /run/secrets/app-password)"
operator="$(cat /run/secrets/operator-password)"
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname postgres \
  -v owner="$owner" -v app="$app" -v operator="$operator" <<'SQL'
CREATE ROLE foxwarm_owner LOGIN PASSWORD :'owner';
CREATE ROLE foxwarm_app LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD :'app';
CREATE ROLE foxwarm_operator LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD :'operator';
CREATE DATABASE foxwarm OWNER foxwarm_owner;
SQL
