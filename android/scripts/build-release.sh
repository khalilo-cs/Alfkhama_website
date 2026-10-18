#!/usr/bin/env bash
# Builds the PRODUCTION apps. It refuses to run (and Gradle refuses too) unless you provide:
#   SERVER_ORIGIN               https://<your permanent domain>      (no path, no IP, no tunnel/preview host)
#   ANDROID_KEYSTORE_FILE       path to YOUR release keystore (never commit it)
#   ANDROID_KEYSTORE_PASSWORD, ANDROID_KEY_ALIAS, ANDROID_KEY_PASSWORD
# Output: ../artifacts/release/*.apk (side-loading / direct download) and *.aab (Google Play upload).
# ملف build-release.sh: يبني نسخة الإنتاج (APK للتوزيع المباشر وAAB لمتجر Google Play).
# نص الشرح أعلاه بالإنجليزية يسرد المتغيرات المطلوبة؛ كلها تأتي من البيئة ولا تُكتب في أي ملف.
# set -euo: يتوقف السكربت عند أي خطأ أو متغير غير معرّف.
set -euo pipefail
cd "$(dirname "$0")/.."
# التحقق المبكر من المتغيرات الإلزامية؛ الصيغة :? توقف السكربت برسالة إن كان المتغير فارغًا.
# حارس Gradle يعيد الفحص بتفصيل أكبر.
: "${SERVER_ORIGIN:?set SERVER_ORIGIN, e.g. https://your-domain.example}"
: "${ANDROID_KEYSTORE_FILE:?set ANDROID_KEYSTORE_FILE}"
: "${ANDROID_KEYSTORE_PASSWORD:?set ANDROID_KEYSTORE_PASSWORD}"
: "${ANDROID_KEY_ALIAS:?set ANDROID_KEY_ALIAS}"
: "${ANDROID_KEY_PASSWORD:?set ANDROID_KEY_PASSWORD}"
# تشغيل اختبارات الوحدة ثم بناء الإصدار الموقّع؛ تفشل المهام إن رفض حارس الإصدار العنوان أو
# التوقيع.
./gradlew --no-daemon -q :app:testDebugUnitTest :app:assembleRelease :app:bundleRelease
# نسخ الناتج إلى مجلد artifacts مع مجموع تحقق SHA-256 ليتأكد المستلم من سلامة الملف.
out=../artifacts/release
mkdir -p "$out"
cp app/build/outputs/apk/release/app-release.apk "$out/alfakhamah.apk"
cp app/build/outputs/bundle/release/app-release.aab "$out/alfakhamah.aab"
(cd "$out" && sha256sum *.apk *.aab | tee SHA256SUMS.txt)
# طباعة بصمات شهادة التوقيع (apksigner) لاستعمالها لاحقًا إن لزم ربط الموقع بالتطبيق.
echo "Signer certificate fingerprints (needed for Digital Asset Links only if you ever switch to a TWA):"
for f in "$out"/*.apk; do "${ANDROID_HOME:-$(sed -n 's/^sdk.dir=//p' local.properties)}"/build-tools/*/apksigner verify --print-certs "$f" | grep "SHA-256"; done
