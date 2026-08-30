# Mr.Robot 0.3.1 — verified distribution refresh

Mr.Robot 0.3.1 packages the completed desktop/mobile ecosystem overhaul as a newly verified Windows installer and Android update. It keeps the 0.3.0 feature set and security model while aligning every product version, release artifact, Docker reference, and handoff record.

## What is included

- Standalone Windows desktop agent with optional Android and remote-PC workflows.
- Per-conversation direct-model or reusable multi-agent graph selection, switchable providers/models/reasoning/workspace/access, shared context caching, run budgets, stop, and steering.
- Protected smart-cascade, voting, sequential-validation, hybrid-council, and competitive CTF presets plus editable custom nodes, directed edges, visual groups, meetings, votes, and validation judges.
- Drag-and-drop files, cancellable token-free device transfer/sync, conversation pin/rename/archive/delete, calendar and modular plugins.
- Optional HTTPS Cloudflare Quick Link and optional Tailscale plugin; the PC does not require either one for local use.
- Desktop dependency setup workflow, deterministic third-party notices, and a signed Android release build.

## Distribution changes

- Product and package versions are aligned at `0.3.1`.
- Android is `versionCode 6` and uses the same dedicated release signer as 0.3.0, so 0.3.0 can update in place.
- The CTF toolbox reference is aligned to `mr-robot/ctf-toolbox:0.3.1`.
- Windows installer metadata reports product/file version 0.3.1.
- Release checksums are published in `SHA256SUMS-0.3.1.txt`.
- The Android release script now fails early with a clear instruction when Windows React Native/NDK is invoked from a non-ASCII checkout path. It refuses incomplete/missing signing state by default and verifies the official certificate fingerprint after packaging. The published APK was built from an ASCII-only checkout.

## Verified artifacts

- `Mr.Robot-Setup-0.3.1-x64.exe`
  - 97,775,926 bytes
  - SHA-256 `D6967E6341850C751171EA06D0E9F538ADC5D688E8A4B601B6D0794688BEBBB2`
  - Product/file version 0.3.1
  - Authenticode: unsigned
- `Mr.Robot-Mobile-0.3.1.apk`
  - 87,498,916 bytes
  - SHA-256 `9D0426C0DC03AE8E6F9CF69D1632F175E3585529FF802BA8785DF33628E17057`
  - Package `com.mrrobot.mobile`, versionName `0.3.1`, versionCode `6`, target SDK `36`
  - APK Signature Scheme v2 verified; one RSA 4096-bit signer
  - Signer certificate SHA-256 `EB782D956DABCA784D9E0AFC152BF7061ACE72CE805215E3C6502AAE72E1A0E6`

## Verification

- Type checking passed for shared, agent, web, and mobile packages.
- Production web/desktop build and Electron NSIS packaging passed.
- All smoke, hardening, storage-recovery, QR, plugin/provider security, scheduler, AI-loop, dependency, routing, CLI, compatibility, UI-contract, logger, and voice tests passed.
- Leak soak passed with 1,340 KiB retained-heap drift and no detected leak.
- Root and mobile production dependency audits report 0 vulnerabilities.
- Deterministic third-party notices cover 635 production packages and are embedded in both desktop and APK distributions.

## Upgrade and trust notes

- Android 0.3.0 users can install 0.3.1 directly. Builds at 0.2.1 or older used a debug certificate and require one uninstall before moving to the dedicated release key.
- The Windows installer is not Authenticode-signed and may trigger SmartScreen. Verify its SHA-256 before running it.
- A physical-phone pass is still recommended for OEM-specific background restrictions, camera pairing, keyboard behavior, and remote transfer.
- Future Android updates require preservation of the current private release key; the key and its password are not stored in Git.
