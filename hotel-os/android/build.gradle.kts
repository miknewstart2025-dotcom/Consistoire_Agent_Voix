// Android plugins are resolved by the Android modules themselves, which are only included
// when an Android SDK is present (see settings.gradle.kts). The JVM modules build anywhere.
plugins {
    alias(libs.plugins.kotlin.jvm) apply false
    alias(libs.plugins.kotlin.serialization) apply false
}
