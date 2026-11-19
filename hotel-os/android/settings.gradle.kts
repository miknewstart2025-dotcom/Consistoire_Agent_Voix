pluginManagement {
    repositories {
        google {
            content {
                includeGroupByRegex("androidx\\..*")
                includeGroupByRegex("com\\.android.*")
                includeGroupByRegex("com\\.google\\.android.*")
                includeGroupByRegex("com\\.google\\.testing.*")
            }
        }
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google {
            content {
                includeGroupByRegex("androidx\\..*")
                includeGroupByRegex("com\\.android.*")
                includeGroupByRegex("com\\.google\\.android.*")
                includeGroupByRegex("com\\.google\\.testing.*")
            }
        }
        mavenCentral()
    }
}
rootProject.name = "hotel-os-android"

// Pure-JVM module: builds and tests anywhere (CI without Android SDK included).
include(":dpc-core", ":iptv-core")

// Android modules need the Android SDK (ANDROID_HOME or local.properties sdk.dir).
val sdkAvailable = System.getenv("ANDROID_HOME") != null ||
    System.getenv("ANDROID_SDK_ROOT") != null ||
    file("local.properties").let { it.exists() && it.readText().contains("sdk.dir") }
if (sdkAvailable) {
    include(":dpc", ":launcher", ":iptv")
} else {
    logger.warn("Android SDK not found: only :dpc-core is configured. Set ANDROID_HOME to build the APKs.")
}
