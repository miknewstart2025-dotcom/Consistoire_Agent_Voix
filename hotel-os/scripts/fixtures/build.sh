#!/usr/bin/env bash
# Regenerates apps/api/test/fixtures/*.apk. Needs: java 17+, network to Maven Central (apksig) the first time.
set -euo pipefail
cd "$(dirname "$0")"
OUT=../../apps/api/test/fixtures
[ -f apksig.jar ] || curl -sSfo apksig.jar https://repo1.maven.org/maven2/com/android/tools/build/apksig/2.3.0/apksig-2.3.0.jar
for k in hotel other; do
  [ -f $k.p12 ] || keytool -genkeypair -keystore $k.p12 -storetype PKCS12 -storepass fixture -keypass fixture -alias $k -keyalg RSA -keysize 2048 -validity 36500 -dname "CN=HOTEL OS $k test key" >/dev/null 2>&1
done
J="--add-exports java.base/sun.security.pkcs=ALL-UNNAMED --add-exports java.base/sun.security.x509=ALL-UNNAMED --add-exports java.base/sun.security.util=ALL-UNNAMED"
java $J -cp apksig.jar ApkFixtures.java $OUT/settings_apk-debug.apk $OUT/fixture-v91.apk 91 hotel.p12 hotel
java $J -cp apksig.jar ApkFixtures.java $OUT/settings_apk-debug.apk $OUT/fixture-v92.apk 92 hotel.p12 hotel
java $J -cp apksig.jar ApkFixtures.java $OUT/settings_apk-debug.apk $OUT/fixture-other-signer-v93.apk 93 other.p12 other
