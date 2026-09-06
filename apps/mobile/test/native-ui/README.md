# Native keyboard regression fixture

This separate `com.mrrobot.mobile.uitest` debug application mounts the real
HomeScreen and ChatScreen with an in-memory RPC fixture. It never reads production
credentials, contacts an AI provider, or sends a network request. Release builds
cannot select this entry, including through aggregate Gradle task graphs.

On a disposable Android emulator, in an ASCII-only checkout with mobile dependencies,
Android SDK and a local debug signing key available:

```powershell
# Omit this variable for idle/send tests; use 1 for active/stop tests.
$env:EXPO_PUBLIC_MR_ROBOT_UI_BUSY = '1'
./gradlew.bat :app:assembleDebug :app:assembleDebugAndroidTest -PmrRobotUiTest=true -PreactNativeArchitectures=x86_64
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb install -r app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk
adb shell settings put system font_scale 1.5
adb shell am instrument -w -e orientation landscape com.mrrobot.mobile.uitest.test/com.mrrobot.mobile.KeyboardAudit
adb shell am instrument -w com.mrrobot.mobile.uitest.test/com.mrrobot.mobile.KeyboardAudit
adb shell settings put system font_scale 1.0
```

Run Gradle from `apps/mobile/android`. Keep emulator selection explicit with
`adb -s SERIAL` if other devices are attached. Restore the original font scale;
never change a user's physical phone configuration for this fixture.

Require `NATIVE KEYBOARD AUDIT PASSED` in output; `am instrument` itself may return
exit code zero on a reported assertion failure. The audit opens/closes the actual
Android IME three times, checks the multiline insertion cursor and send/stop control
against real window/IME bounds in both dimensions, and captures a screenshot in
the test application's external files directory. Inspect that image as well.

Do not run release builds concurrently with native fixture builds. Remove the
test environment variable before release packaging. The normal release entry is
unchanged. Emulator success does not certify every OEM keyboard or physical phone.
