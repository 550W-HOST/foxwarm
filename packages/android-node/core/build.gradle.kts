plugins { kotlin("jvm") }
kotlin { jvmToolchain(17) }
dependencies {
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    compileOnly("org.json:json:20240303")
    testImplementation("org.json:json:20240303")
    testImplementation("junit:junit:4.13.2")
    testImplementation("com.squareup.okhttp3:mockwebserver:4.12.0")
}
tasks.test {
    // The owned Main driver supplies these only for its integration test invocation.
    inputs.property("mainUrl", providers.environmentVariable("FOXWARM_ANDROID_TEST_URL").orElse(""))
    testLogging { events("passed", "skipped", "failed") }
}

// Runs the production transport with a synthetic device for the owned Main process test.
tasks.register<JavaExec>("runMainPeer") {
    dependsOn(tasks.testClasses)
    classpath = sourceSets.test.get().runtimeClasspath
    mainClass.set("io.foxwarm.android.MainPeerKt")
    standardInput = System.`in`
}
