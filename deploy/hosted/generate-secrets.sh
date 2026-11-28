#!/bin/sh
# Writes the secrets of the Compose stack into a new directory: the database passwords and the
# URLs that carry them, the key-encryption key and the S3 credentials. The directory is 0700;
# the files are readable inside it so the containers' fixed users (uid 1000 for Foxwarm) can read
# their bind-mounted copies. Keep the KEK: without it the tenant's encrypted data can't be opened.
#
#   deploy/hosted/generate-secrets.sh deploy/hosted/secrets
set -eu
random_hex() { od -An -tx1 -N "$1" /dev/urandom | tr -d ' \n'; }
if [ "${1:-}" = --operator ]; then
  dir="${2:?usage: generate-secrets.sh --operator <existing directory>}"
  test -f "$dir/kek.json" && test -f "$dir/postgres-password" || { echo 'Generate the base secrets first.' >&2; exit 1; }
  set -C
  umask 022
  if [ -f "$dir/operator-password" ] && [ -f "$dir/operator-database-url" ]; then
    : # Upgrade an existing operator without replacing its database credentials.
  elif [ ! -e "$dir/operator-password" ] && [ ! -e "$dir/operator-database-url" ]; then
    operator="$(random_hex 24)"
    printf '%s' "$operator" > "$dir/operator-password"
    printf 'postgres://foxwarm_operator:%s@postgres:5432/foxwarm\n' "$operator" > "$dir/operator-database-url"
  else
    echo 'Incomplete operator database credentials.' >&2; exit 1
  fi
  if [ -f "$dir/operator-s3-access-key-id" ] && [ -f "$dir/operator-s3-secret-access-key" ]; then
    :
  elif [ ! -e "$dir/operator-s3-access-key-id" ] && [ ! -e "$dir/operator-s3-secret-access-key" ]; then
    printf '%s' 'foxwarm-operator-delete' > "$dir/operator-s3-access-key-id"
    random_hex 24 > "$dir/operator-s3-secret-access-key"
  else
    echo 'Incomplete operator S3 credentials.' >&2; exit 1
  fi
  if [ ! -e "$dir/mesh-secret" ]; then
    head -c 32 /dev/urandom | base64 > "$dir/mesh-secret"
  fi
  exit 0
fi
dir="${1:?usage: generate-secrets.sh <new directory>}"
if [ -e "$dir" ]; then
  echo "$dir exists; refusing to overwrite secrets." >&2
  exit 1
fi
umask 077
mkdir -p "$dir"
umask 022
owner="$(random_hex 24)"
app="$(random_hex 24)"
random_hex 24 > "$dir/postgres-password"
printf '%s' "$owner" > "$dir/owner-password"
printf '%s' "$app" > "$dir/app-password"
printf 'postgres://foxwarm_app:%s@postgres:5432/foxwarm\n' "$app" > "$dir/database-url"
printf 'postgres://foxwarm_owner:%s@postgres:5432/foxwarm\n' "$owner" > "$dir/migrate-database-url"
# The instance key file format: {"version": 1, "keyId": <16 hex>, "key": <32 bytes, base64>}.
key="$(head -c 32 /dev/urandom | base64 | tr -d '\n')"
printf '{"version":1,"keyId":"%s","key":"%s"}\n' "$(random_hex 8)" "$key" > "$dir/kek.json"
printf 'fw%s' "$(random_hex 8)" > "$dir/s3-access-key-id"
random_hex 20 > "$dir/s3-secret-access-key"
head -c 32 /dev/urandom | base64 > "$dir/mesh-secret"
chmod 0644 "$dir"/*
sh "$0" --operator "$dir"
echo "Wrote the secrets to $dir."
