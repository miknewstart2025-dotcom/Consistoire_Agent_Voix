plugins {
    alias(libs.plugins.android.application)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.serialization)
}

android {
    namespace = "com.hotelos.dpc"
    compileSdk = 35
    defaultConfig {
        applicationId = "com.hotelos.dpc"
        minSdk = 28
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"
    }
    buildFeatures { aidl = true; buildConfig = true }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    // Release signing is done outside CI with the KMS-held key (docs/RELEASE_SIGNING.md).
}

dependencies {
    implementation(project(":dpc-core"))
    implementation(libs.kotlinx.coroutines.android)
    implementation(libs.okhttp)
    implementation(libs.work.runtime)
    implementation(libs.activity.compose)
    implementation(libs.lifecycle.runtime)
}
