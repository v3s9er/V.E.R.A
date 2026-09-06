# Mr.Robot 0.4.9 — local build

## Changes

- Desktop chat options now live beside the composer: execution PC, model, scenario, permission, reasoning and question budget. Removed duplicate header/context controls; workspace remains in the header.
- Mobile file listing, upload and download use a separate authenticated AES-256-GCM file channel. Register the phone normally, then scan the PC Files screen's file-encryption QR from the phone Files screen. This second QR must be scanned privately and never shared.
- Uploads enter a unique PC shared `.mobile-inbox` file instead of silently modifying a workspace. Chat attachments reference that uploaded PC file. Authorized workspace/shared files can be saved or shared from the phone while an AI run continues.
- Chunked 128 KiB transfers, 96 MiB per-file limit, partial-download cleanup, cancellation, path confinement, device ownership/revocation, authenticated responses and replay protection. Registered file devices cannot downgrade to legacy HTTP file downloads or transfer grants.
- Expiry included in quick-link QR payloads; DNS failures explain that a recognized QR is not proof its address is reachable.
- Cloudflare startup retries only non-JSON upstream 5xx responses. JSON 503 security-probe markers remain valid; Access failures still stop the connector.

## Security scope and limitations

File keys are generated on the PC and transferred by an optical QR, not the relay. Unused enrollment expires after five minutes; display hides after 60 seconds. Bound keys last 90 days and are stored using Windows DPAPI / mobile SecureStore. Reset requires local-PC confirmation.

This is a file-only PSK channel, not an independently audited, application-wide E2EE protocol. Chat, command RPC, Discord attachments, and existing PC-to-PC synchronization are outside this channel. Other authenticated RPC capabilities still require trusting the transport/access layer: do not describe this as protecting the entire agent against a malicious relay. It does not provide forward secrecy; compromise of a long-lived file key can compromise recorded transfers. Endpoints and the QR must be trusted. Encryption does not repair DNS, tunnel routing, Access policy, or device permission failures.

Old PC-to-PC transfer grants are intentionally refused for file-key-enrolled devices until that workflow gains encrypted transport. Stale upload staging is reclaimed on later channel requests or restart, not by a guaranteed background deadline.

## Validation and distribution

Node/OpenSSL ↔ Noble AES-GCM interoperability, tamper/replay/reflection rejection, enrollment ownership, revocation, read-only enforcement, traversal confinement, ordered uploads, restart/session rotation and real HTTP/DPAPI tests passed. Full smoke suite, desktop/mobile type checks, UI contracts and tracked public-release hygiene passed. Windows installer and signed Android APK built locally; Windows EXE is not Authenticode signed. No Android device was connected for a real-device test. Visual/keyboard QA on the user's phone remains necessary.

Final desktop 0.4.9.0 installed and relaunched; installed ASAR matches final build. Existing Discord standalone Gateway is ready with no active run. Installer SHA-256: `F6C855DE8A6D37E4DD761FEF456AA77E46C4AF10E0E56485969EBE6B37FAD32D`. APK SHA-256: `364EC4654A9E2C78978FDB0A6DAEF18677861B61E023E2B0914AE58B579A31DB`.

Artifacts: `release/Mr.Robot-Setup-0.4.9-x64.exe`, `release/mobile/Mr.Robot-Mobile-0.4.9.apk`. No GitHub or Drive publication performed for this change.

Remote production verification remains incomplete: the saved named tunnel did not return a valid Agent response; an authenticated probe returned HTTP 530. Cloudflare dashboard currently requires user login. Access was not disabled or bypassed. The old trycloudflare address in the screenshot must not be treated as permanent.
