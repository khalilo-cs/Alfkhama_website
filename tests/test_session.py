# ملف اختبار: يتأكد أن جلسة المدير لا تنكسر عندما يتغير عنوان IP القادم عبر البروكسي (Render والشبكات المحمولة).
# يعتمد على ServerCase من test_app.py الذي يشغّل app.py كعملية فعلية ويرسل إليها طلبات HTTP حقيقية.
"""The admin session must survive a changing proxy address (hosting platforms and mobile networks rotate it per request)."""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_app import ServerCase  # noqa: E402


# ---- اختبارات الجلسة خلف بروكسي ----
# TRUST_PROXY=1 يجعل الخادم يثق برؤوس X-Forwarded-*؛ PUBLIC_BASE_URL يحدد العنوان العام للموقع.
class SessionBehindProxyTests(ServerCase):
    ENV = {"TRUST_PROXY": "1", "PUBLIC_BASE_URL": "https://shop.example.com"}

    # نسجّل الدخول مرة واحدة ثم نطلب لوحة التحكم بعدة عناوين IP مختلفة (IPv4 وقائمة وIPv6)؛
    # الجلسة يجب ألا ترتبط بعنوان IP واحد وإلا سيُطرد المدير عند تغيّره.
    def test_session_stays_valid_when_the_forwarded_address_changes(self):
        cookie, csrf = self.login()
        for address in ("203.0.113.10", "198.51.100.77", "192.0.2.5, 198.51.100.200", "2001:db8::1"):
            status, _, _ = self.json("GET", "/api/admin/dashboard", cookie=cookie, csrf=csrf,
                                     headers={"X-Forwarded-Proto": "https", "X-Forwarded-For": address})
            self.assertEqual(status, 200, address)

    # أمان: الصفحة العامة (الزائر غير المسجّل) يجب ألا تحتوي أي أدوات إدارة أو نص شريط المدير.
    def test_storefront_never_renders_admin_tools(self):
        html = self.req("GET", "/")[2].decode("utf-8")
        self.assertNotIn("adminBar", html)
        self.assertNotIn("أنت مسجّل دخول كمدير", html)
