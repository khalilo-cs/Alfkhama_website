// ملف MainActivity.java: الشاشة الوحيدة في التطبيق. التطبيق غلاف WebView حول موقع المتجر نفسه:
// الصفحات والمنطق كلها على الخادم، وهنا فقط تحميل الموقع وإعدادات الأمان وشاشة البدء وشاشات الخطأ.
// يستعين بـ ServerOrigin للتحقق من عنوان الخادم وبـ NavigationPolicy لتقرير ما يُفتح وما يُحظر.
// ملفات التخطيط والنصوص في res/، والعنوان والإعدادات تأتي من app/build.gradle.kts (BuildConfig).
package com.alfakhamah.store;

import android.annotation.SuppressLint;
import android.app.AlertDialog;
import android.app.DownloadManager;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.os.Message;
import android.text.InputType;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowManager;
import android.view.animation.DecelerateInterpolator;
import android.webkit.CookieManager;
import android.webkit.JsResult;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.SslErrorHandler;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

import androidx.activity.ComponentActivity;
import androidx.activity.EdgeToEdge;
import androidx.activity.OnBackPressedCallback;
import androidx.activity.SystemBarStyle;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import androidx.core.view.WindowInsetsCompat;

/**
 * The single app for customers and the shop admin: a WebView shell around the shared server.
 * - Opens the storefront at "/".
 * - The admin panel (/admin/) loads in the same shell, reached from the storefront footer or the
 *   "لوحة الإدارة" launcher shortcut; it asks for the admin login itself and nothing is stored here.
 * - While the admin panel is on screen the window is secured (no screenshots, hidden in recents).
 *
 * The server origin comes from the build (BuildConfig.SERVER_ORIGIN). Only test (debug) builds may
 * be pointed at another address at runtime.
 */
public class MainActivity extends ComponentActivity {

    // ---- الثوابت والحقول ----
    // التفضيلات تُستعمل فقط في نسخ الاختبار لحفظ العنوان الذي يكتبه المختبِر.
    private static final String PREFS = "server";
    private static final String PREF_ORIGIN = "origin";
    private static final String EXTRA_START_PATH = "start_path";
    private static final String ADMIN_START_PATH = "/admin/";
    /** Suggested (pre-filled, editable) server for the first run of a test build. Release builds use BuildConfig only. */
    static final String SUGGESTED_ORIGIN = "https://alfakhama.onrender.com";

    // عناصر الواجهة: تُربط في onCreate من res/layout/activity_main.xml.
    private WebView webView;
    private ProgressBar progress;
    private View errorView;
    private TextView errorTitle;
    private TextView errorMessage;
    private Button retryButton;
    private Button changeServerButton;
    private TextView testBanner;
    private View root;
    private View splash;
    private boolean splashDone;
    // مهلة أمان تخفي شاشة البدء إن تأخر التحميل (انظر showSplash).
    private final Runnable splashTimeout = this::hideSplash;

    private String origin;
    private String startPath = BuildConfig.START_PATH;
    private NavigationPolicy policy;
    private boolean pageFailed;
    // حالة WebView المحفوظة بعد أن يستعيد النظام التطبيق؛ تُستعمل مرة واحدة في applyServer.
    private Bundle restoredState;

    // رد اختيار الملفات: الصفحة (مثل رفع صورة منتج في لوحة الإدارة) تنتظر نتيجة منتقي الملفات.
    private ValueCallback<Uri[]> fileCallback;
    private ActivityResultLauncher<Intent> fileChooserLauncher;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    // ---- إنشاء الشاشة ----
    // نقطة البداية: يضبط العرض من حافة لحافة، ويربط عناصر الواجهة، ويجهّز زر الرجوع ومنتقي الملفات،
    // ثم يضبط WebView ويحمّل العنوان المعتمد.
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        EdgeToEdge.enable(this,
                SystemBarStyle.light(Color.TRANSPARENT, Color.TRANSPARENT),
                SystemBarStyle.light(Color.TRANSPARENT, Color.TRANSPARENT));
        super.onCreate(savedInstanceState);
        // قيمة start_path تُقبل إن كانت /admin/ بالضبط، حتى لا يستطيع تطبيق آخر توجيه الغلاف إلى مسار اختياري.
        // Only the admin shortcut may pick another start page, and only this one.
        if (ADMIN_START_PATH.equals(getIntent().getStringExtra(EXTRA_START_PATH))) startPath = ADMIN_START_PATH;
        setContentView(R.layout.activity_main);
        restoredState = savedInstanceState;

        root = findViewById(R.id.root);
        // مع العرض من حافة لحافة نضيف هوامش لأشرطة النظام والحَدّ (cutout) ولوحة المفاتيح حتى لا
        // يُغطّى المحتوى.
        ViewCompat.setOnApplyWindowInsetsListener(root, (v, insets) -> {
            Insets bars = insets.getInsets(WindowInsetsCompat.Type.systemBars()
                    | WindowInsetsCompat.Type.displayCutout() | WindowInsetsCompat.Type.ime());
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom);
            return WindowInsetsCompat.CONSUMED;
        });

        webView = findViewById(R.id.web_view);
        progress = findViewById(R.id.progress);
        errorView = findViewById(R.id.error_view);
        errorTitle = findViewById(R.id.error_title);
        errorMessage = findViewById(R.id.error_message);
        retryButton = findViewById(R.id.retry_button);
        changeServerButton = findViewById(R.id.change_server_button);
        testBanner = findViewById(R.id.test_banner);
        splash = findViewById(R.id.splash);
        if (savedInstanceState == null) {
            showSplash();
        } else {
            // Restored after the system reclaimed the app: go straight back to the page.
            splashDone = true;
            splash.setVisibility(View.GONE);
            root.setBackgroundColor(getColor(R.color.app_background));
        }

        retryButton.setOnClickListener(v -> retry());
        if (BuildConfig.ALLOW_SERVER_OVERRIDE) {
            changeServerButton.setVisibility(View.VISIBLE);
            changeServerButton.setOnClickListener(v -> promptForServer(null));
            testBanner.setOnClickListener(v -> promptForServer(null));
        }

        // يجب تسجيل المُطلِق داخل onCreate. يعيد اختيار المستخدم إلى الصفحة عبر fileCallback.
        fileChooserLauncher = registerForActivityResult(new ActivityResultContracts.StartActivityForResult(), result -> {
            if (fileCallback != null) {
                fileCallback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(result.getResultCode(), result.getData()));
                fileCallback = null;
            }
        });

        // زر الرجوع: يرجع في سجل الصفحات إن أمكن، وإلا يُعطَّل الاعتراض ويُترك للنظام إغلاق الشاشة.
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                if (errorView.getVisibility() != View.VISIBLE && webView.canGoBack()) {
                    webView.goBack();
                } else {
                    setEnabled(false);
                    getOnBackPressedDispatcher().onBackPressed();
                }
            }
        });

        configureWebView();
        applyServer(resolveOrigin());
    }

    // ---------------------------------------------------------------------------------------- server origin

    // قراءة عنوان الخادم: في نسخة الإصدار يأتي دائمًا من BuildConfig ولا يمكن تغييره من داخل التطبيق.
    private SharedPreferences prefs() {
        return getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    /** Returns the origin to use, or null when none is configured (or the saved one is invalid). */
    // يختار العنوان المرشح (المحفوظ يغلب في نسخ الاختبار فقط) ويمرره على ServerOrigin.normalize.
    // أي عنوان غير صالح يعطي null فتظهر شاشة خطأ بدل تحميل عنوان مشبوه.
    private String resolveOrigin() {
        String candidate = BuildConfig.SERVER_ORIGIN;
        if (BuildConfig.ALLOW_SERVER_OVERRIDE) {
            String saved = prefs().getString(PREF_ORIGIN, "");
            if (saved != null && !saved.isEmpty()) candidate = saved;
        }
        try {
            return ServerOrigin.normalize(candidate, BuildConfig.ALLOW_SERVER_OVERRIDE);
        } catch (ServerOrigin.InvalidOriginException e) {
            return null;
        }
    }

    // يطبّق العنوان: عند غيابه يعرض الخطأ (ونافذة الإدخال في الاختبار)، وإلا ينشئ NavigationPolicy
    // ثم يستعيد حالة الصفحة السابقة أو يحمّل الصفحة الأولى.
    private void applyServer(String newOrigin) {
        origin = newOrigin;
        if (origin == null) {
            policy = null;
            if (BuildConfig.ALLOW_SERVER_OVERRIDE) {
                showError(getString(R.string.err_no_server_title), getString(R.string.err_no_server_message_debug), false);
                promptForServer(null);
            } else {
                showError(getString(R.string.err_not_configured_title), getString(R.string.err_not_configured_message), false);
            }
            return;
        }
        policy = new NavigationPolicy(origin);
        if (BuildConfig.ALLOW_SERVER_OVERRIDE) {
            testBanner.setVisibility(View.VISIBLE);
            testBanner.setText(getString(R.string.test_banner, origin));
        }
        if (restoredState != null && webView.restoreState(restoredState) != null) {
            restoredState = null;
            return;
        }
        restoredState = null;
        webView.loadUrl(origin + startPath);
    }

    // نافذة إدخال العنوان لنسخ الاختبار. التحقق يتم عند الضغط على حفظ؛ ننشئ الزر بمستمع null ثم نعيّن
    // مستمعًا بعد show() كي لا تُغلق النافذة تلقائيًا عند وجود خطأ في المدخل.
    private void promptForServer(String errorText) {
        hideSplash();
        EditText input = new EditText(this);
        input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI);
        input.setTextDirection(View.TEXT_DIRECTION_LTR);
        input.setHint(R.string.server_prompt_hint);
        input.setSingleLine(true);
        input.setText(origin != null ? origin : SUGGESTED_ORIGIN);
        input.selectAll();
        AlertDialog dialog = new AlertDialog.Builder(this)
                .setTitle(R.string.server_prompt_title)
                .setMessage(errorText == null ? getString(R.string.server_prompt_message) : errorText)
                .setView(input)
                .setPositiveButton(R.string.server_prompt_save, null)
                .setNegativeButton(R.string.cancel, null)
                .create();
        dialog.show();
        dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(v -> {
            try {
                // مسموح هنا بـ http المحلي لأن هذه النافذة لا تظهر إلا إذا كان ALLOW_SERVER_OVERRIDE
                // مفعّلًا (نسخة اختبار).
                String normalized = ServerOrigin.normalize(input.getText().toString(), true);
                prefs().edit().putString(PREF_ORIGIN, normalized).apply();
                dialog.dismiss();
                hideError();
                applyServer(normalized);
            } catch (ServerOrigin.InvalidOriginException e) {
                // تحويل سبب الرفض إلى رسالة عربية مناسبة.
                int message;
                switch (e.reason) {
                    case NOT_HTTPS: message = R.string.err_origin_not_https; break;
                    case HAS_PATH: message = R.string.err_origin_has_path; break;
                    case CREDENTIALS: message = R.string.err_origin_credentials; break;
                    default: message = R.string.err_origin_malformed;
                }
                input.setError(getString(message));
            }
        });
    }

    // ---------------------------------------------------------------------------------------- WebView

    // إعداد WebView وهو قلب الأمان في التطبيق. الأذونات تُغلق افتراضيًا: لا وصول لملفات الجهاز ولا لمزوّدي
    // المحتوى ولا للموقع الجغرافي، ويُمنع المحتوى المختلط (http داخل https)، وكوكيز الطرف الثالث معطّلة.
    // أدوات التصحيح عن بُعد تعمل في نسخ DEBUG فقط.
    @SuppressLint("SetJavaScriptEnabled") // the storefront and the admin panel are JavaScript applications
    private void configureWebView() {
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);
        webView.setBackgroundColor(getColor(R.color.app_background));
        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true); // the cart and favourites live in localStorage
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setGeolocationEnabled(false);
        s.setSupportZoom(true); // pinch-zoom stays available for accessibility (charts, tables, product photos)
        s.setBuiltInZoomControls(true);
        s.setDisplayZoomControls(false); // no on-screen +/- overlay
        // نافذة window.open تصل إلى ShellChrome.onCreateWindow ثم تُفحص بـ NavigationPolicy.
        s.setSupportMultipleWindows(true); // window.open() is routed through NavigationPolicy (wa.me, maps, ...)
        s.setJavaScriptCanOpenWindowsAutomatically(false);
        s.setMediaPlaybackRequiresUserGesture(true);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) s.setSafeBrowsingEnabled(true);
        // The pages skip their service worker when they see this marker: the shell handles offline natively.
        s.setUserAgentString(s.getUserAgentString() + " AlfakhamahApp/" + BuildConfig.VERSION_NAME);

        // الكوكيز ضرورية لجلسة دخول المدير؛ التطبيق نفسه لا يخزّن كلمة مرور.
        CookieManager cookies = CookieManager.getInstance();
        cookies.setAcceptCookie(true);
        cookies.setAcceptThirdPartyCookies(webView, false);

        webView.setWebViewClient(new ShellClient());
        webView.setWebChromeClient(new ShellChrome());
        webView.setDownloadListener((url, userAgent, contentDisposition, mimeType, length) -> startDownload(url, userAgent, contentDisposition, mimeType));
    }

    // ---- الإجراءات المساعدة ----
    // إعادة المحاولة بعد خطأ: يعيد قراءة العنوان إن لم يكن معرّفًا، أو يحمّل الصفحة الأولى، أو يعيد التحميل.
    private void retry() {
        hideError();
        if (origin == null) {
            applyServer(resolveOrigin());
        } else if (webView.getUrl() == null) {
            webView.loadUrl(origin + startPath);
        } else {
            webView.reload();
        }
    }

    /** Admin pages show orders and customer phone numbers: keep them out of screenshots and the recents view. */
    // FLAG_SECURE يمنع لقطات الشاشة ويُخفي المحتوى في قائمة التطبيقات الأخيرة. يُضبط عند بدء كل صفحة
    // ويُزال عند مغادرة منطقة الإدارة. القرار يأتي من NavigationPolicy.isAdminArea.
    private void updateSecureFlag(String url) {
        boolean admin = policy != null && url != null && policy.isAdminArea(url);
        if (admin) {
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_SECURE);
        } else {
            getWindow().clearFlags(WindowManager.LayoutParams.FLAG_SECURE);
        }
    }

    /** Applies NavigationPolicy; returns true when the WebView must NOT load the URL itself. */
    // إن لم يوجد policy (لا عنوان معتمد) تُحظر كل الروابط. القيمة المرجعة true تعني أن WebView لا
    // يحمّل الرابط بنفسه.
    private boolean routeUrl(String url) {
        if (policy == null) return true;
        switch (policy.decide(url)) {
            case LOAD_IN_APP:
                return false;
            case OPEN_EXTERNALLY:
                openExternally(url);
                return true;
            default:
                Toast.makeText(this, R.string.link_blocked, Toast.LENGTH_SHORT).show();
                return true;
        }
    }

    // فتح رابط خارج التطبيق (متصفح، واتساب، اتصال...). فئة BROWSABLE تحصر الهدف في النشاطات التي تقبل الروابط.
    private void openExternally(String url) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url)).addCategory(Intent.CATEGORY_BROWSABLE));
        } catch (ActivityNotFoundException e) {
            Toast.makeText(this, R.string.no_app_for_link, Toast.LENGTH_SHORT).show();
        }
    }

    // تنزيل ملفات التصدير للمدير عبر DownloadManager. الفحص الأول هو isDownloadAllowed (واجهة
    // /api/admin/ على أصلنا فقط).
    // نمرر الكوكيز الحالية لأن التصدير يحتاج جلسة المدير.
    private void startDownload(String url, String userAgent, String contentDisposition, String mimeType) {
        if (policy == null || !policy.isDownloadAllowed(url)) {
            Toast.makeText(this, R.string.link_blocked, Toast.LENGTH_SHORT).show();
            return;
        }
        String name = URLUtil.guessFileName(url, contentDisposition, mimeType);
        DownloadManager.Request request = new DownloadManager.Request(Uri.parse(url));
        String cookie = CookieManager.getInstance().getCookie(url);
        if (cookie != null) request.addRequestHeader("Cookie", cookie);
        request.addRequestHeader("User-Agent", userAgent);
        request.setTitle(name);
        if (mimeType != null && !mimeType.isEmpty()) request.setMimeType(mimeType);
        request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            request.setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name);
        } else {
            // السبب: بدون إذن تخزين لا يمكن الكتابة في مجلد التنزيلات العام قبل Android 10.
            // Android 7-9 would need a storage permission for the public Downloads folder; the app's own
            // folder needs none, and the download notification still opens the file.
            request.setDestinationInExternalFilesDir(this, Environment.DIRECTORY_DOWNLOADS, name);
        }
        DownloadManager manager = (DownloadManager) getSystemService(Context.DOWNLOAD_SERVICE);
        try {
            manager.enqueue(request);
            Toast.makeText(this, R.string.download_started, Toast.LENGTH_SHORT).show();
        } catch (RuntimeException e) {
            Toast.makeText(this, R.string.download_failed, Toast.LENGTH_LONG).show();
        }
    }

    // ---------------------------------------------------------------------------------------- launch screen

    /** Night launch screen with the gold mark; light status-bar icons while it is visible. */
    // تحريك بسيط لعناصر شاشة البدء؛ الألوان والعناصر معرّفة في activity_main.xml.
    private void showSplash() {
        systemBarsLight(false);
        View content = findViewById(R.id.splash_content);
        content.setAlpha(0f);
        content.setScaleX(0.92f);
        content.setScaleY(0.92f);
        content.animate().alpha(1f).scaleX(1f).scaleY(1f).setDuration(700)
                .setInterpolator(new DecelerateInterpolator(2f)).start();
        View line = findViewById(R.id.splash_line);
        line.setScaleX(0f);
        line.animate().scaleX(1f).setStartDelay(250).setDuration(900)
                .setInterpolator(new DecelerateInterpolator(2f)).start();
        // Never keep the user waiting behind it: the store, an error or the address prompt takes over.
        mainHandler.postDelayed(splashTimeout, 10_000);
    }

    // إخفاء شاشة البدء مرة واحدة فقط (splashDone) مع إلغاء المهلة المؤجلة.
    private void hideSplash() {
        if (splashDone) return;
        splashDone = true;
        mainHandler.removeCallbacks(splashTimeout);
        root.setBackgroundColor(getColor(R.color.app_background));
        systemBarsLight(true);
        splash.animate().alpha(0f).setDuration(450).withEndAction(() -> splash.setVisibility(View.GONE)).start();
    }

    // تبديل لون أيقونات شريط الحالة والتنقل: فاتحة فوق الخلفية الداكنة، وداكنة فوق خلفية المتجر الفاتحة.
    private void systemBarsLight(boolean light) {
        WindowInsetsControllerCompat bars = WindowCompat.getInsetsController(getWindow(), root);
        bars.setAppearanceLightStatusBars(light);
        bars.setAppearanceLightNavigationBars(light);
    }

    // ---------------------------------------------------------------------------------------- error screen

    // عرض شاشة الخطأ بدل صفحة الويب (يُخفى WebView لكن يبقى حيًّا).
    private void showError(String title, String message, boolean canRetry) {
        errorTitle.setText(title);
        errorMessage.setText(message);
        retryButton.setVisibility(canRetry ? View.VISIBLE : View.GONE);
        errorView.setVisibility(View.VISIBLE);
        webView.setVisibility(View.INVISIBLE);
        progress.setVisibility(View.GONE);
        hideSplash();
    }

    private void hideError() {
        pageFailed = false;
        errorView.setVisibility(View.GONE);
        webView.setVisibility(View.VISIBLE);
    }

    // ---- عميل WebView: التنقل وأخطاء التحميل ----
    // يعالج أحداث الصفحة: تطبيق سياسة الروابط، وإظهار شاشة الخطأ عند فشل الإطار الرئيسي فقط.
    private final class ShellClient extends WebViewClient {
        // كل تنقل بين الصفحات يمر من هنا ويخضع لـ NavigationPolicy.
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            return routeUrl(request.getUrl().toString());
        }

        @Override
        public void onPageStarted(WebView view, String url, Bitmap favicon) {
            updateSecureFlag(url);
            pageFailed = false;
            progress.setVisibility(View.VISIBLE);
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            progress.setVisibility(View.GONE);
            if (!pageFailed) {
                errorView.setVisibility(View.GONE);
                webView.setVisibility(View.VISIBLE);
                hideSplash();
            }
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            if (!request.isForMainFrame()) return;
            pageFailed = true;
            showError(getString(R.string.err_offline_title), getString(R.string.err_offline_message), true);
        }

        // أخطاء 5xx للصفحة الرئيسية فقط تعطي شاشة خطأ؛ أخطاء الموارد الفرعية لا تهمّ المستخدم.
        @Override
        public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) {
            if (request.isForMainFrame() && response.getStatusCode() >= 500) {
                pageFailed = true;
                showError(getString(R.string.err_server_title), getString(R.string.err_server_message), true);
            }
        }

        @Override
        public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
            // عدم تجاوز أي مشكلة شهادة هو قرار أمان مقصود: لا يوجد خيار للمتابعة بالرغم من الخطأ.
            handler.cancel(); // never continue past a certificate problem
            pageFailed = true;
            showError(getString(R.string.err_ssl_title), getString(R.string.err_ssl_message), true);
        }

        @Override
        public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
            pageFailed = true;
            showError(getString(R.string.err_render_title), getString(R.string.err_render_message), true);
            return true; // handled: the app must not crash when the WebView process is killed
        }
    }

    // ---- عميل Chrome: التقدم والملفات والنوافذ وحوارات JavaScript ----
    private final class ShellChrome extends WebChromeClient {
        @Override
        public void onProgressChanged(WebView view, int newProgress) {
            progress.setIndeterminate(false);
            progress.setProgress(newProgress);
            progress.setVisibility(newProgress >= 100 ? View.GONE : View.VISIBLE);
        }

        // اختيار ملف للرفع. يُلغى الطلب السابق المعلّق (بقيمة null) لأن WebView لا يقبل أكثر من رد واحد.
        @Override
        public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
            if (fileCallback != null) fileCallback.onReceiveValue(null);
            fileCallback = callback;
            try {
                fileChooserLauncher.launch(params.createIntent());
            } catch (ActivityNotFoundException e) {
                fileCallback = null;
                Toast.makeText(MainActivity.this, R.string.no_file_picker, Toast.LENGTH_LONG).show();
                return false;
            }
            return true;
        }

        // window.open: ننشئ WebView مؤقتًا فقط لالتقاط الرابط، ثم نمرره على سياسة التنقل ونتخلص منه.
        // handled تمنع المعالجة المزدوجة لأن الحدثين shouldOverrideUrlLoading وonPageStarted قد يصلان معًا.
        @Override
        public boolean onCreateWindow(WebView view, boolean isDialog, boolean isUserGesture, Message resultMsg) {
            if (!isUserGesture) return false; // no pop-ups without a tap
            WebView popup = new WebView(MainActivity.this);
            popup.setWebViewClient(new WebViewClient() {
                private boolean handled;

                private void handleOnce(String url) {
                    if (handled) return;
                    handled = true;
                    if (!routeUrl(url)) webView.loadUrl(url); // e.g. the admin's "view the store" link
                    mainHandler.post(popup::destroy);
                }

                @Override
                public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest request) {
                    handleOnce(request.getUrl().toString());
                    return true;
                }

                @Override
                public void onPageStarted(WebView v, String url, Bitmap favicon) {
                    handleOnce(url);
                }
            });
            ((WebView.WebViewTransport) resultMsg.obj).setWebView(popup);
            resultMsg.sendToTarget();
            return true;
        }

        // ---- حوارات JavaScript (alert وconfirm) ----
        // إن كانت الشاشة تُغلق نلغي النتيجة كي لا تبقى الصفحة معلّقة في انتظار حوار لن يظهر.
        // JavaScript dialogs are not shown by a WebView unless the app implements them; the admin panel
        // relies on confirm() before deleting products and categories.
        @Override
        public boolean onJsAlert(WebView view, String url, String message, JsResult result) {
            if (isFinishing()) {
                result.cancel();
                return true;
            }
            new AlertDialog.Builder(MainActivity.this)
                    .setMessage(message)
                    .setPositiveButton(R.string.ok, (d, w) -> result.confirm())
                    .setOnCancelListener(d -> result.cancel())
                    .show();
            return true;
        }

        @Override
        public boolean onJsConfirm(WebView view, String url, String message, JsResult result) {
            if (isFinishing()) {
                result.cancel();
                return true;
            }
            new AlertDialog.Builder(MainActivity.this)
                    .setMessage(message)
                    .setPositiveButton(R.string.ok, (d, w) -> result.confirm())
                    .setNegativeButton(R.string.cancel, (d, w) -> result.cancel())
                    .setOnCancelListener(d -> result.cancel())
                    .show();
            return true;
        }
    }

    // ---------------------------------------------------------------------------------------- lifecycle

    // حفظ صفحة WebView ليعود المستخدم إليها إذا أنهى النظام العملية في الخلفية (تُستعاد في applyServer).
    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        if (webView != null && webView.getUrl() != null) webView.saveState(outState);
    }

    @Override
    protected void onResume() {
        super.onResume();
        webView.onResume();
    }

    // flush يكتب الكوكيز على القرص فلا تضيع جلسة الدخول إذا قُتل التطبيق.
    @Override
    protected void onPause() {
        CookieManager.getInstance().flush();
        webView.onPause();
        super.onPause();
    }

    // تنظيف: إنهاء طلب الملفات المعلّق، وفصل WebView من الشاشة قبل تدميره لتفادي تسرب الذاكرة.
    @Override
    protected void onDestroy() {
        if (fileCallback != null) {
            fileCallback.onReceiveValue(null);
            fileCallback = null;
        }
        mainHandler.removeCallbacksAndMessages(null);
        ViewGroup parent = (ViewGroup) webView.getParent();
        if (parent != null) parent.removeView(webView);
        webView.destroy();
        super.onDestroy();
    }
}
