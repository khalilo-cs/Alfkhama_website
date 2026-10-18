# ملف اختبار: طبقة تحسينات الواجهة العامة (plus.css / plus.js / sw.js / manifest).
# يفحص أن الملفات تُقدَّم بالأنواع الصحيحة، وتُربط في كل صفحة، وأن الـ Service Worker يخزّن الملفات العامة فقط،
# وأن الكود خالٍ من المضيفين الخارجيين والمعالجات المضمّنة والقيم غير المهرّبة (XSS).
"""Storefront enhancement layer: the files it adds are served correctly, linked from every page, cached by the service
worker (only public files), and kept free of external hosts, inline handlers and unescaped markup."""
from __future__ import annotations

import json
import re
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_app import ROOT, ServerCase  # noqa: E402

sys.path.insert(0, str(ROOT))
import pages  # noqa: E402

# ---- ثوابت ----
# ملفات الواجهة العامة التي نفحصها في اختبار خلوّ الملفات من أي إشارة لأداة كتابة.
OWN_FILES = ("index.html", "pages.py", "sw.js", "offline.html", "manifest.webmanifest", "assets/css/plus.css", "assets/js/plus.js")


# ---- اختبارات عبر خادم حقيقي ----
class StorefrontAssetsTest(ServerCase):
    # plus.css و plus.js يُقدَّمان بنوع المحتوى المناسب مع Cache-Control، وحجمهما أكبر من 2000 بايت (ليسا فارغين).
    def test_new_files_are_served_with_the_right_types_and_cache_headers(self):
        status, resp, body = self.req("GET", "/assets/css/plus.css")
        self.assertEqual(status, 200)
        self.assertTrue(resp.getheader("Content-Type").startswith("text/css"))
        self.assertIn("max-age", resp.getheader("Cache-Control"))
        self.assertGreater(len(body), 2000)
        status, resp, body = self.req("GET", "/assets/js/plus.js")
        self.assertEqual(status, 200)
        self.assertIn("javascript", resp.getheader("Content-Type"))
        self.assertIn("max-age", resp.getheader("Cache-Control"))
        self.assertGreater(len(body), 2000)

    # كل صفحة عامة (حتى صفحة 404) تربط plus.css وتحمّل plus.js. وسياسة CSP تعتمد nonce فريداً لكل ردّ:
    # يجب أن يحمل كل وسم <script> هذا الـ nonce (عدا JSON-LD) ولا يظهر unsafe-inline في script-src.
    def test_every_storefront_page_links_the_stylesheet_and_loads_the_script_under_the_csp(self):
        for path in ("/", "/products", "/categories", "/about", "/faq", "/contact", "/no-such-page"):
            status, resp, body = self.req("GET", path)
            html = body.decode()
            self.assertIn(status, (200, 404), path)
            self.assertIn('<link rel="stylesheet" href="/assets/css/plus.css">', html, path)
            self.assertIn("/assets/js/plus.js", html, path)
            csp = resp.getheader("Content-Security-Policy")
            self.assertIn("script-src 'self' 'nonce-", csp, path)
            self.assertNotIn("unsafe-inline", csp.split("style-src-attr")[0], path)
            nonce = re.search(r"'nonce-([^']+)'", csp).group(1)
            for tag in re.findall(r"<script\b[^>]*>", html):
                if "ld+json" not in tag:
                    self.assertIn(f'nonce="{nonce}"', tag, path)

    # صورة الهيرو عنصر img حقيقي (وليس خلفية CSS) بأولوية عالية وأبعاد ثابتة ونسخة صغيرة 600w؛
    # هذا يحسّن سرعة ظهور أكبر عنصر (LCP) ويمنع قفزة التخطيط. والخط الرئيسي يُحمَّل مسبقاً.
    def test_home_hero_is_a_real_high_priority_image_with_a_small_variant(self):
        html = self.req("GET", "/")[2].decode()
        hero = re.search(r'<img class="hero-bg"[^>]*>', html)
        self.assertTrue(hero)
        tag = hero.group(0)
        for needle in ('fetchpriority="high"', 'alt=""', 'width="1200"', 'height="669"', "/assets/wavy-11-t.jpg 600w", "/assets/wavy-11.jpg 1200w"):
            self.assertIn(needle, tag)
        for variant in ("/assets/wavy-11.jpg", "/assets/wavy-11-t.jpg"):
            self.assertEqual(self.req("GET", variant)[0], 200)
        self.assertIn('rel="preload" href="/assets/fonts/el-messiri-arabic-700-normal.woff2"', html, "critical font is preloaded")

    # الـ Service Worker يخزّن الملفات العامة مسبقاً لكنه لا يلمس /api/ ولا /admin ولا /uploads/ ولا الطلبات غير GET،
    # ولا يستعمل localStorage؛ ونتأكد أن كل ملف مدرج في قائمة التخزين المسبق موجود فعلاً (200).
    def test_service_worker_precaches_the_new_files_and_stays_private(self):
        src = self.req("GET", "/sw.js")[2].decode()
        self.assertIn("fakhama-static-v3", src)
        for needle in ("/assets/css/plus.css", "/assets/js/plus.js", "/offline.html"):
            self.assertIn(needle, src)
        for prefix in ("'/api/'", "'/admin'", "'/uploads/'"):
            self.assertIn(prefix, src)
        self.assertRegex(src, r"request\.method\s*!==\s*['\"]GET['\"]")
        self.assertNotIn("localStorage", src)
        # نأخذ فقط الجزء الذي يسبق NEVER_CACHE_PREFIXES حتى لا نخلط قائمة التخزين بقائمة المنع.
        # every precached file really exists
        listed = re.findall(r"'(/[^']+\.(?:css|js|woff2|png|html))'", src.split("NEVER_CACHE_PREFIXES")[0])
        self.assertGreaterEqual(len(listed), 5)
        for url in listed:
            self.assertEqual(self.req("GET", url)[0], 200, url)

    # اختصارات التطبيق (PWA) في manifest يجب أن تشير إلى صفحات وأيقونات موجودة فعلاً.
    def test_manifest_shortcuts_point_at_real_pages_and_icons(self):
        manifest = json.loads(self.req("GET", "/manifest.webmanifest")[2])
        self.assertTrue(manifest["shortcuts"])
        for shortcut in manifest["shortcuts"]:
            self.assertTrue(shortcut["url"].startswith("/") and shortcut["name"])
            self.assertIn(self.req("GET", shortcut["url"])[0], (200,), shortcut["url"])
            for icon in shortcut["icons"]:
                self.assertEqual(self.req("GET", icon["src"])[0], 200)
        self.assertEqual(manifest["scope"], "/")

    # عناصر الفرز والتصفية (متوفر فقط، مسح التصفية، البحث المقترح، رابط التثبيت) تأتي من الخادم في HTML.
    def test_products_and_category_pages_carry_the_filter_controls(self):
        for path in ("/products", "/category/curtains"):
            html = self.req("GET", path)[2].decode()
            self.assertIn('id="stockOnly"', html, path)
            self.assertIn('id="clearFilters"', html, path)
            self.assertIn('<option value="newest">', html, path)
        home = self.req("GET", "/")[2].decode()
        self.assertIn('id="stockOnly"', home)
        self.assertIn('id="searchSuggest"', home)
        self.assertIn('id="installLink"', home)


# ---- فحوصات نظافة الملفات الثابتة (بدون تشغيل خادم) ----
class StaticHygieneTest(unittest.TestCase):
    # يقرأ ملفاً من جذر المشروع كنص UTF-8.
    def read(self, name):
        return (ROOT / name).read_text(encoding="utf-8")

    # أمان وخصوصية: لا روابط http(s) خارجية (يُستثنى مساحة أسماء w3.org في SVG) ولا eval ولا document.write
    # ولا خصائص onclick ونحوها داخل HTML الذي يولّده السكربت (تتعارض مع CSP).
    def test_enhancement_files_use_no_external_hosts_eval_or_inline_handlers(self):
        for name in ("assets/js/plus.js", "assets/css/plus.css", "sw.js"):
            text = self.read(name)
            self.assertNotRegex(text, r"https?://(?!www\.w3\.org)", name)
            self.assertNotRegex(text, r"\beval\s*\(|new Function\(|document\.write\(", name)
        self.assertNotRegex(self.read("assets/js/plus.js"), r"\son[a-z]+\s*=\s*[\"']", "no inline handler attributes are generated")

    # حماية من XSS: كل تعبير ${...} داخل قوالب plus.js يجب أن يمرّ عبر دالة تهريب (esc وأخواتها) أو يكون اسماً بسيطاً
    # أو نصاً ثابتاً. هذا فحص ساكن بالتعابير النمطية، وقائمة البدايات المسموحة أدناه تُحدَّث عند إضافة دوال جديدة.
    def test_every_dynamic_value_in_the_script_goes_through_esc(self):
        script = self.read("assets/js/plus.js")
        for expression in re.findall(r"\$\{([^}]+)\}", script):
            safe = (expression.startswith(("esc(", "encodeURIComponent(", "highlightHtml(", "priceHtml(", "amount(", "countAr(", "icons.", "text", "html", "options.", "n ", "n)", "i ", "all.length")) or
                    re.fullmatch(r"[\w.]+", expression) is not None or "esc(" in expression or "amount(" in expression or
                    re.fullmatch(r"deferred \? '[^']*' : '[^']*'", expression) is not None)  # constant text only
            self.assertTrue(safe, "unescaped interpolation in plus.js: " + expression)

    # الكلمات الممنوعة مكتوبة مقسّمة ثم مدموجة كي لا يطابق هذا الملف نفسه الفحص.
    def test_nothing_in_the_storefront_files_names_an_authoring_tool(self):
        banned = re.compile("|".join(["cl" + "aude", "anthr" + "opic", "ai-gener" + "ated", "generated " + "by", "co-auth" + "ored"]), re.I)
        for name in OWN_FILES:
            self.assertIsNone(banned.search(self.read(name)), name)

    # حماية من التغيير غير المقصود: بيانات المطوّر وعنوان المتجر ورابط الخريطة يجب أن تبقى كما هي في index.html.
    def test_credentials_and_developer_credit_are_untouched(self):
        index = self.read("index.html")
        self.assertIn("تطوير المهندس محمد خليل", index)
        self.assertIn("0736390203", index)
        self.assertIn("شارع المكرونة، مجمع الشرق، حي مشرفة، جدة 23444", index)
        self.assertIn("https://maps.app.goo.gl/kn2kxuPujQT9raLG7?g_st=awb", index)

    # pages.product_card يبني بطاقة المنتج في الخادم: نمرّر قيماً خبيثة (وسوم HTML) ونتأكد أنها تُهرَّب كلها.
    def test_server_rendered_cards_escape_everything_and_match_the_script_card(self):
        product = {"id": 7, "name": '<img src=x onerror="alert(1)">', "slug": "x", "stock": 3, "price": 100, "category_name": "<b>ق</b>",
                   "thumb": "/assets/a.jpg", "alt": '"><script>1</script>', "badge": "<i>"}
        card = pages.product_card(product)
        self.assertNotIn("<img src=x", card)
        self.assertNotIn("<script>", card)
        self.assertNotIn("<b>ق", card)
        self.assertIn('aria-label="المفضلة: &lt;img', card)
        self.assertIn('aria-pressed="false"', card)
        self.assertIn('width="600" height="648"', card)
        self.assertIn('value="newest"', pages.SORT_OPTIONS)

    # بحث الخادم يوحّد الحروف العربية (الهمزات، الياء/الألف المقصورة، التاء المربوطة، التشكيل، التطويل، الأرقام
    # الهندية)
    # بنفس طريقة السكربت في المتصفح، لذلك "ستاير" و"سِتَائِر" تطابق "ستائر".
    def test_server_search_folds_arabic_like_the_script(self):
        product = {"name": "ستائر ويفي", "category_name": "ستائر تفصيل", "description": "قماشٌ ناعم", "sku": "FAL-WAV-005"}
        for term in ("ستاير", "ستائر", "سِتَائِر", "ستـائر", "قماش", "fal-wav-005", "FAL-WAV-٠٠٥", "ويفي    ستائر"):
            self.assertTrue(pages.search_matches(product, term), term)
        self.assertFalse(pages.search_matches(product, "لا يوجد"))
        self.assertEqual(pages.normalize_ar("أإآ ى ة ؤ ئ"), "ااا ي ه و ي")

    # أيقونات اختصارات manifest موجودة كملفات على القرص.
    def test_icons_in_shortcuts_exist_on_disk(self):
        manifest = json.loads(self.read("manifest.webmanifest"))
        for shortcut in manifest["shortcuts"]:
            for icon in shortcut["icons"]:
                self.assertTrue((ROOT / icon["src"].lstrip("/")).is_file(), icon["src"])


if __name__ == "__main__":
    unittest.main()
