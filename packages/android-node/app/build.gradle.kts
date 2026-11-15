import groovy.json.JsonSlurper

plugins { id("com.android.application"); kotlin("android") }
// Release builds receive the checked tag version; local and CI builds stay identifiable.
val releaseVersion = providers.gradleProperty("releaseVersion").orNull
val sourceVersion = (JsonSlurper().parse(rootProject.file("../../package.json")) as Map<*, *>)["version"] as String
val version = releaseVersion ?: sourceVersion
require(Regex("(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)").matches(version)) {
    "Android versions must be stable major.minor.patch versions: $version"
}
val (major, minor, patch) = version.split('.').map { it.toLong() }
val androidVersionCode = major * 1_000_000 + minor * 1_000 + patch
require(major <= 2100 && minor < 1000 && patch < 1000 && androidVersionCode in 1..2_100_000_000) {
    "Android version exceeds the supported versionCode range: $version"
}
android {
    namespace = "io.foxwarm.android"
    compileSdk = 35
    defaultConfig {
        applicationId = "io.foxwarm.android"
        minSdk = 30
        targetSdk = 35
        versionCode = androidVersionCode.toInt()
        versionName = releaseVersion ?: "$sourceVersion-dev"
    }
    buildTypes {
        getByName("release") {
            // Tagged builds and explicit signing qualifications are signed outside Gradle.
            if (releaseVersion == null && !providers.gradleProperty("releaseSigning").getOrElse("false").toBoolean()) signingConfig = signingConfigs.getByName("debug")
        }
    }
    signingConfigs {
        getByName("debug") {
            storeFile = rootProject.file("signing/debug.keystore")
            storePassword = "android"
            keyAlias = "androiddebugkey"
            keyPassword = "android"
        }
    }
    buildTypes {
        getByName("debug") {
            applicationIdSuffix = ".debug"
            signingConfig = signingConfigs.getByName("debug")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    testOptions { unitTests.isIncludeAndroidResources = true }
}
dependencies {
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.robolectric:robolectric:4.14.1")
    implementation(project(":core"))
    implementation("androidx.activity:activity-ktx:1.9.3")
    implementation("com.journeyapps:zxing-android-embedded:4.3.0")
}
