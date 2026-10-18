# ---- ملف بناء الصورة (Docker) للتشغيل الإنتاجي ----
# يحزم الخادم (app.py وملفاته المساندة) والواجهات الثابتة في صورة واحدة. تستخدمه Render عبر render.yaml،
# ويستخدمه docker-compose.yml. لا يحتاج مكتبات خارجية لأن الخادم يعتمد على مكتبة بايثون القياسية فقط.

# Production image: Python standard library only, no build step.
FROM python:3.13-slim
# ---- المستخدم والمجلدات ----
# ننشئ مستخدمًا عاديًا (UID 10001) لتشغيل الخادم بدل root، فيقل الضرر لو اخترق أحدهم العملية.
# مجلد /data هو مكان قاعدة البيانات والصور والنسخ الاحتياطية، ونمنح المستخدم ملكيته ليستطيع الكتابة فيه.
RUN useradd --create-home --uid 10001 app && mkdir /data && chown app /data
# ---- نسخ ملفات التطبيق ----
# ننسخ فقط الملفات اللازمة للتشغيل؛ ما عداها (الاختبارات، أندرويد، التوثيق) مستبعد أيضًا في .dockerignore.
WORKDIR /srv/app
COPY app.py persist.py seo.py pages.py legal.py totp.py index.html admin.html offline.html sw.js manifest.webmanifest admin-manifest.webmanifest ./
COPY assets ./assets
COPY icons ./icons
# ---- متغيرات البيئة الافتراضية ----
# Behind the bundled Caddy proxy (docker-compose.yml): trust X-Forwarded-*, write JSON logs, back up daily.
ENV HOST=0.0.0.0 PORT=4173 DATA_DIR=/data TRUST_PROXY=1 LOG_FORMAT=json AUTO_BACKUP=1 PYTHONUNBUFFERED=1
# ---- التخزين والمنفذ وفحص الصحة ----
# VOLUME يجعل /data قابلًا للربط بقرص دائم كي لا تضيع البيانات عند إعادة إنشاء الحاوية.
VOLUME /data
# نتخلى عن صلاحيات root من هنا فصاعدًا.
USER app
EXPOSE 4173
# فحص صحة: كل 30 ثانية يطلب /api/health داخل الحاوية (بمكتبة بايثون القياسية دون curl)، ويعتبر الحاوية سليمة عند الرد 200.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD python3 -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:4173/api/health', timeout=4).status == 200 else 1)"
# ---- أمر التشغيل ----
# الخيار -I (الوضع المعزول) يتجاهل متغيرات PYTHON* ومجلدات المستخدم، فلا يُحمَّل كود غير مقصود.
CMD ["python3", "-I", "app.py"]
