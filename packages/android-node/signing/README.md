# Debug-only signing key

`debug.keystore` is a public, dedicated development key. Its alias is `androiddebugkey`; the store and key passwords are both `android`. These values are intentionally public and must never be used for a release build.

All debug builds use this key and the application ID `io.foxwarm.android.debug`, with the label **Foxwarm Node (Debug)**. Builds from CI and local workspaces can upgrade the same debug installation without erasing pairing or settings. The release application ID remains `io.foxwarm.android`.

An older debug APK using the unsuffixed application ID is a separate installation: pair the new debug app once and enable its accessibility service. Installing the new debug app does not migrate or erase the old app's data.
