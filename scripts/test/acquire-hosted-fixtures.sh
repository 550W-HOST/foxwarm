#!/usr/bin/env bash
# Downloads and extracts the disposable servers used by the hosted managed tests on Ubuntu 24.04
# (the CI runner image) and prints the variables that select them:
#   scripts/test/acquire-hosted-fixtures.sh <fixture-root>
#   FOXWARM_TEST_PG_PREFIX=<fixture-root>/postgresql      PostgreSQL 18 server, client, libpq
#   FOXWARM_TEST_VERSITYGW=<fixture-root>/versitygw/usr/bin/versitygw   S3-compatible gateway
# PostgreSQL packages come from the permanent PGDG archive, so a pinned version stays
# downloadable after newer minor releases. Every file is checked against its SHA-256 before
# extraction; an existing extracted prefix is reused.
set -euo pipefail

root=${1:?usage: acquire-hosted-fixtures.sh <fixture-root>}
pgdg=https://apt-archive.postgresql.org/pub/repos/apt/pool/main/p/postgresql-18
ubuntu=http://archive.ubuntu.com/ubuntu/pool/main
# The server's other libraries are those of the runner's preinstalled PostgreSQL 16. PostgreSQL
# 18 adds liburing2 and libnuma1, which the runner image lacks, so they come from Ubuntu 24.04,
# with libicu74, so the prefix also runs on hosts without ICU 74.
postgres=(
  "$pgdg/postgresql-18_18.7-1.pgdg24.04%2B2_amd64.deb 902e12bad8a7527199712b9f502b5ce14054289a8e138d1df9e85e86cecdaf1e"
  "$pgdg/postgresql-client-18_18.7-1.pgdg24.04%2B2_amd64.deb 2c102e1d6ab4ae0abf5bb1e55240feb2a2b7d81a2d0f78b29614611d88ed746e"
  "$pgdg/libpq5_18.7-1.pgdg24.04%2B2_amd64.deb c982d16d81c3dacba5b85797af37c5e6b34a73e20ddbbf41a61098276db53a3d"
  "$ubuntu/libu/liburing/liburing2_2.5-1build1_amd64.deb c2aef62accee92a06263c3ad4ef46132c13e409b54296c44792a20491830a7b0"
  "$ubuntu/n/numactl/libnuma1_2.0.18-1ubuntu0.24.04.1_amd64.deb f333b8edf6f0b705c19f2a67008194df66f7aab0fa2350dc98510569a033ff29"
  "$ubuntu/i/icu/libicu74_74.2-1ubuntu3.1_amd64.deb c9a70989678660eed9a1e904c74fa043da8bec8e2036856fc16e31ced79b04f8"
)
versitygw=(
  "https://github.com/versity/versitygw/releases/download/v1.11.0/versitygw_1.11.0_linux_amd64.deb 93210fa3fb055ef27a9d5910cba97d6eb8b5a409bbe59fb824ecc4a55242e9d3"
)

downloads=$(mktemp -d)
trap 'rm -rf "$downloads"' EXIT

# extract <prefix> <marker relative to prefix> <url sha>...
extract() {
  local prefix=$1 marker=$2
  shift 2
  if [ -x "$prefix/$marker" ]; then
    return
  fi
  local entry url sha file
  for entry in "$@"; do
    read -r url sha <<<"$entry"
    file="$downloads/${url##*/}"
    curl -fsSL --retry 3 -o "$file" "$url"
    echo "$sha  $file" | sha256sum -c --quiet -
  done
  rm -rf "$prefix.partial"
  mkdir -p "$prefix.partial"
  for entry in "$@"; do
    read -r url _ <<<"$entry"
    dpkg-deb -x "$downloads/${url##*/}" "$prefix.partial"
  done
  rm -rf "$prefix"
  mv "$prefix.partial" "$prefix"
}

extract "$root/postgresql" usr/lib/postgresql/18/bin/postgres "${postgres[@]}"
# Fail here, naming the library, rather than at the first test's initdb.
missing=$(LD_LIBRARY_PATH="$root/postgresql/usr/lib/x86_64-linux-gnu" \
  ldd "$root"/postgresql/usr/lib/postgresql/18/bin/{postgres,initdb,pg_ctl,psql} | grep 'not found' | sort -u || true)
if [ -n "$missing" ]; then
  echo "PostgreSQL fixture is missing shared libraries:" >&2
  echo "$missing" >&2
  exit 1
fi
extract "$root/versitygw" usr/bin/versitygw "${versitygw[@]}"
echo "FOXWARM_TEST_PG_PREFIX=$root/postgresql"
echo "FOXWARM_TEST_VERSITYGW=$root/versitygw/usr/bin/versitygw"
