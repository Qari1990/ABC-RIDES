#!/usr/bin/env bash
# Signs the APK that GitHub Actions built (android/dist/abc-rides-unsigned.apk,
# which includes Firebase push) with the app's key, and publishes it as the
# download page's APK. Uses the same key as build.sh, so it installs over
# earlier versions.
#
#   git pull && android/sign-dist.sh
set -euo pipefail
cd "$(dirname "$0")"
KEYSTORE="${KEYSTORE:-debug.keystore}"
KEYSTORE_PASS="${KEYSTORE_PASS:-android}"
KEY_ALIAS="${KEY_ALIAS:-abcrides}"
IN=dist/abc-rides-unsigned.apk
[ -f "$IN" ] || { echo "No $IN yet: push a change under android/ and wait for the Android workflow"; exit 1; }
[ -f "$KEYSTORE" ] || { echo "Signing key $KEYSTORE not found"; exit 1; }
mkdir -p build
zipalign -f -p 4 "$IN" build/dist-aligned.apk
apksigner sign --ks "$KEYSTORE" --ks-pass "pass:$KEYSTORE_PASS" --ks-key-alias "$KEY_ALIAS" \
  --min-sdk-version "$(sed -n 's/^minSdk=//p' app.properties)" --out build/abc-rides-release.apk build/dist-aligned.apk
# Warnings about META-INF files are expected (v2/v3 signatures cover the whole file).
out=$(apksigner verify build/abc-rides-release.apk 2>&1) || { echo "$out"; exit 1; }
cp build/abc-rides-release.apk ../public/downloads/abc-rides.apk
# The app checks this to offer users the update.
printf '{"versionCode": %s, "versionName": "%s", "url": "downloads/abc-rides.apk"}\n' \
  "$(aapt dump badging build/abc-rides-release.apk | sed -n "s/.*versionCode='\([0-9]*\)'.*/\1/p")" \
  "$(aapt dump badging build/abc-rides-release.apk | sed -n "s/.*versionName='\([^']*\)'.*/\1/p")" > ../public/downloads/version.json
echo "==> Signed and published to public/downloads/abc-rides.apk"
