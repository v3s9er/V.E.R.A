# Mr.Robot 0.3.6 — composer reasoning controls and safe execution settings

Mr.Robot 0.3.6 carries forward the mobile keyboard, explicit single-model selection, and one-click Quick Link recovery work from 0.3.5, then adds provider-aware reasoning controls to the desktop and Android chat composers. Execution settings are now persisted as one guarded operation so a command cannot accidentally start with the previous model, preset, workspace, access policy, or reasoning level.

## Reasoning controls

- Desktop places a compact **추론** selector beside the composer actions, with the same control mirrored in the conversation context panel.
- Android places explicit reasoning chips directly below the keyboard-safe message composer.
- Choices are filtered by the selected provider's declared capabilities. `auto` is always available, and `none` appears only for providers that support it.
- A provider with no capability metadata receives the conservative common set: `auto`, `low`, `medium`, `high`, `xhigh`, and `max`.
- Multi-model presets use the common set, while an incompatible value is normalized to `auto`.
- The selected effort is stored per conversation and remains changeable when the model changes.

## Reliable model and context switching

- Model, preset, reasoning, workspace, and access-policy changes use a synchronous UI lock before their persistence request starts.
- Send, voice execution, conversation switching, and conflicting settings are held until the new execution context is committed.
- Desktop applies the chosen setting immediately and rolls back only matching fields if persistence fails.
- Android reports a failed settings save without replacing newer conversation state with a stale object.
- The agent conversation store now restores every in-memory field and sync revision if the atomic disk save fails.
- A focused storage-recovery test injects a save failure and verifies exception propagation, object identity, complete state restoration, and byte-identical persisted data.

## 0.3.5 fixes retained

- Android's message list and composer resize with the software keyboard and preserve safe-area spacing.
- Mobile exposes explicit configured and manual single-model selection.
- Desktop can bootstrap cloudflared and create a fresh Quick Link QR from a loopback-only pairing state.
- Quick Link keeps a discovered public URL visible during the first verification delay and detects WinGet's direct portable package path.

## Security and packaging

- Private/signing key extensions are ignored repository-wide; clearly named public certificate PEM files remain trackable.
- Desktop, agent, web, shared, mobile, plugin manifests, and lock files are aligned to `0.3.6`.
- Android uses versionName `0.3.6`, versionCode `11`, minSdk 24, and targetSdk 36.
- The CTF toolbox image remains `mr-robot/ctf-toolbox:0.3.4`; its plugin manifest is `0.3.6`.

## Verification

- Shared, agent, web, and mobile TypeScript checks passed.
- Production web/agent build and Electron NSIS packaging passed.
- The full smoke, hardening, storage recovery, QR, plugin, provider, scheduler, AI loop, dependency, routing, CLI, UI contract, logger, and voice suite passed.
- The plugin/WebSocket stress test completed with no leak detected; total measured heap drift was about 1.3 MB.
- Repository diff validation and high-confidence credential scans passed.

## Verified Windows artifact

- `Mr.Robot-Setup-0.3.6-x64.exe` — 97,788,841 bytes, SHA-256 `5C309FA2B2D83D3A5BD1639EA9DDF049050CE4D34BB4B91B55CD4EEC63C1BD3A`.
- Authenticode is not configured, so Windows SmartScreen may show a warning. Verify the SHA-256 before running it.

## Android signing

The Android package is built with the existing Mr.Robot release identity, not a replacement key. Its expected signer certificate SHA-256 is `EB782D956DABCA784D9E0AFC152BF7061ACE72CE805215E3C6502AAE72E1A0E6`, allowing in-place updates from release-signed 0.3.0–0.3.4 builds. Exact APK size and file hash are recorded in `release/SHA256SUMS-0.3.6.txt`.

Quick Link remains an opt-in public HTTPS tunnel: the PC, Mr.Robot, and cloudflared must stay running. One-time pairing and travel handoff codes do not keep a stopped tunnel alive.
