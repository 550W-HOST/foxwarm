#!/usr/bin/env bash
# Downloads and extracts the disposable PostgreSQL server used by the hosted (Backend=postgres)
# managed tests on Ubuntu 24.04 (the CI runner image), then prints the variable that selects it.
#   scripts/test/acquire-hosted-fixtures.sh <prefix-directory>
# Packages come from the permanent PGDG archive, so a pinned version stays downloadable after
# newer minor releases; every file is checked against its SHA-256 before extraction.
set -euo pipefail

prefix=${1:?usage: acquire-hosted-fixtures.sh <prefix-directory>}
archive=https://apt-archive.postgresql.org/pub/repos/apt/pool/main/p/postgresql-18
packages=(
  "postgresql-18_18.7-1.pgdg24.04%2B2_amd64.deb 902e12bad8a7527199712b9f502b5ce14054289a8e138d1df9e85e86cecdaf1e"
  "postgresql-client-18_18.7-1.pgdg24.04%2B2_amd64.deb 2c102e1d6ab4ae0abf5bb1e55240feb2a2b7d81a2d0f78b29614611d88ed746e"
  "libpq5_18.7-1.pgdg24.04%2B2_amd64.deb c982d16d81c3dacba5b85797af37c5e6b34a73e20ddbbf41a61098276db53a3d"
)

if [ -x "$prefix/usr/lib/postgresql/18/bin/postgres" ]; then
  echo "FOXWARM_TEST_PG_PREFIX=$prefix"
  exit 0
fi
downloads=$(mktemp -d)
trap 'rm -rf "$downloads"' EXIT
for entry in "${packages[@]}"; do
  read -r file sha <<<"$entry"
  curl -fsSL --retry 3 -o "$downloads/$file" "$archive/$file"
  echo "$sha  $downloads/$file" | sha256sum -c --quiet -
done
staging="$prefix.partial"
rm -rf "$staging"
mkdir -p "$staging"
for entry in "${packages[@]}"; do
  read -r file _ <<<"$entry"
  dpkg-deb -x "$downloads/$file" "$staging"
done
rm -rf "$prefix"
mv "$staging" "$prefix"
echo "FOXWARM_TEST_PG_PREFIX=$prefix"
