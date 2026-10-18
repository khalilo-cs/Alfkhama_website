// ملف NavigationPolicyTest.java: اختبارات JUnit لسياسة التنقل (NavigationPolicy). تثبت أن روابط متجرنا والإدارة
// تُحمَّل داخل التطبيق، وأن المواقع الأخرى تُفتح خارجيًا، وأن البروتوكولات الخطرة تُحظر.
// تعمل على الجهاز المحلي دون محاكي (gradlew testDebugUnitTest).
package com.alfakhamah.store;

import static com.alfakhamah.store.NavigationPolicy.Action.BLOCK;
import static com.alfakhamah.store.NavigationPolicy.Action.LOAD_IN_APP;
import static com.alfakhamah.store.NavigationPolicy.Action.OPEN_EXTERNALLY;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class NavigationPolicyTest {
    // نطاق تجريبي وهمي؛ لا علاقة له بنطاق الإنتاج.
    private static final String ORIGIN = "https://shop.example.com";
    private final NavigationPolicy policy = new NavigationPolicy(ORIGIN);

    // دالة مساعدة تقارن القرار المتوقع وتطبع الرابط في رسالة الفشل.
    private void check(String url, NavigationPolicy.Action expected) {
        assertEquals(url, expected, policy.decide(url));
    }

    // ---- الروابط التي تبقى داخل التطبيق ----
    @Test
    public void storefrontAndAdminPanelBothLoadInsideTheApp() {
        check(ORIGIN + "/", LOAD_IN_APP);
        check(ORIGIN + "/#shop", LOAD_IN_APP);
        check(ORIGIN + ":443/", LOAD_IN_APP);
        check(ORIGIN + "/assets/wavy-11.jpg", LOAD_IN_APP);
        check(ORIGIN + "/uploads/abc.png", LOAD_IN_APP);
        check(ORIGIN + "/admin", LOAD_IN_APP);
        check(ORIGIN + "/admin/", LOAD_IN_APP);
        check(ORIGIN + "/api/admin/export/orders.csv", LOAD_IN_APP);
    }

    // ---- مواقع أخرى: تشمل محاولات تقليد النطاق (نطاق فرعي أو منفذ مختلف أو رابط داخل رابط) ----
    @Test
    public void otherWebsitesOpenInTheSystemBrowser() {
        check("https://maps.app.goo.gl/kn2kxuPujQT9raLG7?g_st=awb", OPEN_EXTERNALLY);
        check("https://wa.me/966500000000?text=hi", OPEN_EXTERNALLY);
        check("https://shop.example.com.evil.com/", OPEN_EXTERNALLY);
        check("https://evil.com/https://shop.example.com/", OPEN_EXTERNALLY);
        check("https://shop.example.com:8443/", OPEN_EXTERNALLY);
        check("https://sub.shop.example.com/", OPEN_EXTERNALLY);
    }

    // ---- خفض الأمان من https إلى http على مضيفنا يُحظر ----
    @Test
    public void downgradeToCleartextOnOurHostIsBlocked() {
        check("http://shop.example.com/", BLOCK);
        check("http://shop.example.com/admin/", BLOCK);
        check("http://other.example.org/", OPEN_EXTERNALLY);
    }

    // ---- بروتوكولات النظام المسموحة (اتصال، بريد، رسائل، خريطة) وحظر ما عداها ----
    @Test
    public void systemSchemesAreForwardedAndEverythingElseIsBlocked() {
        check("tel:+966576486491", OPEN_EXTERNALLY);
        check("mailto:a@b.c", OPEN_EXTERNALLY);
        check("sms:+966576486491", OPEN_EXTERNALLY);
        check("geo:21.5,39.2", OPEN_EXTERNALLY);
        check("intent://scan/#Intent;scheme=zxing;end", BLOCK);
        check("javascript:alert(1)", BLOCK);
        check("file:///data/data/com.alfakhamah.store/shared_prefs/x.xml", BLOCK);
        check("content://com.android.contacts/contacts", BLOCK);
        check("data:text/html,<script>alert(1)</script>", BLOCK);
        check("blob:https://shop.example.com/1234", BLOCK);
        check("about:blank", BLOCK);
        check("market://details?id=x", BLOCK);
        check("android-app://com.example", BLOCK);
        check("", BLOCK);
        check(null, BLOCK);
        check("https://", BLOCK);
        check("not a url", BLOCK);
    }

    // ---- تمييز منطقة الإدارة حتى لو أُخفي المسار بنقاط مشفّرة أو شرطات مكررة ----
    @Test
    public void adminAreaIsRecognisedEvenWhenDisguised() {
        // These are the pages that must be hidden from screenshots.
        assertTrue(policy.isAdminArea(ORIGIN + "/admin"));
        assertTrue(policy.isAdminArea(ORIGIN + "/admin/"));
        assertTrue(policy.isAdminArea(ORIGIN + "/admin.html"));
        assertTrue(policy.isAdminArea(ORIGIN + "/api/admin/orders"));
        assertTrue(policy.isAdminArea(ORIGIN + "/x/%2e%2e/admin/"));    // encoded dot segments
        assertTrue(policy.isAdminArea(ORIGIN + "/x/../admin/"));
        // A raw backslash is not a valid URI: such a link is never loaded at all.
        check(ORIGIN + "/x\\..\\admin\\", BLOCK);
        assertTrue(policy.isAdminArea(ORIGIN + "//admin/"));
        assertTrue(policy.isAdminArea(ORIGIN + "/admin/?next=/"));
        // The storefront and foreign sites are not admin pages.
        assertFalse(policy.isAdminArea(ORIGIN + "/"));
        assertFalse(policy.isAdminArea(ORIGIN + "/admin/../"));
        assertFalse(policy.isAdminArea(ORIGIN + "/assets/wavy-11.jpg"));
        assertFalse(policy.isAdminArea("https://evil.com/admin/"));
        assertFalse(policy.isAdminArea("http://shop.example.com/admin/"));
        assertFalse(policy.isAdminArea(null));
    }

    // ---- التنزيل مسموح من واجهة الإدارة على أصلنا فقط ----
    @Test
    public void downloadsAreOnlyAllowedFromTheAdminApiOfOurOrigin() {
        assertTrue(policy.isDownloadAllowed(ORIGIN + "/api/admin/export/orders.csv"));
        assertTrue(policy.isDownloadAllowed(ORIGIN + ":443/api/admin/export/orders.csv"));
        assertFalse(policy.isDownloadAllowed(ORIGIN + "/uploads/a.png"));
        assertFalse(policy.isDownloadAllowed(ORIGIN + "/api/products"));
        assertFalse(policy.isDownloadAllowed("https://evil.com/api/admin/export/orders.csv"));
        assertFalse(policy.isDownloadAllowed(ORIGIN + "/x/%2e%2e/api/admin/export/orders.csv/../../../../"));
        assertFalse(policy.isDownloadAllowed("javascript:alert(1)"));
    }

    // ---- اختبار دالة تنظيف المسار مباشرة ----
    @Test
    public void cleanPathResolvesDotSegments() {
        assertEquals("/", NavigationPolicy.cleanPath(null));
        assertEquals("/", NavigationPolicy.cleanPath(""));
        assertEquals("/a/b", NavigationPolicy.cleanPath("/a//b"));
        assertEquals("/b", NavigationPolicy.cleanPath("/a/../b"));
        assertEquals("/", NavigationPolicy.cleanPath("/../../.."));
        assertEquals("/a/", NavigationPolicy.cleanPath("/a/b/.."));
        assertEquals("/a/b", NavigationPolicy.cleanPath("\\a\\b"));
    }
}
