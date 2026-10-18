"""اختبارات الحفظ الدائم (persist.py): توقيع SigV4، لقطة/استعادة، الإحصاءات، SIGTERM، والأمان.

المخزن هنا خادم S3 مزيّف صغير يعمل في العملية نفسها ويتحقق من توقيع كل طلب. إن وُجد moto_server في PATH
(أو في متغير MOTO_SERVER) يُشغَّل اختبار إضافي على مخزن S3 حقيقي المحاكاة. لا يوجد هنا أي اختبار على Render أو R2 الحقيقيين.
بيانات الاعتماد كلها وهمية وواضحة أنها للاختبار فقط.
"""
from __future__ import annotations

import gzip
import hashlib
import json
import os
import re
import shutil
import signal
import socket
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import unittest
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from test_app import JPEG, PNG, ROOT, ServerCase, data_uri, free_port  # noqa: E402

import persist  # noqa: E402

FAKE_ACCESS = "AKIAFAKETESTONLY0000"
FAKE_SECRET = "fake-secret-for-tests-only-000000"
BUCKET = "test-bucket"
NAME_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]{0,200}")


# ----------------------------------------------------------------------------------------------------------------
# مخزن S3 مزيّف: PUT/GET/HEAD/DELETE/ListObjectsV2 مع التحقق من SigV4
# ----------------------------------------------------------------------------------------------------------------
class FakeS3:
    def __init__(self, page_size: int = 2, verify: bool = True):
        self.objects: dict[str, bytes] = {}
        self.log: list[tuple[str, str]] = []        # (method, key)
        self.fail_next = 0                           # عدد الطلبات القادمة التي تُجاب بـ 503
        self.leak_secret_in_errors = False
        self.put_gate: threading.Event | None = None   # إن وُجد توقف أي PUT حتى يُطلق (لمحاكاة رفع بطيء)
        self.fail_put_prefix = ""                       # PUT لمفاتيح تبدأ بهذا يُرفض بـ 400
        self.truncate_get = 0                           # عدد ردود GET القادمة التي تنقطع في المنتصف
        self.page_size = page_size
        self.verify = verify
        self.lock = threading.Lock()
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass

            def _split(self):
                parts = urllib.parse.urlsplit(self.path)
                segs = parts.path.split("/", 2)           # "", bucket, key
                bucket = urllib.parse.unquote(segs[1]) if len(segs) > 1 else ""
                key = urllib.parse.unquote(segs[2]) if len(segs) > 2 else ""
                return bucket, key, dict(urllib.parse.parse_qsl(parts.query, keep_blank_values=True)), parts

            def _reply(self, status, body=b"", ctype="application/xml"):
                self.send_response(status)
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Content-Type", ctype)
                self.end_headers()
                if self.command != "HEAD":
                    self.wfile.write(body)

            def _error(self, status, code):
                extra = f"<Message>{FAKE_SECRET}</Message>" if outer.leak_secret_in_errors else ""
                self._reply(status, f"<Error><Code>{code}</Code>{extra}</Error>".encode())

            def _auth_ok(self, body: bytes) -> bool:
                if not outer.verify:
                    return True
                auth = self.headers.get("Authorization", "")
                m = re.fullmatch(r"AWS4-HMAC-SHA256 Credential=([^/]+)/(\d{8})/([^/]+)/s3/aws4_request,SignedHeaders=([^,]+),Signature=([0-9a-f]{64})", auth)
                if not m or m.group(1) != FAKE_ACCESS:
                    return False
                if self.headers.get("x-amz-content-sha256") != hashlib.sha256(body).hexdigest():
                    return False
                names = m.group(4).split(";")
                hdrs = {n: self.headers.get(n, "") for n in names if n not in ("host", "x-amz-content-sha256", "x-amz-date")}
                parts = urllib.parse.urlsplit(self.path)
                query = dict(urllib.parse.parse_qsl(parts.query, keep_blank_values=True))
                when = datetime.strptime(self.headers.get("x-amz-date", ""), "%Y%m%dT%H%M%SZ").replace(tzinfo=timezone.utc)
                expect = persist.sign_request(self.command, self.headers.get("Host", ""), urllib.parse.unquote(parts.path), query, hdrs,
                                              self.headers.get("x-amz-content-sha256", ""), FAKE_ACCESS, FAKE_SECRET, m.group(3), when)
                return expect["authorization"] == auth

            def _handle(self):
                length = int(self.headers.get("Content-Length") or 0)
                body = self.rfile.read(length) if length else b""
                bucket, key, query, _ = self._split()
                with outer.lock:
                    outer.log.append((self.command, key))
                    if outer.fail_next > 0:
                        outer.fail_next -= 1
                        return self._error(503, "SlowDown")
                if not self._auth_ok(body):
                    return self._error(403, "SignatureDoesNotMatch")
                if bucket != BUCKET:
                    return self._error(404, "NoSuchBucket")
                if self.command == "PUT":
                    if outer.put_gate is not None:
                        outer.put_gate.wait(30)
                    if outer.fail_put_prefix and key.startswith(outer.fail_put_prefix):
                        return self._error(400, "EntityTooLarge")
                    with outer.lock:
                        outer.objects[key] = body
                    return self._reply(200)
                if self.command == "DELETE":
                    with outer.lock:
                        outer.objects.pop(key, None)
                    return self._reply(204)
                if self.command in ("GET", "HEAD") and key:
                    with outer.lock:
                        data = outer.objects.get(key)
                    if data is None:
                        return self._error(404, "NoSuchKey")
                    if self.command == "GET" and outer.truncate_get > 0 and len(data) > 10:
                        outer.truncate_get -= 1
                        self.send_response(200)
                        self.send_header("Content-Length", str(len(data)))
                        self.end_headers()
                        self.wfile.write(data[:10])
                        self.wfile.flush()
                        self.close_connection = True
                        return
                    return self._reply(200, data, "application/octet-stream")
                if self.command == "GET" and query.get("list-type") == "2":
                    prefix = query.get("prefix", "")
                    with outer.lock:
                        keys = sorted(k for k in outer.objects if k.startswith(prefix))
                    start = int(query.get("continuation-token") or 0)
                    page = keys[start:start + outer.page_size]
                    more = start + outer.page_size < len(keys)
                    xml = ['<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">']
                    xml.append(f"<IsTruncated>{'true' if more else 'false'}</IsTruncated>")
                    if more:
                        xml.append(f"<NextContinuationToken>{start + outer.page_size}</NextContinuationToken>")
                    for k in page:
                        xml.append(f"<Contents><Key>{k.replace('&', '&amp;').replace('<', '&lt;')}</Key><Size>{len(outer.objects[k])}</Size></Contents>")
                    xml.append("</ListBucketResult>")
                    return self._reply(200, "".join(xml).encode())
                return self._error(400, "BadRequest")

            do_GET = do_PUT = do_HEAD = do_DELETE = _handle

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.server.daemon_threads = True
        self.port = self.server.server_address[1]
        self.endpoint = f"http://127.0.0.1:{self.port}"
        threading.Thread(target=self.server.serve_forever, daemon=True).start()

    def close(self):
        self.server.shutdown()
        self.server.server_close()

    def keys(self, prefix=""):
        with self.lock:
            return sorted(k for k in self.objects if k.startswith(prefix))

    def count(self, method: str, prefix: str = "") -> int:
        with self.lock:
            return sum(1 for m, k in self.log if m == method and k.startswith(prefix))

    def env(self, **extra) -> dict:
        return {"BACKUP_S3_ENDPOINT": self.endpoint, "BACKUP_S3_BUCKET": BUCKET, "BACKUP_S3_ACCESS_KEY": FAKE_ACCESS,
                "BACKUP_S3_SECRET_KEY": FAKE_SECRET, "BACKUP_S3_REGION": "auto", **extra}


def make_cfg(endpoint: str, interval=1, analytics=600, prefix="alfakhama/", bucket=BUCKET) -> persist.Config:
    return persist.Config(endpoint, bucket, FAKE_ACCESS, FAKE_SECRET, "auto", prefix, interval, analytics)


def make_persist(data_dir: Path, endpoint: str, logs: list | None = None, **cfg_kw) -> persist.Persistence:
    cfg = make_cfg(endpoint, **cfg_kw)
    client = persist.S3Client(cfg, timeout=5, attempts=2, backoff=0.01, sleep=lambda s: None)
    (data_dir / "uploads").mkdir(parents=True, exist_ok=True)
    sink = logs if logs is not None else []
    return persist.Persistence(cfg, data_dir, data_dir / "store.db", data_dir / "uploads", NAME_RE, log=sink.append,
                               default_settings={"store_name": "x", "site_ready": "0"}, client=client)


def make_db(path: Path, orders: int = 0, views: int = 0, marker: str = "") -> None:
    """قاعدة صغيرة بالجداول المطلوبة (الحد الأدنى الذي تتحقق منه الاستعادة)."""
    conn = sqlite3.connect(path)
    conn.executescript("""
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '');
      CREATE TABLE IF NOT EXISTS admins (username TEXT PRIMARY KEY, password_hash TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS categories (slug TEXT PRIMARY KEY, name TEXT);
      CREATE TABLE IF NOT EXISTS products (id INTEGER PRIMARY KEY, slug TEXT, created_at TEXT, updated_at TEXT);
      CREATE TABLE IF NOT EXISTS orders (id INTEGER PRIMARY KEY, order_number TEXT);
      CREATE TABLE IF NOT EXISTS order_items (id INTEGER PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS audit_log (id INTEGER PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS page_views (day TEXT, path TEXT, views INTEGER, PRIMARY KEY (day, path)) WITHOUT ROWID;
    """)
    for i in range(orders):
        conn.execute("INSERT INTO orders(order_number) VALUES(?)", (f"N{i}",))
    if views:
        conn.execute("INSERT OR REPLACE INTO page_views VALUES('2026-01-01','/',?)", (views,))
    if marker:
        conn.execute("INSERT OR REPLACE INTO settings VALUES('marker',?)", (marker,))
    conn.commit()
    conn.close()


def read_db(path: Path):
    conn = sqlite3.connect(path)
    try:
        return (conn.execute("SELECT COUNT(*) FROM orders").fetchone()[0],
                (conn.execute("SELECT views FROM page_views").fetchone() or [0])[0],
                (conn.execute("SELECT value FROM settings WHERE key='marker'").fetchone() or [""])[0])
    finally:
        conn.close()


# ----------------------------------------------------------------------------------------------------------------
class SigV4Tests(unittest.TestCase):
    def test_official_aws_get_object_example(self):
        """مثال GET Object الرسمي من توثيق AWS (Signature Calculations for the Authorization Header):
        examplebucket / test.txt / Range bytes=0-9 / مفتاح المثال العام AKIAIOSFODNN7EXAMPLE."""
        when = datetime(2013, 5, 24, 0, 0, 0, tzinfo=timezone.utc)
        out = persist.sign_request("GET", "examplebucket.s3.amazonaws.com", "/test.txt", None, {"Range": "bytes=0-9"},
                                   persist.EMPTY_SHA256, "AKIAIOSFODNN7EXAMPLE", "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
                                   "us-east-1", when)
        self.assertEqual(out["authorization"],
                         "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request,"
                         "SignedHeaders=host;range;x-amz-content-sha256;x-amz-date,"
                         "Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41")
        self.assertEqual(out["x-amz-date"], "20130524T000000Z")

    def test_uri_and_query_encoding(self):
        self.assertEqual(persist.uri_encode("a b/é~-_.", keep_slash=True), "a%20b/%C3%A9~-_.")
        self.assertEqual(persist.uri_encode("a/b"), "a%2Fb")
        self.assertEqual(persist.canonical_query({"prefix": "a b/", "list-type": "2"}), "list-type=2&prefix=a%20b%2F")


class ConfigTests(unittest.TestCase):
    def cfg(self, **env):
        logs: list[str] = []
        base = {"BACKUP_S3_ENDPOINT": "https://x.example.com", "BACKUP_S3_BUCKET": "b", "BACKUP_S3_ACCESS_KEY": FAKE_ACCESS,
                "BACKUP_S3_SECRET_KEY": FAKE_SECRET}
        base.update(env)
        return persist.load_config({k: v for k, v in base.items() if v is not None}, log=logs.append), logs

    def test_disabled_unless_everything_set(self):
        self.assertIsNone(persist.load_config({}, log=lambda m: None))
        for missing in ("BACKUP_S3_ENDPOINT", "BACKUP_S3_BUCKET", "BACKUP_S3_ACCESS_KEY", "BACKUP_S3_SECRET_KEY"):
            cfg, logs = self.cfg(**{missing: None})
            self.assertIsNone(cfg, missing)
            self.assertTrue(any(missing in line for line in logs))

    def test_defaults_and_validation(self):
        cfg, _ = self.cfg()
        self.assertEqual((cfg.region, cfg.prefix, cfg.interval, cfg.analytics_interval), ("auto", "alfakhama/", 120, 600))
        self.assertNotIn(FAKE_SECRET, repr(cfg))
        cfg, _ = self.cfg(BACKUP_INTERVAL="30", BACKUP_S3_PREFIX="shop")
        self.assertEqual((cfg.interval, cfg.prefix, cfg.analytics_interval), (30, "shop/", 600))
        cfg, _ = self.cfg(BACKUP_INTERVAL="900")
        self.assertEqual(cfg.analytics_interval, 900, "الزيارات لا تُحفظ أسرع من الفاصل العادي")
        self.assertIsNone(self.cfg(BACKUP_S3_ENDPOINT="http://storage.example.com")[0], "http غير مسموح لغير localhost")
        self.assertIsNone(self.cfg(BACKUP_S3_ENDPOINT="ftp://x")[0])
        self.assertIsNotNone(self.cfg(BACKUP_S3_ENDPOINT="http://127.0.0.1:9000")[0])
        self.assertIsNone(self.cfg(BACKUP_S3_BUCKET="bad/bucket")[0])


class StoreCase(unittest.TestCase):
    def setUp(self):
        self.store = FakeS3()
        self.tmp = Path(tempfile.mkdtemp(prefix="fakhama-persist-"))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.addCleanup(self.store.close)
        self.a = self.tmp / "a"
        self.b = self.tmp / "b"
        self.a.mkdir()
        self.b.mkdir()


class SnapshotRestoreTests(StoreCase):
    def test_roundtrip_db_and_uploads_and_signed_requests(self):
        make_db(self.a / "store.db", orders=3, views=41, marker="m1")
        (self.a / "uploads").mkdir()
        (self.a / "uploads" / "photo1.png").write_bytes(PNG)
        (self.a / "uploads" / "photo2.jpg").write_bytes(JPEG)
        p = make_persist(self.a, self.store.endpoint)
        self.assertTrue(p.snapshot())
        self.assertIsNotNone(p.last_snapshot)
        keys = self.store.keys()
        self.assertIn("alfakhama/latest.json", keys)
        self.assertEqual(len([k for k in keys if k.startswith("alfakhama/db/")]), 1)
        manifest = json.loads(self.store.objects["alfakhama/latest.json"])
        self.assertEqual(manifest["uploads"], ["photo1.png", "photo2.jpg"])
        # الأعطاب الأخيرة: مخزن مزيّف يرفض أي توقيع خاطئ، فالنجاح يعني أن التوقيع صحيح لكل PUT/GET/LIST.
        q = make_persist(self.b, self.store.endpoint)
        self.assertEqual(q.restore_on_startup(), "restored")
        self.assertEqual(read_db(self.b / "store.db"), (3, 41, "m1"))
        self.assertEqual((self.b / "uploads" / "photo1.png").read_bytes(), PNG)
        self.assertEqual((self.b / "uploads" / "photo2.jpg").read_bytes(), JPEG)
        self.assertFalse(q.blocked)

    def test_second_snapshot_uploads_only_new_files_and_prunes_to_five(self):
        make_db(self.a / "store.db", marker="v0")
        (self.a / "uploads").mkdir()
        (self.a / "uploads" / "one.png").write_bytes(PNG)
        p = make_persist(self.a, self.store.endpoint)
        p.snapshot()
        (self.a / "uploads" / "two.png").write_bytes(PNG)
        p.snapshot()
        puts = [k for m, k in self.store.log if m == "PUT" and "/uploads/" in k]
        self.assertEqual(sorted(puts), ["alfakhama/uploads/one.png", "alfakhama/uploads/two.png"], "كل صورة تُرفع مرة واحدة فقط")
        for i in range(8):
            time.sleep(1.05)  # اسم اللقطة يحمل الثانية
            conn = sqlite3.connect(self.a / "store.db")
            conn.execute("INSERT OR REPLACE INTO settings VALUES('marker',?)", (f"v{i + 1}",))
            conn.commit()
            conn.close()
            self.assertTrue(p.snapshot())
        db_keys = [k for k in self.store.keys() if k.startswith("alfakhama/db/")]
        # الاحتفاظ طبقي: أحدث 5 + واحدة لكل ساعة؛ قد يعبر الاختبار حدّ ساعة فيزيد واحدة.
        self.assertTrue(persist.KEEP_SNAPSHOTS <= len(db_keys) <= persist.KEEP_SNAPSHOTS + 1, db_keys)
        latest = json.loads(self.store.objects["alfakhama/latest.json"])["db_key"]
        self.assertIn("alfakhama/" + latest, db_keys, "اللقطة التي يشير إليها latest.json لا تُحذف")

    def test_newest_corrupt_falls_back_to_older(self):
        make_db(self.a / "store.db", orders=1, marker="old")
        p = make_persist(self.a, self.store.endpoint)
        p.snapshot()
        time.sleep(1.1)
        conn = sqlite3.connect(self.a / "store.db")
        conn.execute("INSERT INTO orders(order_number) VALUES('N-new')")
        conn.commit()
        conn.close()
        p.snapshot()
        dbs = [k for k in self.store.keys() if k.startswith("alfakhama/db/")]
        self.assertEqual(len(dbs), 2)
        newest = max(dbs)
        # (1) محتوى تالف: لا يطابق SHA-256 المسجل
        self.store.objects[newest] = self.store.objects[newest][:-5] + b"XXXXX"
        logs: list[str] = []
        q = make_persist(self.b, self.store.endpoint, logs)
        self.assertEqual(q.restore_on_startup(), "restored")
        self.assertEqual(read_db(self.b / "store.db")[0], 1, "استُعملت اللقطة الأقدم")
        self.assertTrue(any("تالفة" in line for line in logs))
        # (2) ملف سليم الهاش لكنه ليس قاعدة SQLite
        shutil.rmtree(self.b)
        self.b.mkdir()
        junk = gzip.compress(b"this is not a sqlite database" * 50)
        sha = hashlib.sha256(junk).hexdigest()
        bad_key = f"db/20990101T000000Z-{sha[:16]}.db.gz"
        self.store.objects["alfakhama/" + bad_key] = junk
        self.store.objects["alfakhama/latest.json"] = json.dumps({"db_key": bad_key, "sha256": sha, "size": len(junk)}).encode()
        q = make_persist(self.b, self.store.endpoint)
        self.assertEqual(q.restore_on_startup(), "restored")
        self.assertEqual(read_db(self.b / "store.db")[0], 1)
        # (3) كل اللقطات تالفة => قاعدة جديدة (لا انهيار) والرفع مسموح
        for k in list(self.store.objects):
            if k.startswith("alfakhama/db/"):
                self.store.objects[k] = b"garbage"
        shutil.rmtree(self.b)
        self.b.mkdir()
        q = make_persist(self.b, self.store.endpoint)
        self.assertEqual(q.restore_on_startup(), "corrupt_all")
        self.assertFalse((self.b / "store.db").exists())
        self.assertFalse(q.blocked)

    def test_non_empty_local_database_is_never_overwritten(self):
        make_db(self.a / "store.db", orders=2, marker="remote")
        make_persist(self.a, self.store.endpoint).snapshot()
        make_db(self.b / "store.db", orders=1, marker="local-real")
        before = (self.b / "store.db").read_bytes()
        q = make_persist(self.b, self.store.endpoint)
        self.assertEqual(q.restore_on_startup(), "local_kept")
        self.assertEqual((self.b / "store.db").read_bytes(), before)
        # حتى طلب واحد أو رسالة أو سجل إدارة يكفي لاعتبارها بيانات حقيقية
        for table in ("messages", "audit_log"):
            shutil.rmtree(self.b)
            self.b.mkdir()
            make_db(self.b / "store.db", marker="local-real")
            conn = sqlite3.connect(self.b / "store.db")
            conn.execute(f"INSERT INTO {table} DEFAULT VALUES")
            conn.commit()
            conn.close()
            self.assertEqual(make_persist(self.b, self.store.endpoint).restore_on_startup(), "local_kept", table)
        # ملف ليس قاعدة بيانات: لا نلمسه
        shutil.rmtree(self.b)
        self.b.mkdir()
        (self.b / "store.db").write_bytes(b"not a database at all, keep me")
        self.assertEqual(make_persist(self.b, self.store.endpoint).restore_on_startup(), "local_kept")
        self.assertEqual((self.b / "store.db").read_bytes(), b"not a database at all, keep me")

    def test_pristine_seed_is_replaced_by_remote_snapshot(self):
        make_db(self.a / "store.db", orders=2, marker="remote")
        make_persist(self.a, self.store.endpoint).snapshot()
        conn = sqlite3.connect(self.b / "store.db")
        conn.executescript("""CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL DEFAULT '');
            CREATE TABLE products (id INTEGER PRIMARY KEY, slug TEXT, created_at TEXT, updated_at TEXT);
            INSERT INTO settings VALUES('store_name','x'),('site_ready','0'),('seed_wavy_v1','1');
            INSERT INTO products VALUES(1,'wavy-01','t','t');""")
        conn.commit()
        conn.close()
        (self.b / "store.db-wal").write_bytes(b"stale")
        q = make_persist(self.b, self.store.endpoint)
        self.assertEqual(q.restore_on_startup(), "restored")
        self.assertEqual(read_db(self.b / "store.db")[0], 2)
        self.assertFalse((self.b / "store.db-wal").exists(), "ملفات WAL القديمة تُحذف مع الاستبدال")
        # بعد تعديل منتج لم تعد بذرة
        shutil.rmtree(self.b)
        self.b.mkdir()
        conn = sqlite3.connect(self.b / "store.db")
        conn.executescript("""CREATE TABLE products (id INTEGER PRIMARY KEY, slug TEXT, created_at TEXT, updated_at TEXT);
            INSERT INTO products VALUES(1,'wavy-01','t','changed');""")
        conn.commit()
        conn.close()
        self.assertEqual(make_persist(self.b, self.store.endpoint).restore_on_startup(), "local_kept")

    def test_hostile_keys_are_ignored(self):
        make_db(self.a / "store.db", marker="ok")
        (self.a / "uploads").mkdir()
        (self.a / "uploads" / "good.png").write_bytes(PNG)
        make_persist(self.a, self.store.endpoint).snapshot()
        pre = "alfakhama/"
        evil = {pre + "uploads/../../evil.txt": b"x", pre + "uploads/..": b"x", pre + "uploads/sub/dir.png": b"x",
                pre + "uploads/.hidden": b"x", pre + "uploads/a b.png": b"x", pre + "uploads/%2e%2e%2fescape.png": b"x",
                pre + "uploads/back\\slash.png": b"x", pre + "uploads/" + "a" * 300 + ".png": b"x",
                pre + "db/../../x.db.gz": b"x", pre + "db/20260101T000000Z-zzzz.db.gz": b"x", pre + "uploads/": b"x"}
        self.store.objects.update(evil)
        q = make_persist(self.b, self.store.endpoint)
        self.assertEqual(q.restore_on_startup(), "restored")
        self.assertEqual(sorted(os.listdir(self.b / "uploads")), ["good.png"])
        for path in self.tmp.rglob("*"):
            self.assertNotIn("evil", path.name)
        self.assertFalse((self.tmp / "evil.txt").exists())
        self.assertFalse((self.b / "evil.txt").exists())

    def test_unreachable_bucket_blocks_uploads_and_never_crashes(self):
        dead = free_port()
        logs: list[str] = []
        p = make_persist(self.b, f"http://127.0.0.1:{dead}", logs)
        self.assertEqual(p.restore_on_startup(), "unreachable")
        self.assertTrue(p.blocked)
        make_db(self.b / "store.db", marker="fresh-seed")
        p.mark_dirty()
        self.assertFalse(p.snapshot(), "بذرة جديدة لا تُرفع فوق نسخة لا نعرف حالتها")
        self.assertFalse(p.flush(1))
        self.assertTrue(any("unreachable" in line for line in logs))

    def test_empty_bucket_is_fresh_start_and_not_blocked(self):
        q = make_persist(self.b, self.store.endpoint)
        self.assertEqual(q.restore_on_startup(), "no_remote")
        self.assertFalse(q.blocked)

    def test_transient_errors_are_retried(self):
        make_db(self.a / "store.db", marker="r")
        p = make_persist(self.a, self.store.endpoint)
        self.store.fail_next = 1
        self.assertTrue(p.snapshot())

    def test_error_text_never_contains_secrets(self):
        make_db(self.a / "store.db", marker="r")
        logs: list[str] = []
        p = make_persist(self.a, self.store.endpoint, logs)
        self.store.leak_secret_in_errors = True
        self.store.verify = True
        self.store.fail_next = 100  # كل الطلبات 503 مع نص يحوي السر
        self.assertFalse(p.snapshot())
        self.assertTrue(p.last_error)
        joined = "\n".join(logs) + p.last_error
        self.assertNotIn(FAKE_SECRET, joined)
        self.assertNotIn(FAKE_ACCESS, joined)


class CadenceTests(StoreCase):
    def test_analytics_only_is_slow_important_is_fast_and_flush_persists(self):
        make_db(self.a / "store.db", views=1, marker="c")
        p = make_persist(self.a, self.store.endpoint, interval=1, analytics=4)
        p.start()
        self.addCleanup(p._stop.set)
        time.sleep(0.3)
        p.mark_dirty(analytics_only=True)
        time.sleep(2.2)
        self.assertEqual(self.store.count("PUT", "alfakhama/db/"), 0, "الزيارات وحدها لا تسبب رفعًا فوريًا")
        time.sleep(3.0)
        self.assertEqual(self.store.count("PUT", "alfakhama/db/"), 1, "تُحفظ بالوتيرة الأبطأ")
        # تغيير مهم يُحفظ خلال الفاصل العادي
        conn = sqlite3.connect(self.a / "store.db")
        conn.execute("INSERT INTO orders(order_number) VALUES('N1')")
        conn.commit()
        conn.close()
        p.mark_dirty()
        time.sleep(0.2)
        deadline = time.time() + 4
        while time.time() < deadline and self.store.count("PUT", "alfakhama/db/") < 2:
            time.sleep(0.2)
        self.assertEqual(self.store.count("PUT", "alfakhama/db/"), 2)

    def test_flush_uploads_pending_analytics(self):
        make_db(self.a / "store.db", views=7, marker="f")
        p = make_persist(self.a, self.store.endpoint, interval=1, analytics=600)
        p.mark_dirty(analytics_only=True)
        self.assertTrue(p.flush(10))
        q = make_persist(self.b, self.store.endpoint)
        self.assertEqual(q.restore_on_startup(), "restored")
        self.assertEqual(read_db(self.b / "store.db")[1], 7)
        self.assertFalse(make_persist(self.tmp, self.store.endpoint).flush(1), "لا شيء متسخ => لا رفع")

    def test_flush_respects_time_budget(self):
        make_db(self.a / "store.db", marker="slow")
        dead = make_persist(self.a, "http://127.0.0.1:%d" % free_port())
        dead.mark_dirty()
        started = time.monotonic()
        self.assertFalse(dead.flush(2))
        self.assertLess(time.monotonic() - started, 5)


# ----------------------------------------------------------------------------------------------------------------
# تشغيل الخادم الحقيقي كعملية فرعية على المخزن المزيّف
# ----------------------------------------------------------------------------------------------------------------
class ReviewFixTests(StoreCase):
    def test_flush_waits_for_in_flight_snapshot(self):
        make_db(self.a / "store.db", marker="v1")
        p = make_persist(self.a, self.store.endpoint)
        gate = threading.Event()
        self.store.put_gate = gate
        p.mark_dirty()
        t = threading.Thread(target=p.snapshot, daemon=True)
        t.start()
        time.sleep(0.5)  # اللقطة الخلفية مسحت العلامات وهي معلّقة في PUT
        threading.Timer(0.5, gate.set).start()
        started = time.monotonic()
        p.flush(10)
        self.assertGreaterEqual(time.monotonic() - started, 0.3, "flush انتظر اللقطة الجارية")
        self.assertIn("alfakhama/latest.json", self.store.keys())

    def test_failing_image_does_not_block_database_snapshot(self):
        make_db(self.a / "store.db", marker="v1")
        p = make_persist(self.a, self.store.endpoint)
        (self.a / "uploads" / "bad.png").write_bytes(PNG)
        self.store.fail_put_prefix = "alfakhama/uploads/"
        self.assertTrue(p.snapshot())
        self.assertTrue([k for k in self.store.keys() if k.startswith("alfakhama/db/")])
        self.assertTrue(p._dirty_important, "الصورة المتخطاة تُعاد محاولتها")

    def test_truncated_download_is_unreachable_not_corrupt(self):
        make_db(self.a / "store.db", orders=2, marker="real")
        make_persist(self.a, self.store.endpoint).snapshot()
        q = make_persist(self.b, self.store.endpoint)
        self.store.truncate_get = 100
        self.assertEqual(q.restore_on_startup(), "unreachable")
        self.assertTrue(q.blocked, "لا نرفع بذرة فارغة فوق النسخة الحقيقية")
        self.assertFalse((self.b / "store.db").exists())

    def test_overlapping_instance_snapshot_is_kept_in_conflicts(self):
        make_db(self.a / "store.db", orders=1, marker="base")
        make_persist(self.a, self.store.endpoint).snapshot()
        old = make_persist(self.a, self.store.endpoint)
        new = make_persist(self.b, self.store.endpoint)
        self.assertEqual(new.restore_on_startup(), "restored")
        time.sleep(1.1)
        conn = sqlite3.connect(self.a / "store.db"); conn.execute("INSERT INTO orders(order_number) VALUES('OLD')"); conn.commit(); conn.close()
        self.assertTrue(old.snapshot())
        time.sleep(1.1)
        conn = sqlite3.connect(self.b / "store.db"); conn.execute("INSERT INTO orders(order_number) VALUES('NEW')"); conn.commit(); conn.close()
        self.assertTrue(new.snapshot())
        self.assertTrue([k for k in self.store.keys() if k.startswith("alfakhama/conflicts/")], "نسخة الكاتب الآخر محفوظة")

    def test_tiered_retention(self):
        now = datetime(2026, 1, 20, 12, 0, 0, tzinfo=timezone.utc)
        def key(dt): return "db/" + dt.strftime("%Y%m%dT%H%M%SZ") + "-" + "0" * 16 + ".db.gz"
        from datetime import timedelta
        keys = [key(now - timedelta(minutes=m)) for m in range(0, 600, 2)] + [key(now - timedelta(days=d, hours=1)) for d in range(1, 30)]
        keep = persist.select_keep(keys, now)
        self.assertIn(key(now), keep)
        self.assertIn(key(now - timedelta(days=10, hours=1)), keep, "نسخة يومية قديمة")
        self.assertNotIn(key(now - timedelta(days=20, hours=1)), keep)
        self.assertLess(len(keep), 60)

    def test_bad_endpoints_disable_instead_of_crashing(self):
        env = {"BACKUP_S3_BUCKET": BUCKET, "BACKUP_S3_ACCESS_KEY": FAKE_ACCESS, "BACKUP_S3_SECRET_KEY": FAKE_SECRET}
        for bad in ("https://host:abc", "https://host:99999", "https://[::1"):
            self.assertIsNone(persist.load_config({**env, "BACKUP_S3_ENDPOINT": bad}, log=lambda m: None), bad)


class ServerPersistenceTests(ServerCase):
    """لقطة -> SIGTERM -> مسح DATA_DIR -> إقلاع جديد: كل شيء يعود، ومنه إحصاءات الزيارات."""
    store: FakeS3

    @classmethod
    def setUpClass(cls):
        cls.store = FakeS3()
        cls.admin_password = "Test-only-password-not-real-1"
        cls.env = {"ADMIN_PASSWORD": cls.admin_password, "SITE_READY_DEFAULT": "1", "BACKUP_INTERVAL": "1",
                   **cls.store.env()}
        cls.start_server(env=cls.env)

    @classmethod
    def tearDownClass(cls):
        cls.stop_server()
        cls.store.close()

    def visit(self, path, referer=None, n=1):
        for _ in range(n):
            h = {"User-Agent": "Mozilla/5.0 (test browser)"}
            if referer:
                h["Referer"] = referer
            self.assertEqual(self.req("GET", path, headers=h)[0], 200, path)

    def wait_for(self, predicate, timeout=15):
        end = time.time() + timeout
        while time.time() < end:
            if predicate():
                return True
            time.sleep(0.2)
        return False

    def snapshot_of_state(self, cookie, csrf):
        kw = {"cookie": cookie, "csrf": csrf}
        dash = self.json("GET", "/api/admin/dashboard?range=30", **kw)[1]
        return {
            "products": sorted((p["slug"], p["name"], p["price"]) for p in self.json("GET", "/api/admin/products", **kw)[1]["products"]),
            "orders": sorted(o["order_number"] for o in self.json("GET", "/api/admin/orders", **kw)[1]["orders"]),
            "messages": sorted(m["message"] for m in self.json("GET", "/api/admin/messages", **kw)[1]["messages"]),
            "tagline": self.json("GET", "/api/admin/settings", **kw)[1]["settings"]["tagline"],
            "site_ready": self.json("GET", "/api/store")[1]["site_ready"],
            "visits": dash["kpis"]["visits_period"],
            "top_pages": dash["top_pages"],
            "referrers": dash["referrers"],
            "analytics": self.json("GET", "/api/admin/analytics?days=30", **kw)[1],
        }

    def test_full_cycle_survives_wipe_including_visit_statistics(self):
        cookie, csrf = self.login()
        kw = {"cookie": cookie, "csrf": csrf}
        health = self.json("GET", "/api/health")[1]
        self.assertNotIn("persistence", health, "الصحة العامة لا تكشف وضع النسخ")
        self.assertNotIn("last_snapshot", health)
        self.assertTrue(self.json("GET", "/api/store")[1]["site_ready"], "SITE_READY_DEFAULT=1 لقاعدة جديدة")
        # بيانات مهمة
        up = self.json("POST", "/api/admin/upload", {"data": data_uri("image/png", PNG), "thumb": data_uri("image/jpeg", JPEG)}, **kw)[1]
        status, product, _ = self.json("POST", "/api/admin/products", {"name": "ستارة اختبار الحفظ", "category": "curtains", "price": 123,
                                                                      "stock": 4, "image": up["url"]}, **kw)
        self.assertEqual(status, 201, product)
        status, order, _ = self.json("POST", "/api/orders", {"name": "عميل", "phone": "0551234567", "city": "جدة", "consent": True,
                                                            "items": [{"id": product["product"]["id"], "quantity": 2}]})
        self.assertEqual(status, 201, order)
        self.assertEqual(self.json("POST", "/api/contact", {"name": "عميل التواصل", "phone": "0551234567", "message": "رسالة اختبار الحفظ الدائم",
                                                          "consent": True})[0], 201)
        self.assertEqual(self.json("PUT", "/api/admin/settings", {"tagline": "شعار محفوظ", "site_ready": False}, **kw)[0], 200)
        # يجب أن تظهر لقطة مهمة بسرعة
        self.assertTrue(self.wait_for(lambda: "alfakhama/latest.json" in self.store.keys()), "لم تظهر لقطة")
        self.assertTrue(self.wait_for(lambda: any(k.startswith("alfakhama/uploads/") for k in self.store.keys())), "لم تُرفع الصورة")
        time.sleep(2.5)  # تستقر اللقطات المهمة
        # الزيارات وحدها (تحليلات): لا لقطة فورية
        puts_before = self.store.count("PUT", "alfakhama/db/")
        self.visit("/products", referer="https://www.google.com/search?q=x", n=5)
        self.visit("/about", n=3)
        time.sleep(3.0)
        self.assertEqual(self.store.count("PUT", "alfakhama/db/"), puts_before, "زيارات الزوار لا تسبب رفعًا")
        state = self.snapshot_of_state(cookie, csrf)
        self.assertGreaterEqual(state["visits"], 8)
        self.assertFalse(state["site_ready"], "قيمة حفظها المدير لا تُلغى")
        # SIGTERM: اللقطة الأخيرة تحفظ الزيارات
        self.proc.send_signal(signal.SIGTERM)
        out, err = self.proc.communicate(timeout=30)
        self.assertEqual(self.proc.returncode, 0)
        self.assertGreater(self.store.count("PUT", "alfakhama/db/"), puts_before, "SIGTERM لم يرفع لقطة نهائية")
        # لا أسرار في المخرجات
        for secret in (FAKE_SECRET, FAKE_ACCESS, self.admin_password):
            self.assertNotIn(secret, out)
            self.assertNotIn(secret, err)
        # مسح كل شيء ثم إقلاع جديد
        shutil.rmtree(self.data_dir)
        os.makedirs(self.data_dir)
        self.start_server(data_dir=self.data_dir, env=self.env)
        cookie, csrf = self.login()
        again = self.snapshot_of_state(cookie, csrf)
        # الزيارة التي أحدثها تسجيل الدخول/الطلبات بعد الإقلاع لا تُحتسب هنا لأنها طلبات API؛ المقارنة كاملة
        self.assertEqual(again["products"], state["products"])
        self.assertEqual(again["orders"], state["orders"])
        self.assertEqual(again["messages"], state["messages"])
        self.assertEqual(again["tagline"], "شعار محفوظ")
        self.assertFalse(again["site_ready"], "SITE_READY_DEFAULT لا يطغى على قيمة محفوظة")
        self.assertEqual(again["visits"], state["visits"], "إحصاءات الزيارات عادت كاملة")
        self.assertEqual(again["top_pages"], state["top_pages"])
        self.assertEqual(again["referrers"], state["referrers"])
        self.assertEqual(again["analytics"]["daily"], state["analytics"]["daily"])
        self.assertEqual(self.req("GET", up["url"])[0], 200, "الصورة المرفوعة عادت")
        dash = self.json("GET", "/api/admin/dashboard?range=7", cookie=cookie, csrf=csrf)[1]
        self.assertEqual(dash["storage"]["mode"], "s3")
        self.assertEqual(dash["storage"]["warning"], "")
        self.assertNotIn("storage", self.json("GET", "/api/admin/dashboard", cookie=cookie, csrf=csrf)[1], "الشكل القديم دون تغيير")


class SiteReadyDefaultTests(ServerCase):
    ENV = {"SITE_READY_DEFAULT": "1"}

    def test_only_new_databases_get_the_default(self):
        self.assertTrue(self.json("GET", "/api/store")[1]["site_ready"])
        cookie, csrf = self.login()
        self.assertEqual(self.json("PUT", "/api/admin/settings", {"site_ready": False}, cookie=cookie, csrf=csrf)[0], 200)
        self.proc.terminate()
        self.proc.communicate(timeout=10)
        self.start_server(data_dir=self.data_dir, env={"ADMIN_PASSWORD": self.admin_password, **self.ENV})
        self.assertFalse(self.json("GET", "/api/store")[1]["site_ready"], "قيمة المدير المحفوظة لا تُستبدل")


class NoDefaultTests(ServerCase):
    def test_default_remains_demo_without_the_variable(self):
        self.assertFalse(self.json("GET", "/api/store")[1]["site_ready"])


class HealthAndWarningTests(ServerCase):
    ENV = {"TRUST_PROXY": "1", "PUBLIC_BASE_URL": "https://shop.example.com"}

    def test_mode_and_warning_follow_the_rules(self):
        health = self.json("GET", "/api/health")[1]
        on_other_device = os.stat(self.data_dir).st_dev != os.stat("/").st_dev
        expected = "disk" if on_other_device or os.path.ismount(self.data_dir) else "ephemeral"
        self.assertNotIn("persistence", health)
        self.assertNotIn("last_snapshot", health)
        cookie, csrf = self.login()
        storage = self.json("GET", "/api/admin/dashboard?range=7", cookie=cookie, csrf=csrf,
                            headers={"X-Forwarded-Proto": "https"})[1]["storage"]
        self.assertEqual(storage["mode"], expected)
        self.assertIn("last_snapshot", storage)
        self.assertFalse(storage["blocked"])
        self.assertEqual(bool(storage["warning"]), expected == "ephemeral")
        if storage["warning"]:
            self.assertRegex(storage["warning"], r"[؀-ۿ]")


class LocalNoWarningTests(ServerCase):
    def test_no_warning_outside_production(self):
        cookie, csrf = self.login()
        storage = self.json("GET", "/api/admin/dashboard?range=7", cookie=cookie, csrf=csrf)[1]["storage"]
        self.assertEqual(storage["warning"], "")
        self.assertIn(storage["mode"], ("ephemeral", "disk"))


class SigtermWithoutStoreTests(ServerCase):
    def test_sigterm_still_exits_cleanly_when_disabled(self):
        self.proc.send_signal(signal.SIGTERM)
        self.proc.communicate(timeout=15)
        self.assertEqual(self.proc.returncode, 0)
        self.start_server(data_dir=self.data_dir)  # لتنظيف tearDown


# ----------------------------------------------------------------------------------------------------------------
# اختيارية: مخزن S3 حقيقي المحاكاة (moto) إن توفر
# ----------------------------------------------------------------------------------------------------------------
MOTO = os.environ.get("MOTO_SERVER") or shutil.which("moto_server")


@unittest.skipUnless(MOTO, "moto_server غير متوفر (اختياري)")
class MotoEndToEndTests(unittest.TestCase):
    def test_roundtrip_against_moto(self):
        port = free_port()
        env = {k: v for k, v in os.environ.items() if not k.lower().endswith("_proxy")}
        proc = subprocess.Popen([MOTO, "-H", "127.0.0.1", "-p", str(port)], env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.addCleanup(proc.wait)
        self.addCleanup(proc.terminate)
        end = time.time() + 20
        while time.time() < end:
            try:
                socket.create_connection(("127.0.0.1", port), timeout=0.3).close()
                break
            except OSError:
                time.sleep(0.2)
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        opener.open(urllib.request.Request(f"http://127.0.0.1:{port}/{BUCKET}", method="PUT"), timeout=10).read()
        tmp = Path(tempfile.mkdtemp(prefix="fakhama-moto-"))
        self.addCleanup(shutil.rmtree, tmp, True)
        a, b = tmp / "a", tmp / "b"
        a.mkdir()
        b.mkdir()
        make_db(a / "store.db", orders=5, views=99, marker="moto")
        (a / "uploads").mkdir()
        for i in range(5):  # أكثر من صفحة واحدة في القائمة
            (a / "uploads" / f"img{i}.png").write_bytes(PNG)
        p = make_persist(a, f"http://127.0.0.1:{port}")
        self.assertTrue(p.snapshot(), p.last_error)
        q = make_persist(b, f"http://127.0.0.1:{port}")
        self.assertEqual(q.restore_on_startup(), "restored")
        self.assertEqual(read_db(b / "store.db"), (5, 99, "moto"))
        self.assertEqual(sorted(os.listdir(b / "uploads")), [f"img{i}.png" for i in range(5)])


if __name__ == "__main__":
    unittest.main()
