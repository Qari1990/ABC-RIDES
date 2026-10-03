#!/usr/bin/env bash
# Builds and signs the ABC Rides Android app (a WebView shell) without Gradle
# or the full Android SDK, using the tools Ubuntu/Debian package:
#
#   sudo apt-get install aapt dalvik-exchange zipalign apksigner android-sdk-platform-23 default-jdk-headless
#
# Usage:  android/build.sh [default-server-url]
#   e.g.  android/build.sh https://abc-rides.onrender.com
# Without a URL, defaultServer from app.properties is used; pass "" to make
# the app ask for the server on first launch.
#
# Output: android/build/abc-rides.apk
# Version numbers live in app.properties. For a Play Store bundle (.aab) use
# the GitHub Actions workflow (.github/workflows/android.yml) instead.
# Signing uses android/debug.keystore (created on first run). For Play Store
# releases, set KEYSTORE / KEYSTORE_PASS / KEY_ALIAS to your release key.
set -euo pipefail

cd "$(dirname "$0")"
ANDROID_JAR="${ANDROID_JAR:-/usr/lib/android-sdk/platforms/android-23/android.jar}"
prop() { sed -n "s/^$1=//p" app.properties; }
APP_ID=$(prop applicationId)
DEFAULT_SERVER="${1-${DEFAULT_SERVER_URL-$(prop defaultServer)}}"
KEYSTORE="${KEYSTORE:-debug.keystore}"
KEYSTORE_PASS="${KEYSTORE_PASS:-android}"
KEY_ALIAS="${KEY_ALIAS:-abcrides}"
OUT=build

for tool in aapt javac dalvik-exchange zipalign apksigner keytool; do
  command -v "$tool" >/dev/null || { echo "Missing $tool (see the header of this script)"; exit 1; }
done
[ -f "$ANDROID_JAR" ] || { echo "android.jar not found at $ANDROID_JAR"; exit 1; }

rm -rf "$OUT"
mkdir -p "$OUT/gen/pk/abcrides/app" "$OUT/classes"

# Build-time configuration, escaped for a Java string literal.
SERVER_JAVA=$(printf '%s' "$DEFAULT_SERVER" | sed 's/\\/\\\\/g; s/"/\\"/g; s:/*$::')
cat > "$OUT/gen/pk/abcrides/app/BuildConfig.java" <<JAVA
package pk.abcrides.app;

public final class BuildConfig {
    public static final String DEFAULT_SERVER = "$SERVER_JAVA";
}
JAVA

# The source manifest has no package or version (Gradle style); add them.
sed "s|<manifest xmlns:android=\"http://schemas.android.com/apk/res/android\">|<manifest xmlns:android=\"http://schemas.android.com/apk/res/android\" package=\"$APP_ID\" android:versionCode=\"$(prop versionCode)\" android:versionName=\"$(prop versionName)\"><uses-sdk android:minSdkVersion=\"$(prop minSdk)\" android:targetSdkVersion=\"$(prop targetSdk)\" />|" \
  AndroidManifest.xml | grep -v 'android:roundIcon=' > "$OUT/AndroidManifest.xml"  # roundIcon needs API 25+, newer than our android.jar
grep -q 'package=' "$OUT/AndroidManifest.xml" || { echo "Could not prepare the manifest"; exit 1; }

echo "==> Generating R.java"
aapt package -f -m -J "$OUT/gen" -M "$OUT/AndroidManifest.xml" -S res -I "$ANDROID_JAR"

echo "==> Compiling Java"
javac -nowarn --release 8 -Xlint:-options -encoding UTF-8 -classpath "$ANDROID_JAR" -d "$OUT/classes" \
  $(find src "$OUT/gen" -name '*.java')

echo "==> Converting to dex"
dalvik-exchange --dex --min-sdk-version="$(prop minSdk)" --output="$OUT/classes.dex" "$OUT/classes"

echo "==> Packaging"
aapt package -f -0 arsc -M "$OUT/AndroidManifest.xml" -S res -A assets -I "$ANDROID_JAR" -F "$OUT/unsigned.apk"
(cd "$OUT" && aapt add -f unsigned.apk classes.dex >/dev/null)
zipalign -f -p 4 "$OUT/unsigned.apk" "$OUT/aligned.apk"

if [ ! -f "$KEYSTORE" ]; then
  echo "==> Creating signing key $KEYSTORE"
  keytool -genkeypair -keystore "$KEYSTORE" -storepass "$KEYSTORE_PASS" -keypass "$KEYSTORE_PASS" \
    -alias "$KEY_ALIAS" -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=ABC Rides, O=ABC Rides, C=PK" 2>/dev/null
fi

echo "==> Signing"
apksigner sign --ks "$KEYSTORE" --ks-pass "pass:$KEYSTORE_PASS" --ks-key-alias "$KEY_ALIAS" \
  --min-sdk-version "$(prop minSdk)" --out "$OUT/abc-rides.apk" "$OUT/aligned.apk"
apksigner verify "$OUT/abc-rides.apk"

echo "==> Built $(pwd)/$OUT/abc-rides.apk${DEFAULT_SERVER:+ (server: $DEFAULT_SERVER)}"
