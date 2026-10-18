#!/usr/bin/env bash
# Builds the TEST (debug-signed) APK of the combined app and copies it to ../artifacts with a checksum.
# They contain no server address: the tester types one at first launch. NOT for production use.
# Requires JDK 17+ and an Android SDK (ANDROID_HOME or android/local.properties with sdk.dir).
# ملف build-test-apks.sh: يبني نسخة الاختبار التجريبية (توقيع debug) لتجربتها على جهاز أو
# محاكي.
# لا تحوي عنوان خادم مضمّنًا، لذا تطلب من المختبِر كتابته (انظر ALLOW_SERVER_OVERRIDE). لا
# تُستعمل للنشر.
set -euo pipefail
cd "$(dirname "$0")/.."
# تشغيل الاختبارات ثم البناء؛ حارس الإصدار لا يتدخل لأن البناء debug.
./gradlew --no-daemon -q :app:testDebugUnitTest :app:assembleDebug
out=../artifacts
mkdir -p "$out"
cp app/build/outputs/apk/debug/app-debug.apk "$out/alfakhamah-TEST.apk"
(cd "$out" && sha256sum alfakhamah-TEST.apk > SHA256SUMS.txt && cat SHA256SUMS.txt)
