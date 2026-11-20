#!/usr/bin/env bash
# Sign only an unsigned release APK, and expose it to aggregation only after verification.
set -euo pipefail
if [ "$#" -ne 4 ]; then
  echo 'Usage: sign-android.sh INPUT_APK OUTPUT_APK KEYSTORE CERTIFICATE_SHA256_FILE' >&2
  exit 2
fi
: "${ANDROID_HOME:?Android SDK directory is required}"
: "${ANDROID_RELEASE_KEYSTORE_PASSWORD:?Release keystore password is required}"
input=$1 output=$2 keystore=$3 certificate=$4
build_tools="$ANDROID_HOME/build-tools/35.0.0"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
"$build_tools/zipalign" -P 16 -f 4 "$input" "$work/aligned.apk"
"$build_tools/apksigner" sign --ks "$keystore" --ks-type PKCS12 --ks-key-alias foxwarm \
  --ks-pass env:ANDROID_RELEASE_KEYSTORE_PASSWORD --key-pass env:ANDROID_RELEASE_KEYSTORE_PASSWORD \
  --out "$work/signed.apk" "$work/aligned.apk"
"$build_tools/apksigner" verify --print-certs "$work/signed.apk" | tee "$work/certificates.txt"
expected=$(tr -d ':[:space:]' < "$certificate" | tr '[:upper:]' '[:lower:]')
actual=$(sed -n 's/^Signer #[0-9][0-9]* certificate SHA-256 digest: //p' "$work/certificates.txt")
if [[ ! "$expected" =~ ^[0-9a-f]{64}$ ]] || [ "$actual" != "$expected" ]; then
  echo 'Android release signer certificate does not match the pinned SHA-256 fingerprint.' >&2
  exit 1
fi
mkdir -p "$(dirname "$output")"
cp "$work/signed.apk" "$output"
