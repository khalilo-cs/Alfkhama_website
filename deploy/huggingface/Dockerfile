# ---- ملف بناء الصورة على Hugging Face Spaces ----
# بديل لـ Dockerfile الجذر مناسب لبيئة Spaces: منفذ 7860 والمستخدم UID 1000 كما تشترط المنصة، وبلا حجم /data دائم.
# Hugging Face Space (Docker). Python standard library only, no build step.
FROM python:3.13-slim
# ---- المستخدم ومجلد العمل ----
# تتطلب Spaces تشغيل الحاوية بمستخدم UID 1000 غير root، ونعمل داخل مجلد بيته.
RUN useradd -m -u 1000 user
USER user
WORKDIR /home/user/app
# ---- نسخ ملفات التطبيق ----
# --chown يمنح المستخدم ملكية الملفات المنسوخة (لأننا لسنا root).
COPY --chown=user app.py persist.py seo.py pages.py legal.py totp.py index.html admin.html offline.html sw.js manifest.webmanifest admin-manifest.webmanifest ./
COPY --chown=user assets ./assets
COPY --chown=user icons ./icons
# ---- متغيرات البيئة والتشغيل ----
# The Space filesystem is temporary: data added after deploy is lost when the Space restarts.
ENV HOST=0.0.0.0 PORT=7860 DATA_DIR=/home/user/data TRUST_PROXY=1 LOG_FORMAT=json PYTHONUNBUFFERED=1
# المنفذ 7860 هو الذي تتوقعه Spaces. بخلاف الصورة الرئيسية لا نفعّل AUTO_BACKUP هنا لأن التخزين مؤقت.
EXPOSE 7860
# -I: وضع بايثون المعزول (يتجاهل متغيرات PYTHON* ومجلدات المستخدم).
CMD ["python3", "-I", "app.py"]
