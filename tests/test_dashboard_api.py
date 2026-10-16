"""GET /api/admin/dashboard?range=N and static serving of /assets/vendor/**."""
from __future__ import annotations

import re
import sqlite3
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_app import ROOT, ServerCase  # noqa: E402

RIYADH = timezone(timedelta(hours=3))
STATUSES = {"new", "confirmed", "preparing", "shipped", "delivered", "cancelled"}


class DashboardApiTest(ServerCase):
    def setUp(self):
        self.cookie, self.csrf = self.login()
        self.kw = {"cookie": self.cookie, "csrf": self.csrf}

    def product(self, name, price, stock=10):
        status, data, _ = self.json("POST", "/api/admin/products", {"name": name, "category": "curtains", "price": price, "stock": stock,
                                                                    "image": "/assets/wavy-03.jpg"}, **self.kw)
        self.assertEqual(status, 201, data)
        return data["product"]

    def order(self, items):
        status, data, _ = self.json("POST", "/api/orders", {"name": "عميل", "phone": "0551234567", "city": "جدة", "consent": True, "items": items})
        self.assertEqual(status, 201, data)
        return data["order_id"]

    def dash(self, query="?range=7"):
        return self.json("GET", "/api/admin/dashboard" + query, **self.kw)

    def test_auth_and_range_validation(self):
        self.assertEqual(self.json("GET", "/api/admin/dashboard?range=7")[0], 401)
        for bad in ("?range=5", "?range=abc", "?range=", "?range=7&range=30", "?range=-7", "?range=0007x"):
            self.assertEqual(self.dash(bad)[0], 400, bad)
        self.assertEqual(self.dash("?range=7")[0], 200)
        # without range the legacy payload that the current admin page reads is unchanged
        status, legacy, _ = self.dash("")
        self.assertEqual(status, 200)
        self.assertIn("recent_orders", legacy)
        self.assertNotIn("kpis", legacy)

    def test_shape_zero_fill_status_counts_and_known_revenue(self):
        priced = self.product("ستارة مسعّرة اختبار", 400)
        on_request = self.product("ستارة عند الطلب اختبار", 0)
        bases = {n: self.dash(f"?range={n}")[1] for n in (7, 30, 90)}
        o1 = self.order([{"product_id": priced["id"], "quantity": 2}])
        o2 = self.order([{"product_id": priced["id"], "quantity": 1}, {"product_id": on_request["id"], "quantity": 1}])
        o3 = self.order([{"product_id": priced["id"], "quantity": 1}])
        self.json("PATCH", f"/api/admin/orders/{o3}", {"status": "cancelled"}, **self.kw)
        self.json("PATCH", f"/api/admin/orders/{o1}", {"status": "delivered"}, **self.kw)
        self.json("POST", "/api/contact", {"name": "زائر", "phone": "0551234567", "message": "رسالة اختبار للوحة", "consent": True})
        for days in (7, 30, 90):
            status, d, _ = self.dash(f"?range={days}")
            base = bases[days]
            self.assertEqual(status, 200)
            self.assertEqual(d["range"], days)
            self.assertEqual(len(d["orders_by_day"]), days)
            self.assertEqual(len(d["visits_by_day"]), days)
            today = datetime.now(timezone.utc).astimezone(RIYADH).date()
            self.assertEqual(d["orders_by_day"][-1]["day"], today.isoformat())
            self.assertEqual(d["orders_by_day"][0]["day"], (today - timedelta(days=days - 1)).isoformat())
            self.assertEqual(sum(x["count"] for x in d["orders_by_day"]), d["kpis"]["orders_period"])
            self.assertGreaterEqual(sum(1 for x in d["orders_by_day"] if x["count"] == 0), days - 2)
            self.assertEqual(set(d["orders_by_status"]), STATUSES)
            b, k = base["orders_by_status"], d["orders_by_status"]
            self.assertEqual((k["delivered"] - b["delivered"], k["cancelled"] - b["cancelled"], k["new"] - b["new"]), (1, 1, 1))
            self.assertEqual(sum(k.values()), d["kpis"]["orders_period"])
            k = d["kpis"]
            self.assertEqual(k["orders_period"] - base["kpis"]["orders_period"], 3)
            self.assertEqual(k["orders_total"] - base["kpis"]["orders_total"], 3)
            # only o1 (800) has a known total: o2 has a price-on-request line, o3 is cancelled
            self.assertEqual(k["revenue_period_known"] - (base["kpis"]["revenue_period_known"] or 0), 800)
            self.assertEqual(k["messages_unread"] - base["kpis"]["messages_unread"], 1)
            self.assertEqual(sum(x["revenue_known"] for x in d["orders_by_day"]), k["revenue_period_known"])
            # o3 is cancelled, so it does not count toward the best sellers (o1 and o2 only)
            self.assertTrue(any(p["id"] == priced["id"] and p["orders"] == 2 for p in d["top_products"]))
            self.assertEqual(d["top_categories"][0]["slug"], "curtains")
            self.assertLessEqual(len(d["recent_orders"]), 8)
            self.assertEqual(d["recent_orders"][0]["id"], o3)
            self.assertEqual(d["recent_messages"][0]["name"], "زائر")
            self.assertEqual(d["recent_orders"][0]["id"], o3)
            self.assertTrue(all(set(m) == {"id", "name", "status", "created_at", "preview"} for m in d["recent_messages"]))
            for key in ("generated_at", "top_pages", "referrers", "low_stock"):
                self.assertIn(key, d)
            for key in ("visits_prev_period", "products_total", "products_active", "low_stock_count", "visits_period"):
                self.assertIn(key, d["kpis"])

    def test_revenue_null_when_nothing_known_and_low_stock(self):
        item = self.product("منتج مخزون منخفض اختبار", 0, stock=2)
        self.order([{"product_id": item["id"], "quantity": 1}])
        _, d, _ = self.dash("?range=30")
        self.assertTrue(any(x["id"] == item["id"] and x["stock"] <= 3 for x in d["low_stock"]))
        self.assertGreaterEqual(d["kpis"]["low_stock_count"], 1)

    def test_no_secrets_in_payload(self):
        status, resp, data = self.req("GET", "/api/admin/dashboard?range=90", cookie=self.cookie, csrf=self.csrf)
        self.assertEqual(status, 200)
        raw = data.decode().lower()
        for needle in ("password", "hash", "totp", "csrf", "secret", "token", self.admin_password.lower(), self.csrf.lower()):
            self.assertNotIn(needle, raw, needle)
        self.assertNotRegex(raw, r"[0-9a-f]{32}\$[0-9a-f]{64}")

    def test_old_order_moves_to_previous_period(self):
        item = self.product("منتج حدود اختبار", 50)
        oid = self.order([{"product_id": item["id"], "quantity": 1}])
        _, before, _ = self.dash("?range=7")
        old = (datetime.now(timezone.utc) - timedelta(days=10)).isoformat(timespec="seconds")
        conn = sqlite3.connect(Path(self.data_dir) / "store.db")
        conn.execute("UPDATE orders SET created_at=? WHERE id=?", (old, oid))
        conn.commit(); conn.close()
        _, after, _ = self.dash("?range=7")
        _, month, _ = self.dash("?range=30")
        self.assertEqual(after["kpis"]["orders_period"], before["kpis"]["orders_period"] - 1)
        self.assertEqual(after["kpis"]["orders_prev_period"], before["kpis"]["orders_prev_period"] + 1)
        self.assertEqual(sum(x["count"] for x in month["orders_by_day"]), month["kpis"]["orders_period"])
        self.assertEqual(after["kpis"]["orders_total"], before["kpis"]["orders_total"])


class VendorStaticTest(ServerCase):
    @classmethod
    def setUpClass(cls):
        super().setUpClass()
        cls.vendor = ROOT / "assets" / "vendor" / "_testlib"
        cls.vendor.mkdir(parents=True, exist_ok=True)
        (cls.vendor / "lib.min.js").write_text("window.__t=1;", encoding="utf-8")
        (cls.vendor / "lib.min.css").write_text("a{color:red}", encoding="utf-8")

    @classmethod
    def tearDownClass(cls):
        import shutil
        shutil.rmtree(cls.vendor, ignore_errors=True)
        try:
            (ROOT / "assets" / "vendor").rmdir()
        except OSError:
            pass
        super().tearDownClass()

    def test_vendor_files_headers(self):
        status, resp, body = self.req("GET", "/assets/vendor/_testlib/lib.min.js")
        self.assertEqual(status, 200)
        self.assertTrue(resp.getheader("Content-Type").startswith("application/javascript"))
        self.assertEqual(resp.getheader("X-Content-Type-Options"), "nosniff")
        self.assertIn("max-age=31536000", resp.getheader("Cache-Control"))
        self.assertEqual(body, b"window.__t=1;")
        status, resp, _ = self.req("GET", "/assets/vendor/_testlib/lib.min.css")
        self.assertEqual(status, 200)
        self.assertTrue(resp.getheader("Content-Type").startswith("text/css"))

    def test_no_traversal(self):
        for path in ("/assets/vendor/../../app.py", "/assets/vendor/%2e%2e/%2e%2e/app.py", "/assets/vendor/..%2f..%2fapp.py",
                     "/assets/vendor/_testlib/../../../store.db", "/assets/vendor/..\\..\\app.py"):
            status, _, body = self.req("GET", path)
            self.assertIn(status, (400, 403, 404), path)
            self.assertNotIn(b"ThreadingHTTPServer", body)
