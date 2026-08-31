# Mr.Robot 0.3.5 — mobile model controls and one-click pairing recovery

Mr.Robot 0.3.5 repairs the three connection and mobile-chat regressions reported after 0.3.4. The mobile composer now follows the Android keyboard, single-model conversations expose their model control directly, and the desktop pairing screen can bootstrap Quick Link instead of showing a QR-less dead end.

## Mobile chat and single-model selection

- Android uses resize-aware keyboard handling and a height-adjusting chat container so the message list and composer remain visible while typing.
- Safe-area padding is reduced only while the keyboard is open, avoiding the large bottom gap that previously pushed content over the input area.
- A visible **단일 모델 선택** control is available next to the conversation controls.
- The picker supports configured provider/model choices as well as a manual provider and model ID, and updates the conversation's single-model command mode immediately.
- Scenario selection and single-model selection share the same model choices without forcing the user through an unrelated scenario.

## QR and Quick Link recovery on desktop

- When only the loopback address exists, the mobile-connection card now shows a confirmed **Quick Link 시작·QR 만들기** action.
- That action checks the Remote Link plugin and cloudflared dependency, installs cloudflared when missing, enables/configures Quick Link for the active local port, starts it, rotates the one-time PIN, and refreshes the pairing information.
- A first public-endpoint verification delay no longer discards a tunnel URL that cloudflared has already provided; the UI keeps the link and QR visible while reporting the verification warning.
- Windows cloudflared discovery also checks WinGet's direct package directory, covering portable installs where `WinGet\Links` was not created.
- Loopback-only QR codes remain intentionally hidden because a phone cannot use `127.0.0.1` to reach the PC.

## Version alignment

- Desktop, agent, web, shared packages, mobile package, and Android versionName are `0.3.5`.
- Android versionCode is `10`, minSdk is 24, and targetSdk is 36.
- The unchanged CTF toolbox image remains `mr-robot/ctf-toolbox:0.3.4`; the Docker plugin manifest is `0.3.5`.

## Verification

- Full shared, agent, web, and mobile typecheck passed.
- Full production build passed.
- All automated smoke, hardening, storage recovery, QR security, plugin security, provider security, scheduler, AI loop, dependency, routing, CLI, UI contract, logger, and voice tests passed.
- The Windows installer was installed over 0.3.4 on the current laptop; its installed file and product versions report 0.3.5, and the local `/api/ping` probe returns success.

## Verified Windows artifact

- `Mr.Robot-Setup-0.3.5-x64.exe` — 97,788,177 bytes, SHA-256 `9AA17EE5ED4F29E3A5F3661F63A5E95995AD7A6BB81FA66D7CA6D527F1114A9D`. Authenticode is not configured.

## Android packaging status

The Android 0.3.5 source and versionCode 10 configuration are complete, but this checkout does not contain the existing private release key. A replacement-signed APK is intentionally not published because it could not update Android 0.3.0–0.3.4 in place. Packaging can resume when `mr-robot-release.jks` and its matching DPAPI-protected password are restored under `C:\Users\<사용자>\.mr-robot\signing`; the expected signer certificate SHA-256 is `EB782D956DABCA784D9E0AFC152BF7061ACE72CE805215E3C6502AAE72E1A0E6`.

The Windows installer remains unsigned and may trigger SmartScreen. Verify its SHA-256 before running it. Quick Link still requires the PC, Mr.Robot, and cloudflared to remain running.
