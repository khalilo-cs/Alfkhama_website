// ملف build.gradle.kts (الجذر): يعلن إضافة أندرويد (AGP) بإصدارها مرة واحدة لكل المشروع.
// المشروع فيه وحدة واحدة فقط (app)، وتفاصيل البناء كلها في app/build.gradle.kts.
plugins {
    // apply false: الإضافة لا تُفعَّل هنا بل داخل الوحدة app.
    id("com.android.application") version "9.4.1" apply false
}
