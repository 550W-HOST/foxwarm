plugins { id("com.android.application"); kotlin("android") }
android {
    namespace = "io.foxwarm.android"
    compileSdk = 35
    defaultConfig {
        applicationId = "io.foxwarm.android"
        minSdk = 30
        targetSdk = 35
        versionCode = 1
        versionName = "0.1.0"
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
