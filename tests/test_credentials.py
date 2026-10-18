# ملف اختبار: مزامنة بيانات دخول المدير من متغيرات البيئة (ADMIN_USERNAME / ADMIN_PASSWORD) وأمر set-admin.
# كلمات المرور هنا تُولَّد عشوائياً لكل اختبار ولا تُكتب في الملفات؛ والمبدأ أن كلمة المرور تأتي من البيئة فقط.
"""Admin credential sync from the environment and the set-admin CLI. Every test uses its own temporary data folder."""
from __future__ import annotations

import os
import secrets
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_app import ROOT, ServerCase  # noqa: E402


# ---- أدوات مساعدة ----
# ينشئ كلمة مرور عشوائية قوية لكل اختبار (البادئة K تضمن وجود حرف كبير).
def new_password() -> str:
    return "K" + secrets.token_urlsafe(16)


# ---- مزامنة بيانات المدير عند تشغيل الخادم ----
# كل اختبار يعمل بمجلد بيانات مؤقت خاص به، لذلك نتجاوز setUpClass/tearDownClass الذي يشغّل خادماً مشتركاً.
class CredentialSyncTest(ServerCase):
    @classmethod
    def setUpClass(cls):
        pass

    @classmethod
    def tearDownClass(cls):
        pass

    def setUp(self):
        self.data = tempfile.mkdtemp(prefix="fakhama-cred-")
        self.addCleanup(shutil.rmtree, self.data, True)

    # يشغّل الخادم على مجلد البيانات المؤقت بالبيئة المعطاة، ويضمن إيقافه عند نهاية الاختبار.
    def run_server(self, **env):
        type(self).start_server(data_dir=self.data, env=env)
        self.addCleanup(type(self).stop_server, False)

    # يحاول تسجيل الدخول ويعيد رمز الحالة فقط (200 نجاح، 401 فشل).
    def login_status(self, username, password):
        return self.json("POST", "/api/admin/login", {"username": username, "password": password})[0]

    # يقرأ أسماء الإجراءات من جدول audit_log مباشرة في قاعدة SQLite لفحص ما سُجّل في سجل التدقيق.
    def audit_actions(self):
        conn = sqlite3.connect(Path(self.data) / "store.db")
        try:
            return [r[0] for r in conn.execute("SELECT action FROM audit_log")]
        finally:
            conn.close()

    # السيناريو الكامل: إنشاء أول مرة، ثم استبدال البيانات عند تغيّر البيئة، ثم عدم الكتابة فوق كلمة غيّرها المدير،
    # ثم التأكد أن أي سر لا يتسرب إلى سجل التدقيق أو بصمة الإعدادات.
    def test_sync_flow(self):
        first, second, third = new_password(), new_password(), new_password()
        # 1. first run creates the admin from the environment (no sync audit entry)
        self.run_server(ADMIN_USERNAME="owner", ADMIN_PASSWORD=first)
        self.assertEqual(self.login_status("owner", first), 200)
        self.assertNotIn("admin_credentials_synced", self.audit_actions())
        type(self).stop_server(False)
        # 2. changed environment on the existing database replaces username and password
        self.run_server(ADMIN_USERNAME="admin", ADMIN_PASSWORD=second)
        self.assertEqual(self.login_status("admin", second), 200)
        self.assertEqual(self.login_status("owner", first), 401)
        self.assertEqual(self.login_status("admin", first), 401)
        self.assertEqual(self.audit_actions().count("admin_credentials_synced"), 1)
        cookie, csrf = self.login(second, "admin")
        # 3. the admin changes the password in the panel; restarting with the SAME env must not overwrite it
        status, data, _ = self.json("POST", "/api/admin/password", {"current_password": second, "new_password": third}, cookie=cookie, csrf=csrf)
        self.assertEqual(status, 200, data)
        type(self).stop_server(False)
        self.run_server(ADMIN_USERNAME="admin", ADMIN_PASSWORD=second)
        self.assertEqual(self.login_status("admin", third), 200)
        self.assertEqual(self.login_status("admin", second), 401)
        self.assertEqual(self.audit_actions().count("admin_credentials_synced"), 1)
        # البصمة admin_cred_fp مخزّنة كـ salt(32 hex) + $ + hash(64 hex) ولا تحتوي كلمة المرور نفسها.
        # 4. nothing secret ended up in the audit trail or the settings fingerprint
        conn = sqlite3.connect(Path(self.data) / "store.db")
        dump = " ".join(str(v) for row in conn.execute("SELECT detail FROM audit_log") for v in row)
        fingerprint = conn.execute("SELECT value FROM settings WHERE key='admin_cred_fp'").fetchone()[0]
        conn.close()
        for secret in (first, second, third):
            self.assertNotIn(secret, dump)
            self.assertNotIn(secret, fingerprint)
        self.assertRegex(fingerprint, r"^[0-9a-f]{32}\$[0-9a-f]{64}$")

    # كلمة مرور ضعيفة (قصيرة) في البيئة تُتجاهل ويبقى الدخول بكلمة المرور السابقة.
    def test_weak_password_is_not_applied(self):
        good = new_password()
        self.run_server(ADMIN_PASSWORD=good)
        type(self).stop_server(False)
        self.run_server(ADMIN_USERNAME="admin", ADMIN_PASSWORD="short1")
        self.assertEqual(self.login_status("admin", good), 200)
        self.assertEqual(self.login_status("admin", "short1"), 401)

    # مزامنة كلمة المرور لا يجوز أن تمسح سر المصادقة الثنائية (TOTP) المحفوظ للمدير.
    def test_totp_is_kept(self):
        first, second = new_password(), new_password()
        self.run_server(ADMIN_PASSWORD=first)
        type(self).stop_server(False)
        conn = sqlite3.connect(Path(self.data) / "store.db")
        conn.execute("UPDATE admins SET totp_secret='JBSWY3DPEHPK3PXP'")
        conn.commit(); conn.close()
        self.run_server(ADMIN_PASSWORD=second)
        conn = sqlite3.connect(Path(self.data) / "store.db")
        self.assertEqual(conn.execute("SELECT totp_secret FROM admins").fetchone()[0], "JBSWY3DPEHPK3PXP")
        conn.close()


# ---- أمر set-admin من سطر الأوامر ----
class SetAdminCliTest(unittest.TestCase):
    # يشغّل `python app.py set-admin` في عملية منفصلة؛ نحذف أي بيانات مدير موروثة من البيئة قبل ذلك،
    # ونعطّل ملف .env (ENV_FILE=off) ونغلق stdin كي لا ينتظر الأمر إدخالاً من لوحة المفاتيح.
    def cli(self, data_dir, **env):
        full = {k: v for k, v in os.environ.items() if k not in ("ADMIN_PASSWORD", "ADMIN_USERNAME")}
        full.update({"DATA_DIR": data_dir, "ENV_FILE": "off", **env})
        return subprocess.run([sys.executable, "-I", str(ROOT / "app.py"), "set-admin"], cwd=data_dir, env=full,
                              capture_output=True, text=True, stdin=subprocess.DEVNULL, timeout=60)

    # يتأكد أن كلمة المرور لا تُطبع في المخرجات، وأنها مخزّنة كـ PBKDF2-SHA256 بـ 310000 تكرار (salt$digest).
    def test_set_admin_from_env(self):
        data = tempfile.mkdtemp(prefix="fakhama-cli-")
        self.addCleanup(shutil.rmtree, data, True)
        password = new_password()
        result = self.cli(data, ADMIN_USERNAME="admin", ADMIN_PASSWORD=password)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn(password, result.stdout + result.stderr)
        sys.path.insert(0, str(ROOT))
        conn = sqlite3.connect(Path(data) / "store.db")
        username, stored = conn.execute("SELECT username,password_hash FROM admins").fetchone()
        conn.close()
        self.assertEqual(username, "admin")
        import hashlib
        salt_hex, digest = stored.split("$")
        self.assertEqual(hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt_hex), 310_000).hex(), digest)
        # second call with a new password replaces it
        again = new_password()
        self.assertEqual(self.cli(data, ADMIN_USERNAME="boss", ADMIN_PASSWORD=again).returncode, 0)
        conn = sqlite3.connect(Path(data) / "store.db")
        self.assertEqual(conn.execute("SELECT username FROM admins").fetchone()[0], "boss")
        conn.close()

    # رمز الخروج 2 يعني رفض الأمر: كلمة مرور ضعيفة، أو غياب كلمة المرور تماماً مع عدم وجود طرفية للسؤال.
    def test_set_admin_rejects_weak_and_missing(self):
        data = tempfile.mkdtemp(prefix="fakhama-cli-")
        self.addCleanup(shutil.rmtree, data, True)
        self.assertEqual(self.cli(data, ADMIN_PASSWORD="tiny").returncode, 2)
        self.assertEqual(self.cli(data).returncode, 2)  # no env and no terminal


if __name__ == "__main__":
    unittest.main()
