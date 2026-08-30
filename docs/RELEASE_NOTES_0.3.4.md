# Mr.Robot 0.3.4 — live remote handoff and deliberate mobile pairing

Mr.Robot 0.3.4 makes the external-access path visible and predictable without weakening the standalone desktop default. Quick Link remains opt-in, but its live address now follows the tunnel state in real time. Mobile QR enrollment now separates recognition from connection, and a stronger administrator-created handoff code can be prepared before leaving the PC.

## Quick Link status that stays current

- The agent now forwards `remote-link.changed` only to authenticated administrator sessions.
- The plugin screen subscribes to that event and refreshes the public address, tunnel status, configuration, and pairing QR without requiring a manual page reload.
- A running HTTPS address is visible and copyable on the collapsed Remote Link card as well as in the expanded plugin and mobile-connection settings.
- Quick Link and named-Tunnel stop/restart transitions clear stale pairing UI instead of leaving an old address or QR on screen.

## Stable Remote PC management

- Opening **원격 PC 관리** from the profile menu now enters an explicit management state.
- The connection gate no longer auto-reconnects the last/local PC while that management screen is open, which removes the open-close flicker and keeps the menu usable until the user chooses a PC or cancels.
- Ordinary startup still auto-connects when appropriate; only the user-requested management path suppresses it.

## Mobile QR recognition before connection

- The camera continues scanning after unrelated or malformed QR codes instead of becoming permanently locked.
- A valid Mr.Robot QR is first recognized and frozen. The app displays every candidate HTTPS/Tailscale address and waits for **인식한 PC에 연결** before exchanging the code.
- **다시 스캔** clears the candidate without connecting. Closing the scanner also clears the in-memory payload and any pending status.
- Manual entry and QR parsing accept exactly a 6-digit ordinary PIN or a 12-digit remote handoff code; unsupported lengths and legacy secret-bearing QR payloads remain rejected.
- Desktop QR images are generated at 300 × 300 pixels with a four-module quiet zone and QR error-correction level M for more reliable phone-camera detection.

## Administrator-only unattended handoff

- A local desktop administrator can explicitly create a separate 12-digit, one-time code valid for up to 24 hours while a remote link is running.
- The handoff code exists only in agent memory. Its plaintext is not written to `config.json`, logs, plugin status, or a paired client's RPC responses.
- A successful enrollment consumes the handoff code and rotates the ordinary 6-digit PIN. Conversely, using or regenerating the ordinary PIN invalidates any pending handoff code.
- The handoff code is also destroyed when Remote Link stops, the agent stops or restarts, or the administrator presses **즉시 폐기**.
- PIN enrollment can create at most a non-administrator **변경 전 확인** device. Higher access must still be granted from the local PC's connected-device settings.
- Non-administrator paired sessions no longer receive the administrator-secret fingerprint field `maskedSecret`; they also receive no PIN, QR payload, or local secret.

## Version alignment

- Desktop, agent, web, shared packages, and Android versionName are `0.3.4`.
- Android versionCode is `9`, minSdk is 24, targetSdk is 36, and the CAMERA permission is declared.
- The CTF toolbox reference is `mr-robot/ctf-toolbox:0.3.4`.

## Verification

- Full typecheck passed for shared, agent, web, and mobile.
- Full production build and automated test suites passed, including Quick Link event delivery, connection-manager state, QR security, two-stage mobile scanning, handoff lifetime, mutual invalidation, access ceiling, and secret-visibility regressions.
- The leak soak completed with no leak detected.
- Android package metadata and APK Signature Scheme v2 verification passed with the existing RSA-4096 release signer.
- The short ASCII Android build staging directory `C:\MR034` was removed after packaging, reclaiming 8,071,110,563 bytes.

## Verified artifacts

- `Mr.Robot-Setup-0.3.4-x64.exe` — 97,787,680 bytes, SHA-256 `F0F06315DAD6D0CFB0E0A6634B0F3CD57D70BC4EC62558980B0BC55E446A638A`. Authenticode is not configured.
- `Mr.Robot-Mobile-0.3.4.apk` — 87,503,228 bytes, package `com.mrrobot.mobile`, versionCode 9, versionName 0.3.4, minSdk 24, targetSdk 36, SHA-256 `398B650CB2ABD9032951551F3C93BCF7604F83066518800DBEEFBF909FD48DAC`.
- APK signer certificate SHA-256: `EB782D956DABCA784D9E0AFC152BF7061ACE72CE805215E3C6502AAE72E1A0E6`.

The Windows installer remains unsigned and may trigger SmartScreen. Verify its SHA-256 before running it. A Quick Link or named Tunnel still requires the PC, Mr.Robot, and cloudflared to remain running; a 24-hour code does not keep a stopped tunnel alive.
