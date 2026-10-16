"""The admin session must survive a changing proxy address (hosting platforms and mobile networks rotate it per request)."""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_app import ServerCase  # noqa: E402


class SessionBehindProxyTests(ServerCase):
    ENV = {"TRUST_PROXY": "1", "PUBLIC_BASE_URL": "https://shop.example.com"}

    def test_session_stays_valid_when_the_forwarded_address_changes(self):
        cookie, csrf = self.login()
        for address in ("203.0.113.10", "198.51.100.77", "192.0.2.5, 198.51.100.200", "2001:db8::1"):
            status, _, _ = self.json("GET", "/api/admin/dashboard", cookie=cookie, csrf=csrf,
                                     headers={"X-Forwarded-Proto": "https", "X-Forwarded-For": address})
            self.assertEqual(status, 200, address)

    def test_storefront_never_renders_admin_tools(self):
        html = self.req("GET", "/")[2].decode("utf-8")
        self.assertNotIn("adminBar", html)
        self.assertNotIn("أنت مسجّل دخول كمدير", html)
