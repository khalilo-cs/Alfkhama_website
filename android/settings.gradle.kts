// ملف settings.gradle.kts: يحدد من أين تُنزَّل الإضافات والمكتبات وما الوحدات التي يتكوّن منها المشروع.
pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}
// FAIL_ON_PROJECT_REPOS: يمنع أي وحدة من إضافة مستودعات خاصة بها، فتبقى المصادر محصورة في google وmavenCentral.
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}
// اسم المشروع والوحدة الوحيدة المشمولة في البناء.
rootProject.name = "alfakhamah-android"
include(":app")
