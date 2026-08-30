# Mr.Robot 0.3.0 — ecosystem overhaul

Mr.Robot 0.3.0 rebuilds the desktop/mobile agent around reliable long-running work, lower repeated-token cost, safer remote access, and a substantially more polished UI.

## Highlights

- **Desktop works standalone.** A phone or remote PC is optional.
- **Single model or agent graph per conversation.** Switch Codex, Claude, API/local models, reasoning effort, workspace, access, or a saved scenario without recreating the provider.
- **High-efficiency built-ins.** Smart cascade, low-cost vote, sequential validation, hybrid council, and competitive CTF swarm presets are protected defaults; custom copies remain editable.
- **Shared context and measurable caching.** Files are fingerprinted and bounded once, cache prefixes are reused, and input/output/reasoning/cache-read/cache-write usage is shown separately.
- **Reliable control.** Per-conversation run state, stop, safe-boundary steering, terminal-state validation, provider budgets, and process-tree/container cancellation prevent jobs from spinning after completion.
- **Reconnect-safe long jobs.** A transient phone or desktop socket loss no longer cancels the agent run. The same paired device can reconnect, recover run state, and resume an outstanding approval without exposing it to another device.
- **Mobile usability.** Keyboard-safe composer and modals, automatic reconnect, conversation-isolated activity, secure per-PC credentials, cancellable transfers, and partial-file cleanup.
- **VPN-free remote option.** Cloudflare Quick Link provides a temporary HTTPS/WSS QR connection without keeping Tailscale active on the phone. Tailscale remains an optional plugin.
- **One-scan enrollment.** Quick Link shows an HTTPS QR carrying a five-minute, single-use PIN. Successful enrollment rotates it immediately; plain HTTP LAN credential exchange is rejected.
- **Conflict-safe PC sync.** Conversations and user presets use a dedicated per-device `work-sync` capability, one-use transfer grants, and preserved conflict copies instead of silent last-write-wins loss.
- **Crash recovery.** Configuration and conversations use fsync + atomic replace + last-known-good backups; corrupt bytes are quarantined and an unreadable DPAPI key cannot wipe unrelated settings.
- **Token-free device transfers.** File and work-state sync stream directly between devices. Cross-PC pulls use 90-second, single-use capabilities instead of forwarding a source PC's long-lived credential.
- **Permission ceilings.** Global, device, conversation, workspace, and destructive-action policy layers are rechecked at execution time. Remote non-admin views are explicitly read-only.
- **Immediate credential revocation.** Device downgrade/revoke and global credential rotation now close matching live sessions and cancel their runs and pending approvals; ordinary network loss remains reconnect-safe.
- **Fail-closed enrollment and events.** QR import accepts only v3 HTTPS/Tailscale payloads with a six-digit one-use PIN, pairing has per-client and global guessing bounds, and scheduler/log/voice/provider events remain administrator-only.
- **Hardened plugins and CTF runtime.** Host-owned execution contexts and AbortSignal propagation, workspace realpath confinement, symlink/junction and TOCTOU defenses, bounded Docker resources, and process cleanup.
- **New brand assets and license notices.** Desktop, Android, splash, and web icons share one Mr.Robot mark; production packages include deterministic third-party notices.

## Mobile upgrade note

The 0.2.1 and older test APKs were signed with an Android debug certificate. Version 0.3.0 starts a dedicated Mr.Robot release-signing identity, so Android cannot install it over those builds. Sync anything you need, uninstall the old mobile app once, install 0.3.0, and pair the PC again. Future 0.3.x builds can update normally as long as the release key is preserved.

## Connection choices

- No phone VPN: start Quick Link and scan the temporary HTTPS QR shown by the PC. Plain HTTP LAN credential exchange is blocked.
- Outside the network without a phone VPN: enable the Remote Link plugin and start Cloudflare Quick Link.
- Existing private mesh: enable the optional Tailscale plugin.

Quick Link addresses are temporary and change after restart. A stable branded endpoint still requires a user-owned named tunnel or relay/OAuth backend.

## Distribution notes

- The Android APK is signed with the local Mr.Robot release key.
- The Windows installer is not Authenticode-signed, so SmartScreen can require confirmation. Verify its SHA-256 against the GitHub release.
- A physical-phone pass remains recommended for manufacturer-specific background behavior, camera pairing, keyboard behavior, and remote transfer.
- If Orca has already accepted a worktree creation before cancellation, Mr.Robot terminates the local CLI tree but does not automatically delete that worktree because it may contain user data.

## Verified artifacts

- Windows x64 installer — 97,776,543 bytes — SHA-256 `759FA12C29BE629111F95D5865ADBE5062877C6B50AD90D79A9C2A5A6157F682`
- Android APK — 87,498,916 bytes — SHA-256 `30EDCBB4BD70BBC285B2CCD0056B04539E38A99C426F0DF0BB11BE6710BBFDCD`
- Android package `com.mrrobot.mobile`, version `0.3.0` (versionCode 5), target SDK 36, APK Signature Scheme v2 verified.
