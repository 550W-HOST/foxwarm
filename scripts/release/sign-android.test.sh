#!/usr/bin/env bash
# Exercise the production signer with an owned throwaway key and an unsigned APK.
set -euo pipefail
if [ "$#" -ne 1 ]; then
  echo 'Usage: sign-android.test.sh UNSIGNED_APK' >&2
  exit 2
fi
root=$(cd "$(dirname "$0")/../.." && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
export ANDROID_RELEASE_KEYSTORE_PASSWORD=throwaway-test-password
keytool -genkeypair -keystore "$work/test.p12" -storetype PKCS12 -alias foxwarm \
  -keyalg RSA -keysize 4096 -validity 1 -dname 'CN=Android signing fixture' \
  -storepass:env ANDROID_RELEASE_KEYSTORE_PASSWORD -keypass:env ANDROID_RELEASE_KEYSTORE_PASSWORD
keytool -exportcert -keystore "$work/test.p12" -alias foxwarm \
  -storepass:env ANDROID_RELEASE_KEYSTORE_PASSWORD -file "$work/certificate.der"
sha256sum "$work/certificate.der" | cut -d ' ' -f 1 > "$work/certificate.sha256"
bash "$root/scripts/release/sign-android.sh" "$1" "$work/accepted.apk" "$work/test.p12" "$work/certificate.sha256"
"$ANDROID_HOME/build-tools/35.0.0/apksigner" verify "$work/accepted.apk"
if bash "$root/scripts/release/sign-android.sh" "$1" "$work/rejected.apk" "$work/test.p12" \
    "$root/packages/android-node/release-certificate.sha256" > "$work/mismatch.log" 2>&1; then
  echo 'Signing unexpectedly accepted the wrong certificate.' >&2
  exit 1
fi
grep -F 'does not match the pinned SHA-256 fingerprint' "$work/mismatch.log"
test ! -e "$work/rejected.apk"
echo 'Android signing passed: verified throwaway signature; production pin rejected it before exposing an APK.'
