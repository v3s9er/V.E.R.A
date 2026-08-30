# Mr.Robot 0.3.2 — secure persistent remote link

Mr.Robot 0.3.2 adds a user-owned Cloudflare named Tunnel alongside the temporary Quick Link. The desktop remains standalone by default; remote exposure is still an explicit, administrator-only plugin action.

## Cloudflare named Tunnel

- Enter a fixed public hostname and remotely-managed Tunnel connector token in the Remote Link plugin.
- Keep the Agent bound to loopback while cloudflared creates an outbound-only HTTPS/WSS connection.
- Reconnect an enabled named Tunnel when Mr.Robot starts, without changing its public hostname.
- Verify the public `/api/ping` endpoint before presenting the mobile pairing QR.
- Keep Quick Tunnel as a temporary, account-free fallback and Tailscale as an optional plugin.

## Security hardening

- Protect the Tunnel token with Windows DPAPI and never return plaintext through plugin status/config RPC.
- Pass the credential through the child environment instead of process arguments and redact token-shaped diagnostic output.
- Restrict the published origin to the Agent loopback address and validate fixed hostnames as pathless HTTPS DNS names.
- Bound external verification responses, reject redirects, and require the exact Mr.Robot health response.
- Reject IP/internal hostnames in named-Tunnel verification and harden public responses with CSP, no-store, clickjacking and capability-policy headers.
- Bind Electron downloads to a trusted main frame and the matching encrypted PC origin+credential, reject redirects, and enforce the 2GB stream ceiling.
- Retain 5-minute, one-use pairing PINs, global/per-client attempt ceilings, per-device revocable tokens, administrator-only transport configuration, and execution-time permission ceilings.
- Allow the locally stored connector token to be cleared independently; Cloudflare-side rotation/revocation remains authoritative.

## Version alignment

- Desktop, agent, web, shared packages and Android versionName are `0.3.2`.
- Android versionCode is `7` and continues using the dedicated 0.3 release signer.
- CTF toolbox reference is `mr-robot/ctf-toolbox:0.3.2`.
- The complete 0.3.2 review is in `docs/SECURITY_AUDIT_0.3.2.md`.

## Verified artifacts

- `Mr.Robot-Setup-0.3.2-x64.exe` — 97,783,858 bytes, product/file version 0.3.2, SHA-256 `AFBDEC083B78E3C67507811AA4DA27D76F1D2585CB4225E8ED0C019BBB712932`. Authenticode is not configured.
- `Mr.Robot-Mobile-0.3.2.apk` — 87,498,916 bytes, package `com.mrrobot.mobile`, versionCode 7, targetSdk 36, SHA-256 `29285CEB01BEB556FF9FAC32D66368782CE5F476992C4097F6ABE06503604707`.
- APK Signature Scheme v2 and the existing release certificate SHA-256 `EB782D956DABCA784D9E0AFC152BF7061ACE72CE805215E3C6502AAE72E1A0E6` were verified.
- Checksums are recorded in `release/SHA256SUMS-0.3.2.txt`.
