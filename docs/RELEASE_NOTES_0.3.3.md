# Mr.Robot 0.3.3 — stable plugin status and reliable Quick Link setup

Mr.Robot 0.3.3 fixes the Cloudflare Quick Link bootstrap path and a plugin-screen refresh loop. The desktop remains standalone by default, while Remote Link, Orca, and the other optional integrations stay disabled until the user enables them.

## Plugin UI stability

- Removed the `remoteStatus → plugins.list → status refresh` effect cycle that repeatedly toggled the Orca and Cloudflare button disabled state.
- Passive refreshes no longer flip interactive busy indicators, eliminating the visible button flicker.
- The fix also stops repeated Orca CLI subprocesses and repeated full dependency probes that the render loop caused.
- Pairing events read the latest Remote Link status through a ref without resubscribing the event handler.
- Refreshing a stopped fixed Tunnel no longer overwrites the saved `autoStart` preference.

## Reliable cloudflared setup

- The dependency probe now recognizes WinGet Links, Program Files, and Program Files (x86), matching every supported installation location.
- Windows installs cloudflared as the official x64, user-scoped portable WinGet package, avoiding the machine MSI stall seen on this host.
- First-run dependency wizard v5 includes cloudflared and waits up to 60 minutes for package installation.
- The Remote Link plugin has an explicit `cloudflared 설치` action and Quick Link waits up to 20 minutes when it must bootstrap the dependency during connection.
- The installed runtime was verified as cloudflared 2026.8.2.

## Version alignment

- Desktop, agent, web, shared packages and Android versionName are `0.3.3`.
- Android versionCode is `8` and the release signer is unchanged.
- The CTF toolbox reference is `mr-robot/ctf-toolbox:0.3.3`.

## Verification

- Typecheck passed for shared, agent, web, and mobile.
- Full build and automated test suites passed, including dependency and plugin UI regression contracts.
- The leak soak passed with no leak detected.
- The Android release build passed and APK Signature Scheme v2 verification reports the expected RSA-4096 signer.

## Verified artifacts

- `Mr.Robot-Setup-0.3.3-x64.exe` — 97,784,630 bytes, product/file version 0.3.3, SHA-256 `D452AD12621080E2816ACBA8F3670B51BBD277A344BA30DF5F3DEDE9620D2CC8`. Authenticode is not configured.
- `Mr.Robot-Mobile-0.3.3.apk` — 87,498,916 bytes, package `com.mrrobot.mobile`, versionCode 8, versionName 0.3.3, minSdk 24, targetSdk 36, SHA-256 `7AF6A9DA64DD4BDCA2013F0C87ED62549E9949C4FB3259D68A0EE7E05B082828`.
- APK signer certificate SHA-256: `EB782D956DABCA784D9E0AFC152BF7061ACE72CE805215E3C6502AAE72E1A0E6`.
- Checksums are recorded in `release/SHA256SUMS-0.3.3.txt`.

Windows may show SmartScreen because the EXE is not Authenticode-signed. Verify the published SHA-256 before running it.
