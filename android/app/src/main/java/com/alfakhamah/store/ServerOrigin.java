// ملف ServerOrigin.java: يتحقق من عنوان الخادم (origin) الذي يتصل به التطبيق ويوحّد شكله.
// التطبيق عبارة عن غلاف WebView حول موقع المتجر، وهذا الصنف هو أول حارس أمان:
// يضمن أن العنوان https فقط (والاستثناء الوحيد http لعناوين محلية في نسخ الاختبار)
// وأنه بلا مسار ولا بيانات دخول. يستعمله MainActivity لقراءة العنوان، ويعتمد عليه NavigationPolicy للمقارنة.
// الصنف Java خالص بلا أي صنف من Android، لذلك تختبره ServerOriginTest مباشرة.
package com.alfakhamah.store;

import java.net.URI;
import java.net.URISyntaxException;
import java.util.Locale;

/**
 * Validates and normalises the server origin ("https://host[:port]") the app talks to.
 * Pure Java (no Android classes) so it is covered by plain JUnit tests.
 */
public final class ServerOrigin {

    // ---- أسباب رفض العنوان ----
    // كل قيمة تقابل رسالة خطأ تظهر للمختبِر في نافذة إدخال العنوان (انظر promptForServer).
    public enum Reason { EMPTY, MALFORMED, NOT_HTTPS, CREDENTIALS, HAS_PATH }

    // استثناء يحمل سبب الرفض في الحقل reason بدل الاعتماد على نص الرسالة.
    public static final class InvalidOriginException extends Exception {
        public final Reason reason;

        InvalidOriginException(Reason reason) {
            super(reason.name());
            this.reason = reason;
        }
    }

    // ---- دوال التحقق ----
    // الصنف أدوات ثابتة فقط، فلا يُسمح بإنشاء كائن منه.
    private ServerOrigin() {}

    /**
     * @param allowLocalCleartext true only for test (debug) builds: plain http is then accepted for
     *                            localhost / emulator / private-LAN hosts. Everything else must be https.
     * @return the origin without a trailing slash, default ports removed, host lower-cased
     */
    public static String normalize(String raw, boolean allowLocalCleartext) throws InvalidOriginException {
        // 1) تنظيف المدخل: القيمة الفارغة مرفوضة، وإن لم يُكتب البروتوكول نفترض https.
        String value = raw == null ? "" : raw.trim();
        if (value.isEmpty()) throw new InvalidOriginException(Reason.EMPTY);
        if (!value.contains("://")) value = "https://" + value;

        // 2) تحليل العنوان: أي صيغة غير صالحة (مثل وجود مسافة) تُرفض بسبب MALFORMED.
        URI uri;
        try {
            uri = new URI(value);
        } catch (URISyntaxException e) {
            throw new InvalidOriginException(Reason.MALFORMED);
        }
        String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase(Locale.ROOT);
        String host = uri.getHost();
        if (host == null || host.isEmpty()) throw new InvalidOriginException(Reason.MALFORMED);
        host = host.toLowerCase(Locale.ROOT);
        // رفض user:pass@host: وجود بيانات دخول داخل العنوان يخفي المضيف الحقيقي ويسرّب كلمة المرور.
        if (uri.getRawUserInfo() != null) throw new InvalidOriginException(Reason.CREDENTIALS);
        // المطلوب أصل الخادم فقط (scheme://host[:port])؛ أي مسار أو استعلام أو جزء # يُرفض.
        String path = uri.getRawPath();
        if ((path != null && !path.isEmpty() && !path.equals("/")) || uri.getRawQuery() != null || uri.getRawFragment() != null) {
            throw new InvalidOriginException(Reason.HAS_PATH);
        }
        // 3) فحص البروتوكول: https دائمًا مقبول. http لا يُقبل إلا إذا سُمح به (نسخة اختبار) والمضيف محلي.
        // المنفذ الافتراضي (443 أو 80) يُحذف ليكون الناتج موحّدًا عند المقارنة.
        int port = uri.getPort();
        if (scheme.equals("https")) {
            if (port == 443) port = -1;
        } else if (scheme.equals("http") && allowLocalCleartext && isLocalHost(host)) {
            if (port == 80) port = -1;
        } else {
            throw new InvalidOriginException(Reason.NOT_HTTPS);
        }
        return scheme + "://" + host + (port > 0 ? ":" + port : "");
    }

    // يُستعمل في NavigationPolicy لمقارنة أي رابط بأصل الخادم بنفس صيغة التوحيد.
    /** "scheme://host[:port]" of an absolute URL with default ports removed, or null if it has none. */
    static String originOf(URI uri) {
        if (uri == null || uri.getScheme() == null || uri.getHost() == null) return null;
        String scheme = uri.getScheme().toLowerCase(Locale.ROOT);
        int port = uri.getPort();
        if ((scheme.equals("https") && port == 443) || (scheme.equals("http") && port == 80)) port = -1;
        return scheme + "://" + uri.getHost().toLowerCase(Locale.ROOT) + (port > 0 ? ":" + port : "");
    }

    // يحدد هل المضيف عنوان محلي (للاختبار فقط). المقارنة بالأرقام الفعلية تمنع خدعة مثل 10.0.2.2.evil.com
    // لأن اسم النطاق الكامل لا يطابق أربعة أجزاء رقمية.
    /** Loopback, the Android-emulator host alias, *.local and RFC 1918 private ranges. */
    static boolean isLocalHost(String host) {
        if (host.equals("localhost") || host.equals("10.0.2.2") || host.equals("[::1]") || host.equals("::1") || host.endsWith(".local")) {
            return true;
        }
        String[] parts = host.split("\\.");
        if (parts.length != 4) return false;
        // التحقق من أن العنوان IPv4 صحيح (4 أجزاء بين 0 و255) ثم مطابقة النطاقات الخاصة: 127 و10
        // و192.168 و172.16-31.
        int[] octets = new int[4];
        for (int i = 0; i < 4; i++) {
            try {
                octets[i] = Integer.parseInt(parts[i]);
            } catch (NumberFormatException e) {
                return false;
            }
            if (octets[i] < 0 || octets[i] > 255) return false;
        }
        return octets[0] == 127
                || octets[0] == 10
                || (octets[0] == 192 && octets[1] == 168)
                || (octets[0] == 172 && octets[1] >= 16 && octets[1] <= 31);
    }
}
