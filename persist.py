"""حفظ دائم للبيانات خارج الحاوية: نسخة لقطة من store.db والصور المرفوعة إلى أي تخزين متوافق مع S3.

لماذا هذا الملف؟
  على خطة Render المجانية يُمسح قرص الحاوية عند كل إيقاف أو إعادة نشر، فتضيع قاعدة البيانات والصور.
  هنا نرسل نسخة من البيانات إلى مخزن خارجي (Cloudflare R2 أو Backblaze B2 أو AWS S3 أو MinIO)،
  ونعيدها تلقائيًا عند الإقلاع إذا كانت الحاوية فارغة. كل شيء يُضبط بمتغيرات البيئة فقط.

Why this module (English summary): on Render's free plan the container filesystem is ephemeral. This module
snapshots store.db (sqlite backup API, gzip, immutable objects) and uploads/ to any S3-compatible bucket and
restores them at startup when the local state is missing or a pristine seed. Standard library only; AWS
Signature V4 is implemented by hand. Disabled (a no-op) unless every BACKUP_S3_* variable is set.

متغيرات البيئة / Environment:
  BACKUP_S3_ENDPOINT   https://<account>.r2.cloudflarestorage.com  (path-style؛ http مسموح لـ localhost فقط)
  BACKUP_S3_BUCKET     اسم الحاوية (يجب أن تكون خاصة Private)
  BACKUP_S3_ACCESS_KEY / BACKUP_S3_SECRET_KEY   مفتاح مقيّد بهذه الحاوية فقط
  BACKUP_S3_REGION     الافتراضي auto
  BACKUP_S3_PREFIX     الافتراضي alfakhama/
  BACKUP_INTERVAL      ثوانٍ بين اللقطات عند وجود تغيير مهم (الافتراضي 120)
  BACKUP_ANALYTICS_INTERVAL  أدنى فاصل للقطات تغيّرت فيها الزيارات فقط (الافتراضي 600)
"""
# ---- الاستيرادات: مكتبة بايثون القياسية فقط (لا حزم خارجية) ----
from __future__ import annotations

import gzip
import hashlib
import hmac
import http.client
import json
import os
import random
import re
import shutil
import sqlite3
import ssl
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path

# ---- الثوابت والحدود ----
KEEP_SNAPSHOTS = 5                       # عدد اللقطات القديمة المحفوظة (الأحدث)
LATEST_KEY = "latest.json"
DB_PREFIX = "db/"
UPLOADS_PREFIX = "uploads/"
# اسم لقطة القاعدة: وقت UTC ثم أول 16 خانة من SHA-256 للملف المضغوط. أي مفتاح بغير هذا الشكل يُتجاهل.
DB_KEY_RE = re.compile(r"db/(\d{8}T\d{6}Z)-([0-9a-f]{16})\.db\.gz")
# يقرأ حدًا بالميجابايت من متغير بيئة ويحوّله إلى بايت؛ القيمة الفارغة أو غير الرقمية ترجع للافتراضي.
def _mb_env(name: str, default_mb: int) -> int:
    try:
        return max(1, int(os.environ.get(name, "").strip() or default_mb)) * 1024 ** 2
    except ValueError:
        return default_mb * 1024 ** 2


# حاوية Render المجانية صغيرة (قرص وذاكرة محدودان)، فالسقوف منخفضة وقابلة للتعديل من البيئة.
MAX_DB_GZ_BYTES = _mb_env("BACKUP_MAX_DB_GZ_MB", 256)     # سقف حجم الملف المضغوط المحمَّل
MAX_DB_RAW_BYTES = _mb_env("BACKUP_MAX_DB_RAW_MB", 1024)  # سقف القاعدة بعد فك الضغط (حماية من قنابل الضغط)
MIN_FREE_DISK = 64 * 1024 ** 2           # أقل مساحة حرة نتركها على القرص أثناء الاستعادة
MAX_UPLOAD_BYTES = 20 * 1024 ** 2        # سقف حجم صورة واحدة عند الاستعادة
MAX_LIST_BYTES = 8 * 1024 ** 2           # سقف رد قائمة الكائنات
LOOPBACK_HOSTS = ("127.0.0.1", "localhost", "::1", "[::1]")
EMPTY_SHA256 = hashlib.sha256(b"").hexdigest()
# الاحتفاظ بلقطات القاعدة: أحدث 5 + واحدة لكل ساعة خلال 24 ساعة + واحدة لكل يوم خلال 14 يومًا (للرجوع عن خطأ قديم).
KEEP_HOURLY_FOR = 24 * 3600
KEEP_DAILY_FOR = 14 * 24 * 3600
REQUIRED_TABLES = {"settings", "admins", "categories", "products", "orders", "order_items"}


# الوقت الحالي بتوقيت UTC (دالة مستقلة ليسهل استبدالها في الاختبارات).
def utc_now() -> datetime:
    return datetime.now(timezone.utc)


# تسجيل افتراضي على stdout (يظهر في سجلات Render)؛ flush حتى لا تتأخر الرسائل.
def default_log(message: str) -> None:
    print(f"[persist] {message}", flush=True)


# ------------------------------------------------------------------------------------------------------------------
# AWS Signature Version 4 (يدويًا بالمكتبة القياسية)
# ------------------------------------------------------------------------------------------------------------------
# HMAC-SHA256 مساعد لسلسلة اشتقاق مفتاح التوقيع.
def _hmac(key: bytes, message: str) -> bytes:
    return hmac.new(key, message.encode("utf-8"), hashlib.sha256).digest()


def uri_encode(value: str, keep_slash: bool = False) -> str:
    """ترميز URI كما تطلبه AWS: كل شيء عدا A-Za-z0-9 - _ . ~ (والشرطة المائلة في المسار فقط)."""
    return urllib.parse.quote(value, safe="/-_.~" if keep_slash else "-_.~")


# السلسلة القانونية للاستعلام: الأزواج مرمّزة ومرتبة أبجديًا، وهذا شرط ليتطابق التوقيع مع ما يحسبه الخادم.
def canonical_query(params: dict[str, str] | None) -> str:
    pairs = sorted((uri_encode(str(k)), uri_encode(str(v))) for k, v in (params or {}).items())
    return "&".join(f"{k}={v}" for k, v in pairs)


# اشتقاق مفتاح التوقيع من السر: HMAC متسلسل على (التاريخ، المنطقة، الخدمة، aws4_request).
def signing_key(secret_key: str, datestamp: str, region: str, service: str = "s3") -> bytes:
    key = _hmac(("AWS4" + secret_key).encode("utf-8"), datestamp)
    for part in (region, service, "aws4_request"):
        key = _hmac(key, part)
    return key


# بناء توقيع SigV4: الطلب القانوني -> سلسلة للتوقيع -> HMAC. أي اختلاف بسيط في الترتيب يجعل المخزن يرفض الطلب.
def sign_request(method: str, host: str, path: str, query: dict[str, str] | None, headers: dict[str, str] | None,
                 payload_hash: str, access_key: str, secret_key: str, region: str, when: datetime,
                 service: str = "s3") -> dict[str, str]:
    """يحسب ترويسة Authorization ويعيد كل الترويسات الواجب إرسالها (host و x-amz-date و x-amz-content-sha256 ...).
    `path` مسار غير مُرمَّز ويبدأ بـ "/". الترويسات تُوقَّع كلها بأسمائها الصغيرة."""
    amz_date = when.strftime("%Y%m%dT%H%M%SZ")
    datestamp = amz_date[:8]
    signed: dict[str, str] = {"host": host, "x-amz-content-sha256": payload_hash, "x-amz-date": amz_date}
    for name, value in (headers or {}).items():
        signed[name.lower()] = " ".join(str(value).split())
    names = sorted(signed)
    canonical = "\n".join([method.upper(), uri_encode(path, keep_slash=True), canonical_query(query),
                           "".join(f"{n}:{signed[n]}\n" for n in names), ";".join(names), payload_hash])
    scope = f"{datestamp}/{region}/{service}/aws4_request"
    to_sign = "\n".join(["AWS4-HMAC-SHA256", amz_date, scope, hashlib.sha256(canonical.encode("utf-8")).hexdigest()])
    signature = hmac.new(signing_key(secret_key, datestamp, region, service), to_sign.encode("utf-8"), hashlib.sha256).hexdigest()
    out = dict(signed)
    out["authorization"] = (f"AWS4-HMAC-SHA256 Credential={access_key}/{scope},SignedHeaders={';'.join(names)},"
                            f"Signature={signature}")
    return out


# ------------------------------------------------------------------------------------------------------------------
# الإعداد من البيئة
# ------------------------------------------------------------------------------------------------------------------
# إعدادات التخزين الخارجي (نقطة النهاية والحاوية والمفاتيح والفواصل الزمنية). الأسرار لا تُطبع (انظر __repr__).
class Config:
    def __init__(self, endpoint: str, bucket: str, access_key: str, secret_key: str, region: str = "auto",
                 prefix: str = "alfakhama/", interval: int = 120, analytics_interval: int = 600):
        self.endpoint = endpoint.rstrip("/")
        self.bucket = bucket
        self.access_key = access_key
        self.secret_key = secret_key
        self.region = region or "auto"
        prefix = (prefix or "").strip().lstrip("/")
        self.prefix = prefix + "/" if prefix and not prefix.endswith("/") else prefix
        self.interval = max(1, int(interval))
        # الزيارات وحدها تُحفظ بوتيرة أبطأ حتى لا يسبب الزوار سيل رفع (لا تقل عن الفاصل العادي).
        self.analytics_interval = max(self.interval, int(analytics_interval))

    def __repr__(self) -> str:  # لا تُطبع الأسرار أبدًا
        return f"Config(endpoint={self.endpoint!r}, bucket={self.bucket!r}, prefix={self.prefix!r})"


# يقرأ عددًا صحيحًا موجبًا من متغيرات البيئة مع قيمة افتراضية عند الخطأ.
def _int_env(env, name: str, default: int) -> int:
    try:
        return max(1, int(str(env.get(name, "")).strip() or default))
    except ValueError:
        return default


# يتحقق من متغيرات BACKUP_S3_* بصرامة (https إلا للمضيف المحلي، اسم حاوية صالح)؛ أي خلل يعطّل الميزة فقط.
def load_config(env=None, log=default_log) -> Config | None:
    """يعيد Config إن كانت كل المتغيرات الأربعة الأساسية مضبوطة وصحيحة، وإلا None (التخزين الخارجي معطّل)."""
    env = os.environ if env is None else env
    get = lambda name: str(env.get(name, "") or "").strip()  # noqa: E731
    endpoint, bucket, access, secret = get("BACKUP_S3_ENDPOINT"), get("BACKUP_S3_BUCKET"), get("BACKUP_S3_ACCESS_KEY"), get("BACKUP_S3_SECRET_KEY")
    if not (endpoint or bucket or access or secret):
        return None
    missing = [n for n, v in (("BACKUP_S3_ENDPOINT", endpoint), ("BACKUP_S3_BUCKET", bucket),
                              ("BACKUP_S3_ACCESS_KEY", access), ("BACKUP_S3_SECRET_KEY", secret)) if not v]
    if missing:
        log("النسخ الخارجي معطّل: متغيرات ناقصة / external backup disabled, missing: " + ", ".join(missing))
        return None
    try:
        parts = urllib.parse.urlsplit(endpoint)
        host = (parts.hostname or "").lower()
        parts.port  # noqa: B018  (المنفذ الخاطئ يرفع ValueError هنا بدل أن يوقف الخادم لاحقًا)
    except ValueError:
        log("النسخ الخارجي معطّل: BACKUP_S3_ENDPOINT غير صالح / external backup disabled, invalid endpoint")
        return None
    if parts.scheme not in ("https", "http") or not host or parts.query or parts.fragment or parts.username:
        log("النسخ الخارجي معطّل: BACKUP_S3_ENDPOINT غير صالح / external backup disabled, invalid endpoint")
        return None
    if parts.scheme == "http" and host not in LOOPBACK_HOSTS:
        log("النسخ الخارجي معطّل: يجب أن يبدأ العنوان بـ https / external backup disabled, endpoint must be https")
        return None
    if not re.fullmatch(r"[A-Za-z0-9._-]{1,255}", bucket):
        log("النسخ الخارجي معطّل: اسم الحاوية غير صالح / external backup disabled, invalid bucket name")
        return None
    interval = _int_env(env, "BACKUP_INTERVAL", 120)
    return Config(endpoint, bucket, access, secret, get("BACKUP_S3_REGION") or "auto",
                  get("BACKUP_S3_PREFIX") or "alfakhama/",  # فارغ (ترك الحقل بلا قيمة في Render) = الافتراضي
                  interval, _int_env(env, "BACKUP_ANALYTICS_INTERVAL", 600))


# ------------------------------------------------------------------------------------------------------------------
# عميل S3 بسيط
# ------------------------------------------------------------------------------------------------------------------
# أصناف الأخطاء: NotFound (404) و DeadlineExceeded (انتهت الميزانية الزمنية) تُعامل خارج إعادة المحاولة.
class S3Error(Exception):
    def __init__(self, message: str, status: int = 0, code: str = ""):
        super().__init__(message)
        self.status = status
        self.code = code


class NotFound(S3Error):
    pass


class DeadlineExceeded(S3Error):
    pass


# معالج يمنع التحويلات: لو حوّلنا المخزن إلى عنوان آخر فلن نرسل إليه ترويسات التوقيع.
class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """لا نتبع التحويلات أبدًا: لا نريد إرسال التوقيع إلى عنوان آخر."""
    def redirect_request(self, *args, **kwargs):
        return None


# عميل HTTP صغير فوق urllib يوقّع الطلبات بـ SigV4 ويعيد المحاولة للأعطال المؤقتة (نمط path-style: /الحاوية/المفتاح).
class S3Client:
    def __init__(self, cfg: Config, timeout: float = 30.0, attempts: int = 4, backoff: float = 0.5, sleep=time.sleep):
        self.cfg = cfg
        self.timeout = timeout
        self.attempts = max(1, attempts)
        self.backoff = backoff
        self.sleep = sleep
        parts = urllib.parse.urlsplit(cfg.endpoint)
        self.scheme = parts.scheme
        self.base_path = parts.path.rstrip("/")
        default_port = 443 if parts.scheme == "https" else 80
        host = parts.hostname or ""
        if ":" in host:
            host = f"[{host}]"
        self.host = host if parts.port in (None, default_port) else f"{host}:{parts.port}"
        handlers: list = [_NoRedirect()]
        if parts.scheme == "https":
            handlers.append(urllib.request.HTTPSHandler(context=ssl.create_default_context()))  # التحقق من الشهادة مفعّل
        if (parts.hostname or "").lower() in LOOPBACK_HOSTS:
            handlers.append(urllib.request.ProxyHandler({}))  # الاتصال المحلي لا يمر عبر وكيل
        self.opener = urllib.request.build_opener(*handlers)

    # المسار الكامل للمفتاح داخل الحاوية (غير مُرمَّز؛ الترميز يتم عند بناء الرابط).
    def _path(self, key: str) -> str:
        return f"{self.base_path}/{self.cfg.bucket}" + (f"/{key}" if key else "")

    # محاولة واحدة: تحسب تجزئة المحتوى وتوقّع وترسل. أخطاء HTTP تتحول إلى NotFound أو S3Error مع كود الخطأ من XML.
    def _once(self, method: str, key: str, query, body, headers, deadline, reader):
        remaining = None if deadline is None else deadline - time.monotonic()
        # لا نبدأ طلبًا جديدًا إذا بقي أقل من 0.2 ثانية من الميزانية (مهم عند إيقاف الخدمة).
        if remaining is not None and remaining <= 0.2:
            raise DeadlineExceeded("انتهت المهلة المخصصة / time budget exhausted")
        path = self._path(key)
        # body قد يكون مسار ملف: يُرفع بتدفق من القرص بدل تحميله كله في الذاكرة (الحاوية المجانية 512MB فقط).
        is_file = isinstance(body, Path)
        if is_file:
            digest = hashlib.sha256()
            with open(body, "rb") as handle:
                for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                    digest.update(chunk)
            payload_hash = digest.hexdigest()
        else:
            payload_hash = hashlib.sha256(body).hexdigest() if body else EMPTY_SHA256
        signed = sign_request(method, self.host, path, query, headers, payload_hash, self.cfg.access_key,
                              self.cfg.secret_key, self.cfg.region, utc_now())
        qs = canonical_query(query)
        url = f"{self.scheme}://{self.host}{uri_encode(path, keep_slash=True)}" + (f"?{qs}" if qs else "")
        # urllib يطبّع أسماء الترويسات؛ نكتب Authorization بحرف كبير ونرسل بقية الترويسات الموقّعة كما هي.
        wire = {("Authorization" if k == "authorization" else k): v for k, v in signed.items()}
        upload = open(body, "rb") if is_file else None
        if is_file:
            wire["Content-Length"] = str(body.stat().st_size)
        req = urllib.request.Request(url, data=upload if is_file else (body if body else None), method=method, headers=wire)
        # مهلة الاتصال لا تتجاوز ما تبقى من الميزانية الكلية.
        timeout = self.timeout if remaining is None else max(0.5, min(self.timeout, remaining))
        try:
            with self.opener.open(req, timeout=timeout) as resp:
                return resp.status, reader(resp) if reader else resp.read(MAX_LIST_BYTES)
        except urllib.error.HTTPError as exc:
            detail = ""
            try:
                detail = exc.read(65536).decode("utf-8", "replace")
            except Exception:
                pass
            code = (re.search(r"<Code>([A-Za-z0-9_.-]{1,64})</Code>", detail) or [None, ""])[1]
            if exc.code == 404:
                raise NotFound(f"{method} {key or '/'} -> 404 {code}".strip(), 404, code) from None
            raise S3Error(f"{method} {key or '/'} -> HTTP {exc.code} {code}".strip(), exc.code, code) from None
        finally:
            if upload:
                upload.close()

    def request(self, method: str, key: str = "", query=None, body: bytes = b"", headers=None, deadline=None, reader=None):
        """طلب واحد مع إعادة محاولة (backoff) للأعطال المؤقتة فقط: انقطاع الشبكة و 429 و 5xx."""
        last: Exception | None = None
        for attempt in range(self.attempts):
            try:
                return self._once(method, key, query, body, headers, deadline, reader)
            except (NotFound, DeadlineExceeded):
                raise
            except S3Error as exc:
                if exc.status not in (429, 500, 502, 503, 504):
                    raise
                last = exc
            except (urllib.error.URLError, http.client.HTTPException, OSError) as exc:
                reason = getattr(exc, "reason", exc)
                last = S3Error(f"{method} {key or '/'} network error: {type(reason).__name__}")
            if attempt + 1 < self.attempts:
                pause = self.backoff * (2 ** attempt) * (0.75 + random.random() / 2)
                if deadline is not None and time.monotonic() + pause >= deadline:
                    break
                self.sleep(pause)
        raise last if last else S3Error("request failed")

    # -- عمليات مبسّطة (المفتاح هنا نسبي؛ البادئة تُضاف من الأعلى) ------------------------------------------------
    def put(self, key: str, data: "bytes | Path", content_type: str = "application/octet-stream", deadline=None) -> None:
        self.request("PUT", key, body=data, headers={"content-type": content_type}, deadline=deadline)

    def get(self, key: str, deadline=None) -> bytes:
        return self.request("GET", key, deadline=deadline)[1]

    # التنزيل إلى ملف بتدفق مع سقف للحجم، بدل قراءة كل الكائن في الذاكرة.
    def get_file(self, key: str, dest: Path, max_bytes: int, deadline=None) -> tuple[int, str]:
        """ينزّل إلى ملف بتدفق ويعيد (الحجم, sha256). يتجاوز max_bytes => خطأ."""
        def reader(resp):
            digest, size = hashlib.sha256(), 0
            with open(dest, "wb") as handle:
                while True:
                    chunk = resp.read(1024 * 1024)
                    if not chunk:
                        break
                    size += len(chunk)
                    if size > max_bytes:
                        raise S3Error("الملف أكبر من الحد المسموح / object too large")
                    digest.update(chunk)
                    handle.write(chunk)
            # http.client لا يشتكي إن انقطع الاتصال مبكرًا؛ نقارن بـ Content-Length بأنفسنا. الانقطاع خطأ شبكة
            # (يُعاد المحاولة ثم يُعدّ "unreachable") وليس لقطة تالفة، حتى لا نبدأ ببذرة فارغة فوق النسخة الحقيقية.
            declared = resp.headers.get("Content-Length")
            if declared and declared.isdigit() and int(declared) != size:
                raise http.client.IncompleteRead(b"", int(declared) - size)
            return size, digest.hexdigest()
        return self.request("GET", key, deadline=deadline, reader=reader)[1]

    # يتحقق من وجود كائن دون تنزيله؛ يعيد None إذا لم يوجد.
    def head(self, key: str, deadline=None) -> dict | None:
        try:
            status, _ = self.request("HEAD", key, deadline=deadline, reader=lambda r: dict(r.headers))
        except NotFound:
            return None
        return {"status": status}

    # حذف كائن؛ عدم وجوده ليس خطأ.
    def delete(self, key: str, deadline=None) -> None:
        try:
            self.request("DELETE", key, deadline=deadline)
        except NotFound:
            pass

    def list(self, prefix: str, deadline=None) -> list[tuple[str, int]]:
        """ListObjectsV2 كاملة (مع الصفحات): قائمة (المفتاح الكامل, الحجم). مفاتيح بأحرف تحكم تُهمل."""
        out: list[tuple[str, int]] = []
        token = ""
        # حد أقصى للصفحات (1000 صفحة) حتى لا تدور الحلقة للأبد إن أعاد المخزن token متكررًا.
        for _ in range(1000):
            query = {"list-type": "2", "prefix": self.cfg.prefix + prefix}
            if token:
                query["continuation-token"] = token
            _, data = self.request("GET", "", query=query, deadline=deadline)
            # حماية من هجمات XML (توسيع الكيانات): رد S3 الحقيقي لا يحتوي DOCTYPE ولا ENTITY، فنرفض ما يحتويها.
            if b"<!DOCTYPE" in data[:2048].upper() or b"<!ENTITY" in data.upper():
                raise S3Error("رد غير متوقع من المخزن / unexpected XML from the store")
            root = ET.fromstring(data)
            # ردود S3 تأتي غالبًا بمجال أسماء XML؛ نستخرجه لنستخدمه في البحث عن العناصر.
            ns = root.tag.partition("}")[0] + "}" if root.tag.startswith("{") else ""
            for item in root.findall(f"{ns}Contents"):
                key = item.findtext(f"{ns}Key") or ""
                if not key or any(ord(c) < 32 for c in key):
                    continue
                try:
                    size = int(item.findtext(f"{ns}Size") or 0)
                except ValueError:
                    size = 0
                out.append((key, size))
            if (root.findtext(f"{ns}IsTruncated") or "").lower() == "true" and root.findtext(f"{ns}NextContinuationToken"):
                token = root.findtext(f"{ns}NextContinuationToken") or ""
            else:
                return out
        return out


# ------------------------------------------------------------------------------------------------------------------
# فحوص القاعدة
# ------------------------------------------------------------------------------------------------------------------
# أسماء الجداول في ملف قاعدة مفتوح للقراءة فقط (mode=ro) فلا نغيّر شيئًا فيه.
def db_tables(path: Path) -> set[str]:
    conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=5)
    try:
        return {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    finally:
        conn.close()


# فحص سلامة ملف قاعدة منزَّل قبل اعتماده (لا نثبّت لقطة تالفة أو ناقصة الجداول).
def check_db_file(path: Path, required: set[str]) -> int:
    """integrity_check + وجود الجداول المطلوبة. يعيد user_version أو يرفع ValueError."""
    try:
        conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=5)
    except sqlite3.Error as exc:
        raise ValueError(f"cannot open: {exc}") from None
    try:
        result = [r[0] for r in conn.execute("PRAGMA integrity_check")]
        if result != ["ok"]:
            raise ValueError("integrity_check failed")
        tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if not required <= tables:
            raise ValueError("missing tables: " + ", ".join(sorted(required - tables)))
        return int(conn.execute("PRAGMA user_version").fetchone()[0])
    except sqlite3.Error as exc:
        raise ValueError(f"sqlite error: {exc}") from None
    finally:
        conn.close()


# أهم حماية في الاستعادة: لا نستبدل قاعدة محلية إلا إذا كانت بذرة جديدة بلا أي بيانات حقيقية.
def is_pristine_seed(path: Path, default_settings: dict | None = None) -> bool:
    """هل القاعدة المحلية بذرة جديدة لم يلمسها المدير؟ (لا طلبات، لا رسائل، لا سجل إدارة، منتجات البذرة كما هي)
    أي شك => False، لأن الاستعادة لا يجوز أن تمحو بيانات حقيقية أبدًا."""
    try:
        conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=5)
    except sqlite3.Error:
        return False
    try:
        tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if not tables:
            return True  # ملف فارغ تمامًا
        count = lambda sql: conn.execute(sql).fetchone()[0]  # noqa: E731
        for table in ("orders", "messages", "audit_log"):
            if table in tables and count(f"SELECT COUNT(*) FROM {table}") > 0:
                return False
        if "admins" in tables and count("SELECT COUNT(*) FROM admins") > 1:
            return False
        if "products" in tables:
            # منتجات البذرة تحمل slug مثل wavy-01 ولم تُعدَّل بعد إنشائها.
            if count("SELECT COUNT(*) FROM products WHERE slug NOT LIKE 'wavy-%' OR updated_at != created_at") > 0:
                return False
        if "settings" in tables:
            internal = {"sample_cleanup_v1", "seed_wavy_v1", "admin_cred_fp"}
            allowed = set(default_settings or {}) | internal
            for key, value in conn.execute("SELECT key, value FROM settings"):
                if key in internal:
                    continue
                if key not in allowed:
                    return False
                if default_settings is not None and key != "site_ready" and default_settings.get(key) != value:
                    return False
                if key == "site_ready" and value not in ("0", "1"):
                    return False
        return True
    except sqlite3.Error:
        return False
    finally:
        conn.close()


# سياسة التقليم: ما لم يُذكر هنا يُحذف من المخزن لاحقًا في _prune.
def select_keep(keys: list[str], now: datetime) -> set[str]:
    """أي لقطات نحتفظ بها: الأحدث 5، ثم الأحدث في كل ساعة (آخر 24 ساعة)، ثم الأحدث في كل يوم (آخر 14 يومًا)."""
    ordered = sorted(keys, reverse=True)
    keep = set(ordered[:KEEP_SNAPSHOTS])
    seen_hours: set[str] = set()
    seen_days: set[str] = set()
    for rel in ordered:
        m = DB_KEY_RE.fullmatch(rel)
        if not m:
            continue
        try:
            when = datetime.strptime(m.group(1), "%Y%m%dT%H%M%SZ").replace(tzinfo=timezone.utc)
        except ValueError:
            continue
        age = (now - when).total_seconds()
        if age < KEEP_HOURLY_FOR and m.group(1)[:11] not in seen_hours:
            seen_hours.add(m.group(1)[:11])
            keep.add(rel)
        if age < KEEP_DAILY_FOR and m.group(1)[:8] not in seen_days:
            seen_days.add(m.group(1)[:8])
            keep.add(rel)
    return keep


# ------------------------------------------------------------------------------------------------------------------
# المدير الرئيسي
# ------------------------------------------------------------------------------------------------------------------
# المدير الرئيسي: يربط الاستعادة عند الإقلاع واللقطات الدورية والخيط الخلفي والإيقاف الآمن.
class Persistence:
    def __init__(self, cfg: Config | None, data_dir: Path, db_path: Path, upload_dir: Path, name_re,
                 log=default_log, required_tables: set[str] | None = None, default_settings: dict | None = None,
                 client: S3Client | None = None):
        self.cfg = cfg
        self.data_dir = Path(data_dir)
        self.db_path = Path(db_path)
        self.upload_dir = Path(upload_dir)
        self.name_re = name_re
        self._log = log
        self.required = set(required_tables or REQUIRED_TABLES)
        self.default_settings = default_settings
        self.client = client or (S3Client(cfg) if cfg else None)
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._dirty_important = False
        self._dirty_analytics = False
        self._last_attempt = float("-inf")
        self._hard_deadline: float | None = None
        self._remote_uploads: dict[str, int] | None = None
        self.last_snapshot: str | None = None
        self.last_error = ""
        self.failed_uploads = 0
        self.restore_status = "disabled" if not cfg else "not_run"
        # حالة المدير: علامات التغيير (مهم/زيارات)، آخر محاولة، آخر لقطة وخطأ، وقفل يمنع لقطتين متزامنتين.
        self.blocked = False                 # true => لا نرفع لقطات حتى نتأكد مما في المخزن (حماية من محو النسخة الحقيقية)
        self._blocked_check = 0.0
        self._own_keys: set[str] = set()     # لقطات هذا النسخة (استعدناها أو رفعناها) لكشف كاتب آخر على latest.json

    # -- أدوات --------------------------------------------------------------------------------------------------
    @property
    def enabled(self) -> bool:
        return self.cfg is not None

    def log(self, message: str) -> None:
        self._log(self._safe(message))

    # كل رسالة سجل تمر من هنا حتى لا يظهر مفتاح الوصول أو السر مصادفة في السجلات.
    def _safe(self, text: str) -> str:
        """يحجب أي سر قد يتسرب إلى رسالة خطأ."""
        if self.cfg:
            for secret in (self.cfg.secret_key, self.cfg.access_key):
                if secret:
                    text = text.replace(secret, "***")
        return text

    # يضيف بادئة المستخدم (BACKUP_S3_PREFIX) إلى المفتاح النسبي.
    def _k(self, key: str) -> str:
        return self.cfg.prefix + key

    # أقرب موعد نهائي بين موعد العملية والموعد الصارم للإيقاف.
    def _deadline(self, local: float | None = None) -> float | None:
        values = [d for d in (local, self._hard_deadline) if d is not None]
        return min(values) if values else None

    def mark_dirty(self, analytics_only: bool = False) -> None:
        """تُستدعى بعد كل كتابة ناجحة في القاعدة أو رفع صورة؛ رخيصة جدًا (لا شبكة ولا قفل)."""
        if not self.cfg:
            return
        if analytics_only:
            self._dirty_analytics = True
        else:
            self._dirty_important = True

    # حالة مختصرة (مفعّل؟ آخر لقطة، موقوف؟ نتيجة الاستعادة) بلا أي أسرار.
    def status(self) -> dict:
        return {"enabled": self.enabled, "last_snapshot": self.last_snapshot, "blocked": self.blocked,
                "restore": self.restore_status}

    # -- الاستعادة عند الإقلاع ------------------------------------------------------------------------------------
    def restore_on_startup(self) -> str:
        """تُستدعى قبل init_db. لا ترفع استثناءً أبدًا. تعيد حالة نصية:
        disabled | local_kept | no_remote | restored | corrupt_all | unreachable"""
        if not self.cfg:
            return "disabled"
        try:
            status = self._restore()
        except Exception as exc:  # الخادم يجب أن يبقى يعمل
            self.log(f"تعذرت الاستعادة، سنبدأ بقاعدة جديدة / restore failed, starting fresh: {type(exc).__name__}: {exc}")
            status = "unreachable"
        self.restore_status = status
        # unreachable => لا نعرف ما في المخزن، فلا نرفع بذرة فارغة فوق النسخة الحقيقية.
        self.blocked = status == "unreachable"
        if self.blocked:
            self.log("الرفع موقوف حتى يتوفر المخزن / uploads paused until the bucket is reachable")
        return status

    # منطق الاستعادة: نحافظ على أي قاعدة محلية فيها بيانات، وإلا نجرّب اللقطات من الأحدث إلى الأقدم.
    def _restore(self) -> str:
        for stale in self.data_dir.glob(".persist-*"):
            shutil.rmtree(stale, ignore_errors=True) if stale.is_dir() else stale.unlink(missing_ok=True)
        # ملف علامة يبقى إن فشل تنزيل بعض الصور ليُعاد المحاولة في الإقلاع التالي.
        marker = self.data_dir / ".uploads-incomplete"  # علامة: بقيت صور لم تُنزَّل، نعيد المحاولة في الإقلاع التالي
        db_exists = self.db_path.exists()
        if db_exists and not is_pristine_seed(self.db_path, self.default_settings):
            self.log("قاعدة محلية فيها بيانات؛ لن تُستبدل / local database has data, keeping it")
            if marker.exists():
                self._restore_uploads(marker)
            return "local_kept"
        try:
            candidates = self._candidates()
        except Exception as exc:
            self.log(f"تعذر الوصول إلى المخزن / bucket unreachable: {type(exc).__name__}: {exc}")
            return "unreachable"
        if not candidates:
            self.log("لا توجد نسخة في المخزن؛ نبدأ بقاعدة جديدة / no snapshot in the bucket, starting fresh")
            return "no_remote"
        transport_errors = 0
        for key, meta in candidates:
            try:
                if self._download_and_install(key, meta):
                    self.log(f"استُعيدت القاعدة من {key} / database restored")
                    self._restore_uploads(marker)
                    return "restored"
            except ValueError as exc:  # لقطة تالفة => جرّب الأقدم
                self.log(f"لقطة تالفة، ننتقل للأقدم / corrupt snapshot skipped: {key}: {exc}")
            except Exception as exc:
                transport_errors += 1
                self.log(f"تعذر تنزيل اللقطة / snapshot download failed: {key}: {type(exc).__name__}: {exc}")
        return "unreachable" if transport_errors else "corrupt_all"

    # يجمع المرشحين: manifest (latest.json) أولًا لأنه الأحدث، ثم القائمة كاحتياط إن كان تالفًا أو مفقودًا.
    def _candidates(self) -> list[tuple[str, dict | None]]:
        """الأحدث أولًا: ما يشير إليه latest.json ثم بقية اللقطات من القائمة. المفاتيح العدائية تُهمل."""
        out: list[tuple[str, dict | None]] = []
        seen: set[str] = set()
        try:
            manifest = json.loads(self.client.get(self._k(LATEST_KEY)).decode("utf-8"))
            key = manifest.get("db_key")
            if isinstance(key, str) and DB_KEY_RE.fullmatch(key):
                out.append((key, manifest))
                seen.add(key)
        except NotFound:
            pass
        except (ValueError, AttributeError):
            self.log("latest.json غير صالح؛ نعتمد على القائمة / latest.json invalid, using the listing")
        listed = []
        for full, _size in self.client.list(DB_PREFIX):
            rel = full[len(self.cfg.prefix):] if full.startswith(self.cfg.prefix) else ""
            if DB_KEY_RE.fullmatch(rel) and rel not in seen:
                listed.append(rel)
        for rel in sorted(listed, reverse=True):
            out.append((rel, None))
        return out

    # ينزّل لقطة واحدة إلى مجلد مؤقت ويتحقق منها (الحجم، SHA-256، فك الضغط بسقف، سلامة القاعدة) ثم يثبّتها ذريًا.
    def _download_and_install(self, rel_key: str, meta: dict | None) -> bool:
        match = DB_KEY_RE.fullmatch(rel_key)
        if not match:
            raise ValueError("bad key")
        work = Path(tempfile.mkdtemp(prefix=".persist-restore-", dir=self.data_dir))
        try:
            gz_path, raw_path = work / "snap.db.gz", work / "store.db"
            size, sha = self.client.get_file(self._k(rel_key), gz_path, MAX_DB_GZ_BYTES)
            if meta is not None:
                if size != meta.get("size") or sha != meta.get("sha256"):
                    raise ValueError("size/sha256 mismatch with latest.json")
            # اسم الكائن يحمل أول 16 خانة من SHA-256، فأي عدم تطابق يعني كائنًا مبدّلًا أو تالفًا.
            if not sha.startswith(match.group(2)):
                raise ValueError("sha256 does not match the object name")
            if shutil.disk_usage(self.data_dir).free < size + MIN_FREE_DISK:
                raise OSError("not enough free disk space for restore")  # ليس تلفًا في اللقطة => unreachable
            try:
                total = 0
                # فك الضغط على قطع مع سقف للحجم الناتج (حماية من ملف gzip صغير ينتفخ إلى حجم هائل).
                with gzip.open(gz_path, "rb") as src, open(raw_path, "wb") as dst:
                    while True:
                        chunk = src.read(1024 * 1024)
                        if not chunk:
                            break
                        total += len(chunk)
                        if total > MAX_DB_RAW_BYTES:
                            raise ValueError("decompressed size too large")
                        dst.write(chunk)
            except (OSError, EOFError) as exc:
                raise ValueError(f"gunzip failed: {type(exc).__name__}") from None
            check_db_file(raw_path, self.required)
            for suffix in ("-wal", "-shm", "-journal"):  # ملفات الجلسة القديمة لا تُنقل مع القاعدة الجديدة
                Path(str(self.db_path) + suffix).unlink(missing_ok=True)
            staged = self.data_dir / ".persist-staged.db"
            shutil.move(str(raw_path), staged)
            os.replace(staged, self.db_path)  # استبدال ذري
            self._own_keys.add(rel_key)       # هذه هي القاعدة التي بنينا عليها: أساس فحص التعارض عند الحفظ
            return True
        finally:
            shutil.rmtree(work, ignore_errors=True)

    # يستعيد الصور المفقودة محليًا فقط (لا يستبدل ملفًا موجودًا).
    def _restore_uploads(self, marker: Path) -> None:
        """ينزّل الصور الناقصة. أسماء المفاتيح قادمة من المخزن فهي غير موثوقة: تُفحص بنفس regex الخادم."""
        self.upload_dir.mkdir(parents=True, exist_ok=True)
        failed = 0
        try:
            remote = self.client.list(UPLOADS_PREFIX)
        except Exception as exc:
            self.log(f"تعذر سرد الصور / listing uploads failed: {type(exc).__name__}: {exc}")
            marker.write_text("1")
            return
        remote_map: dict[str, int] = {}
        for full, size in remote:
            rel = full[len(self.cfg.prefix):] if full.startswith(self.cfg.prefix) else ""
            name = rel[len(UPLOADS_PREFIX):] if rel.startswith(UPLOADS_PREFIX) else ""
            if not name or "/" in name or "\\" in name or not self.name_re.fullmatch(name):
                continue  # مفتاح غريب: يُتجاهل
            remote_map[name] = size
            target = self.upload_dir / name
            if os.path.lexists(target) or size > MAX_UPLOAD_BYTES:
                continue
            tmp = self.upload_dir / f".persist-{os.getpid()}-{name}"[:200]
            try:
                got, _sha = self.client.get_file(self._k(rel), tmp, MAX_UPLOAD_BYTES)
                if got != size:  # صورة ناقصة لا تُركَّب أبدًا (وإلا رُفعت لاحقًا فوق النسخة السليمة)
                    raise S3Error("size differs from the listing")
                os.replace(tmp, target)
            except Exception as exc:
                failed += 1
                self.log(f"تعذر تنزيل صورة / upload download failed: {name}: {type(exc).__name__}")
            finally:
                tmp.unlink(missing_ok=True)
        self._remote_uploads = remote_map
        if failed:
            marker.write_text("1")
        else:
            marker.unlink(missing_ok=True)
        self.log(f"الصور في المخزن: {len(remote_map)}، فشل: {failed} / uploads in bucket: {len(remote_map)}, failed: {failed}")

    # -- اللقطات ------------------------------------------------------------------------------------------------
    # صور الرفع المحلية الصالحة فقط: اسم مطابق لنمط الخادم وملف عادي (لا روابط رمزية).
    def _local_uploads(self) -> list[Path]:
        if not self.upload_dir.is_dir():
            return []
        out = []
        for f in self.upload_dir.iterdir():
            try:
                if self.name_re.fullmatch(f.name) and not f.is_symlink() and f.is_file():
                    out.append(f)
            except OSError:
                pass
        return sorted(out)

    # نرفع الصور الجديدة فقط: يكفي مقارنة الاسم والحجم مع ما في المخزن.
    def _sync_uploads(self, deadline: float | None) -> int:
        """يرفع الصور الجديدة فقط (القائمة تُجلب مرة واحدة ثم تُحدَّث محليًا)."""
        if self._remote_uploads is None:
            known: dict[str, int] = {}
            for full, size in self.client.list(UPLOADS_PREFIX, deadline=self._deadline(deadline)):
                rel = full[len(self.cfg.prefix):]
                name = rel[len(UPLOADS_PREFIX):] if rel.startswith(UPLOADS_PREFIX) else ""
                if name and "/" not in name and self.name_re.fullmatch(name):
                    known[name] = size
            self._remote_uploads = known
        sent = 0
        for f in self._local_uploads():
            try:
                size = f.stat().st_size
            except OSError:
                continue
            if self._remote_uploads.get(f.name) == size or size > MAX_UPLOAD_BYTES:
                continue
            try:
                data = f.read_bytes()
            except OSError:
                continue
            try:
                self.client.put(self._k(UPLOADS_PREFIX + f.name), data, deadline=self._deadline(deadline))
            except DeadlineExceeded:
                raise
            except S3Error as exc:
                # صورة واحدة مرفوضة لا توقف بقية الصور ولا حفظ القاعدة؛ نتخطاها ونعيد المحاولة في دورة لاحقة.
                self.failed_uploads += 1
                self.log(f"تعذر رفع صورة، تخطيناها / upload skipped: {f.name}: {self._safe(str(exc))}")
                continue
            self._remote_uploads[f.name] = len(data)
            sent += 1
        return sent

    # حماية من كاتبين متزامنين (النسخة القديمة والجديدة أثناء النشر): لا نمحو لقطة غريبة دون أن نحتفظ بنسخة منها.
    def _guard_conflict(self, deadline) -> None:
        """إن كانت latest.json تشير إلى لقطة ليست من عملنا (نسخة قديمة من الخدمة ما زالت تعمل أثناء النشر)
        نحفظ نسخة منها تحت conflicts/ قبل أن نكتب فوقها، فلا تضيع طلباتها ويمكن دمجها يدويًا."""
        try:
            manifest = json.loads(self.client.get(self._k(LATEST_KEY), deadline=self._deadline(deadline)).decode("utf-8"))
        except Exception:
            return  # لا latest.json أو غير صالحة: لا تعارض نعرفه
        key = manifest.get("db_key") if isinstance(manifest, dict) else None
        if not isinstance(key, str) or not DB_KEY_RE.fullmatch(key) or key in self._own_keys:
            return
        tmp = self.data_dir / f".persist-conflict-{os.getpid()}.gz"
        try:
            self.client.get_file(self._k(key), tmp, MAX_DB_GZ_BYTES)
            self.client.put(self._k("conflicts/" + key[len(DB_PREFIX):]), tmp, "application/gzip", deadline=self._deadline(deadline))
            self._own_keys.add(key)
            self.log(f"تعارض: كاتب آخر حدّث latest.json؛ حُفظت نسخته في conflicts/ / conflict, other writer's snapshot kept: {key}")
        except Exception as exc:
            self.log(f"تعذر حفظ نسخة التعارض / conflict copy failed: {type(exc).__name__}")
        finally:
            tmp.unlink(missing_ok=True)

    # يكتب manifest يشير لآخر لقطة؛ يُكتب بعد رفع اللقطة نفسها حتى لا يشير أبدًا إلى كائن غير موجود.
    def _write_latest(self, db_key: str, sha: str, size: int, raw_size: int, user_version: int, deadline) -> None:
        if db_key not in self._own_keys:
            self._guard_conflict(deadline)
        manifest = {"format": 1, "created_at": utc_now().isoformat(timespec="seconds"), "db_key": db_key, "sha256": sha,
                    "size": size, "raw_size": raw_size, "user_version": user_version,
                    "uploads": None if self._remote_uploads is None else sorted(self._remote_uploads)}
        self.client.put(self._k(LATEST_KEY), json.dumps(manifest, ensure_ascii=False).encode("utf-8"),
                        "application/json", deadline=self._deadline(deadline))
        self._own_keys.add(db_key)

    # حذف اللقطات القديمة وفق select_keep؛ لا يحذف شيئًا لو كانت كل لقطات المخزن تالفة.
    def _prune(self, keep_key: str, deadline) -> None:
        keys = []
        for full, _ in self.client.list(DB_PREFIX, deadline=self._deadline(deadline)):
            rel = full[len(self.cfg.prefix):]
            if DB_KEY_RE.fullmatch(rel):
                keys.append(rel)
        if self.restore_status == "corrupt_all":
            return  # كل ما في المخزن بدا تالفًا: لا نحذف شيئًا قد ينفع في إنقاذ يدوي
        newest = select_keep(keys, utc_now()) | {keep_key}
        for rel in keys:
            if rel not in newest:
                self.client.delete(self._k(rel), deadline=self._deadline(deadline))

    # تنفيذ لقطة: نسخة متسقة من القاعدة بواجهة النسخ في SQLite، ثم ضغط، ثم رفع، ثم manifest، ثم الصور، ثم التقليم.
    def snapshot(self, budget: float | None = None, reason: str = "auto") -> bool:
        """لقطة كاملة: (صور) ثم القاعدة ثم latest.json ثم الصور ثم التقليم. تعيد True عند النجاح.
        مع budget (إيقاف الخدمة) تُرفع القاعدة أولًا لأنها الأهم."""
        if not self.cfg or self.blocked:
            return False
        local_deadline = None if budget is None else time.monotonic() + budget
        # بلا ميزانية ننتظر القفل مهما طال؛ مع ميزانية (إيقاف الخدمة) ننتظر بقدرها فقط.
        if not self._lock.acquire(timeout=-1 if budget is None else max(0.1, budget)):
            return False
        imp, ana = self._dirty_important, self._dirty_analytics
        self._dirty_important = self._dirty_analytics = False
        self._last_attempt = time.monotonic()
        work = Path(tempfile.mkdtemp(prefix=".persist-snap-", dir=self.data_dir))
        try:
            # القاعدة أولًا دائمًا: صورة معطوبة أو رفع بطيء للصور لا يجوز أن يؤخر حفظ الطلبات والإعدادات.
            copy, gz_path = work / "store.db", work / "snap.db.gz"
            source = sqlite3.connect(self.db_path, timeout=20)  # لا ننسخ الملف الحي أبدًا: واجهة النسخ في SQLite
            try:
                dest = sqlite3.connect(copy)
                try:
                    source.backup(dest)
                    dest.execute("PRAGMA journal_mode=DELETE")  # ملف واحد مكتفٍ بذاته
                    user_version = int(dest.execute("PRAGMA user_version").fetchone()[0])
                finally:
                    dest.close()
            finally:
                source.close()
            raw_size = copy.stat().st_size
            with open(copy, "rb") as src, open(gz_path, "wb") as raw_out:
                # mtime=0 يجعل الضغط حتميًا (نفس المحتوى => نفس SHA-256).
                with gzip.GzipFile(fileobj=raw_out, mode="wb", compresslevel=6, mtime=0) as gz:
                    shutil.copyfileobj(src, gz, 1024 * 1024)
            digest = hashlib.sha256()
            with open(gz_path, "rb") as handle:
                for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                    digest.update(chunk)
            sha = digest.hexdigest()
            gz_size = gz_path.stat().st_size
            stamp = utc_now().strftime("%Y%m%dT%H%M%SZ")
            # اسم الكائن غير قابل للتعديل: الوقت + بداية التجزئة، فلا تُكتب فوق لقطة قديمة.
            db_key = f"{DB_PREFIX}{stamp}-{sha[:16]}.db.gz"
            self.client.put(self._k(db_key), gz_path, "application/gzip", deadline=self._deadline(local_deadline))
            self._write_latest(db_key, sha, gz_size, raw_size, user_version, local_deadline)
            self.last_snapshot = utc_now().isoformat(timespec="seconds")
            self.last_error = ""
            try:
                known_before = self._remote_uploads is not None
                self.failed_uploads = 0
                if self._sync_uploads(local_deadline) or not known_before:
                    self._write_latest(db_key, sha, gz_size, raw_size, user_version, local_deadline)
                if self.failed_uploads:
                    self._dirty_important = True  # نعيد محاولة الصور المتخطاة في الدورة التالية
                self._prune(db_key, local_deadline)
            except Exception as exc:  # القاعدة محفوظة؛ الصور تُعاد محاولتها في الدورة التالية
                self._dirty_important = True
                self.last_error = self._safe(f"{type(exc).__name__}: {exc}")
                self.log(f"اللقطة حُفظت لكن مزامنة الصور/التقليم لم تكتمل / snapshot saved, uploads/prune incomplete: {self.last_error}")
            self.log(f"لقطة ناجحة ({reason}) {db_key} {gz_size} بايت / snapshot ok")
            return True
        except Exception as exc:
            self._dirty_important = self._dirty_important or imp
            self._dirty_analytics = self._dirty_analytics or ana
            self.last_error = self._safe(f"{type(exc).__name__}: {exc}")
            self.log(f"فشلت اللقطة وسنعيد المحاولة / snapshot failed, will retry: {self.last_error}")
            return False
        finally:
            shutil.rmtree(work, ignore_errors=True)
            self._lock.release()

    # -- الخيط الخلفي والإيقاف -----------------------------------------------------------------------------------
    # يُستدعى كل دقيقة أثناء الإيقاف الوقائي للتحقق مما إذا عاد المخزن للعمل.
    def _recheck_remote(self) -> None:
        """بعد فشل الاستعادة: إن تبيّن أن المخزن فارغ فعلًا نرفع الإيقاف. وإن فيه لقطة نبقى موقوفين (يلزم إعادة تشغيل)."""
        try:
            candidates = self._candidates()
        except Exception:
            return
        if not candidates:
            self.blocked = False
            self.log("المخزن متاح وفارغ؛ استُؤنف الحفظ / bucket reachable and empty, uploads resumed")
        elif self.blocked:
            self.log("المخزن فيه نسخة لم تُستعد؛ أعد تشغيل الخدمة لاستعادتها / bucket has a snapshot, restart to restore it")

    # الخيط الخلفي: كل ثانية يفحص علامات التغيير ويأخذ لقطة إذا انقضى الفاصل (زيارات فقط => فاصل أطول).
    def _loop(self) -> None:
        while not self._stop.wait(1.0):
            try:
                now = time.monotonic()
                if self.blocked:
                    if now - self._blocked_check >= 60:
                        self._blocked_check = now
                        self._recheck_remote()
                    continue
                elapsed = now - self._last_attempt
                if (self._dirty_important and elapsed >= self.cfg.interval) or \
                        (self._dirty_analytics and elapsed >= self.cfg.analytics_interval):
                    self.snapshot(reason="important" if self._dirty_important else "analytics")
            except Exception as exc:
                self.log(f"خطأ في خيط الحفظ / persist thread error: {type(exc).__name__}: {self._safe(str(exc))}")

    # يشغّل الخيط الخلفي مرة واحدة (daemon فلا يمنع إنهاء العملية).
    def start(self) -> None:
        if not self.cfg or self._thread:
            return
        # نبدأ العدّ من الإقلاع: أول زيارة بعد التشغيل لا تسبب رفعًا فوريًا، وكل تغيير مهم يُحفظ خلال BACKUP_INTERVAL.
        self._last_attempt = time.monotonic()
        self._thread = threading.Thread(target=self._loop, daemon=True, name="persist")
        self._thread.start()

    # يُستدعى عند إيقاف الخدمة لحفظ آخر التغييرات ضمن مهلة صارمة.
    def flush(self, budget: float = 20.0) -> bool:
        """لقطة أخيرة عند SIGTERM/SIGINT بميزانية زمنية صارمة (Render يقتل الحاوية بعد نحو 30 ثانية)."""
        if not self.cfg or self.blocked:
            return False
        self._stop.set()
        self._hard_deadline = time.monotonic() + budget
        # لقطة خلفية قد تكون جارية الآن (مسحت علامات "متسخ" في بدايتها): ننتظر قفلها بدل الخروج فتُقتل في منتصف الرفع.
        # إن فشلت تعيد العلامات فنأخذ لقطة جديدة أدناه.
        if self._lock.acquire(timeout=max(0.1, budget)):
            self._lock.release()
        if not (self._dirty_important or self._dirty_analytics):
            return False
        ok = self.snapshot(budget=max(0.5, self._hard_deadline - time.monotonic()), reason="shutdown")
        self.log("اللقطة الأخيرة " + ("نجحت" if ok else "لم تكتمل") + " / final snapshot " + ("ok" if ok else "incomplete"))
        return ok
