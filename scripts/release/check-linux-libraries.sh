#!/usr/bin/env bash
# List every ELF file of an extracted Linux package with the newest glibc/libstdc++ symbol
# versions and the shared libraries it needs, and fail when any of them needs glibc newer than
# 2.34 or a shared library beyond the base C/C++ runtime. Release builds replace the LanceDB
# package's Linux library (glibc 2.39) with one built on 2.34 (build-lancedb.sh). ICU and OpenSSL are loaded at run time
# by .NET, not linked, so they do not appear here.
# Usage: scripts/release/check-linux-libraries.sh EXTRACTED_PACKAGE
set -euo pipefail
payload="${1:?Usage: check-linux-libraries.sh EXTRACTED_PACKAGE}"
payload="${payload%/}"
floor=2.34
allowed='^(libc|libm|libdl|libpthread|librt|libutil|libresolv|libgcc_s|libstdc\+\+|ld-linux-x86-64|libvips-cpp)\.so'

newer() { [ "$(printf '%s\n%s\n' "$1" "$2" | sort -V | tail -1)" != "$2" ]; }
status=0
while IFS= read -r -d '' file; do
  magic=""
  IFS= LC_ALL=C read -r -d '' -n 4 magic < "$file" || true
  [ "$magic" = $'\x7fELF' ] || continue
  name="${file#"$payload"/}"
  glibc="$(objdump -T "$file" 2>/dev/null | grep -o 'GLIBC_[0-9.]*' | sed 's/GLIBC_//' | sort -uV | tail -1 || true)"
  glibcxx="$(objdump -T "$file" 2>/dev/null | grep -o 'GLIBCXX_[0-9.]*' | sort -uV | tail -1 || true)"
  needed="$(readelf -d "$file" | sed -n 's/.*(NEEDED).*\[\(.*\)\]/\1/p' | tr '\n' ' ')"
  printf '%-70s glibc %-5s %-15s %s\n' "$name" "${glibc:--}" "${glibcxx:-}" "$needed"
  if [ -n "$glibc" ] && newer "$glibc" "$floor"; then
    echo "  $name needs glibc $glibc, newer than $floor" >&2; status=1
  fi
  for library in $needed; do
    [[ "$library" =~ $allowed ]] || { echo "  $name needs $library, which is not a base system library" >&2; status=1; }
  done
done < <(find "$payload" -type f -print0 | sort -z)
exit "$status"
