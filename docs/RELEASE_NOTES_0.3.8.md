# Mr.Robot 0.3.8 — hardened remote access

Mr.Robot 0.3.8 preserves the 0.3.7 private work calendar and adds a security-focused remote-access release for the user-owned `robot.v3s9er.com` Cloudflare Tunnel. The PC remains fully usable by itself; Remote Link, Quick Link, Tailscale, and Orca remain optional.

## Public enrollment and WebSocket protection

- Public Cloudflare enrollment rejects the ordinary six-digit local PIN. It accepts only a separately generated 12-digit, cryptographically random, memory-only handoff that expires within 24 hours and is consumed once.
- Pairing information returned to linked devices omits the administrator secret, ordinary PIN, QR payload, handoff, and secret fingerprints.
- Public WebSocket upgrades require a short-lived, source-bound, one-use ticket obtained through an already authenticated HTTPS request. Unauthenticated sockets cannot occupy the pre-authentication pool through Cloudflare.
- Authenticated sockets have global, source, device, message-rate, byte-rate, in-flight RPC, heartbeat, payload, and authentication-time limits. Permission changes and revocation invalidate live sessions immediately.
- Explicit foreign browser Origins are rejected. Native clients can omit Origin; the reviewed desktop loopback controller and exact public origin remain supported.

## Connector and credential hardening

- On Windows, `cloudflared` is resolved to a regular canonical file and must have a valid Authenticode signature from exactly `Cloudflare, Inc.` before the tunnel token is decrypted or the process starts.
- Named Tunnel credentials stay protected by Windows DPAPI. At launch the Connector token is converted in memory to local credentials and cloudflared receives an app-generated config containing exactly one validated hostname → loopback Agent ingress plus a catch-all 404. Remotely configured stale origins are not executed by this Connector; credentials never appear in process arguments, status, or diagnostics.
- Quick Link is transient: it cannot overwrite or downgrade the saved named Tunnel, hostname, automatic-start setting, or DPAPI credential. Stopping Quick Link restores an enabled named Tunnel.
- The DPAPI vault no longer retains a plaintext-keyed process cache, and its PowerShell helper is pinned to the Windows system path with bounded execution and error output.
- Browser-only clients migrate legacy long-lived connection credentials out of `localStorage` and keep them only for the current session. Electron continues to use Windows `safeStorage`; Android continues to use `SecureStore`.
- The global administrator secret is no longer stored in `config.json` or returned to the Electron renderer. It lives in a separate DPAPI envelope, corrupt-config recovery rotates it and revokes links, and the main process injects short-lived local authorization on behalf of the renderer.
- Saved remote-PC bearer tokens also stay in the Electron main process. The renderer receives opaque PC identifiers and non-secret metadata only; WebSocket, HTTP, download, and short-lived PIN-pairing credentials are injected or consumed by the main process for the exact registered origin.
- MCP server environment values are stored as a purpose-separated DPAPI envelope. Legacy plaintext records migrate before commands become available, while RPC responses expose variable names only and protection failures leave the prior configuration intact.
- Subscription CLIs and dependency/cloudflared child processes receive explicit environment allowlists rather than the desktop process environment. Unsafe user-supplied CLI flags are ignored and native runs have hard time/output limits.
- Auto-install uses exact Codex, Claude, Sherpa and sounddevice versions. Voice assets are pinned to SHA-256 values from the verified upstream checksum manifest and extracted with traversal, link, entry-count and expansion-size checks.

## Transport boundaries

- Renderer and mobile authentication never trust a literal `100.64.0.0/10` address by range alone. All non-loopback PIN, device-token, HTTP, and WebSocket traffic requires HTTPS/WSS; Tailscale users can supply a Tailscale Serve HTTPS hostname. Existing raw-IP records are filtered before use.
- Backend PC-to-PC transfers may use plain Tailscale transport only when the receiving socket and the outbound pinned request are both proven to use the actual Tailscale adapter. Merely using a CGNAT-looking address is insufficient.
- Device-to-device file and work-state pulls use narrow, memory-only, single-use transfer grants. Plain HTTP is limited to loopback or a socket proven to use the local Tailscale adapter; ordinary Wi-Fi/LAN HTTP, redirects, embedded credentials, link-local/metadata targets, DNS rebinding, and oversized responses are rejected.
- User-owned named HTTPS tunnel domains are supported for PC-to-PC pulls. DNS is resolved once, every answer must be publicly routable, the selected address is pinned for the request, and TLS still validates the original hostname.
- Public API responses are `no-store`, security headers are enabled, and framework identity is suppressed.
- The fixed Cloudflare hostname uses Full (strict), minimum TLS 1.2, TLS 1.3, Always Use HTTPS, HSTS, DNSSEC, API cache bypass, method and foreign-Origin blocking, authentication-header checks, and pairing rate limits.
- Quick Tunnel addresses are clearly marked as temporary and outside the user-domain WAF policy.

## Compatibility retained from 0.3.7

- The encrypted private work calendar, bounded read-only XLSX import, Seoul holiday rules, NAVER route validation, and separately revocable mobile capability remain intact.
- Model/provider selection, reasoning controls, routing presets, keyboard-safe mobile composer, file transfer, work sync, voice control, CTF/Docker, MCP, and native Codex/Claude execution remain available.
- Android versionName is `0.3.8` and versionCode is `13`, using the existing Mr.Robot release signing identity for in-place updates.

## Model-run and token-budget admission

- REST and WebSocket chat now share one admission policy before a conversation or provider run is created. Read-only links cannot invoke a model.
- Global, administrator, and linked-device ceilings cover concurrent runs, start frequency, and reported token use; cleanup is guaranteed after success, failure, or cancellation and bounded accounting state cannot grow without limit.
- A selected multi-model tree counts as one admitted user run, so the protection limits abusive parallel starts without weakening the internal routing, meeting, voting, or verification workflow.

## Operational limits

- The PC, Mr.Robot, and `cloudflared` must be running for remote access. A handoff code does not keep a stopped PC online.
- Cloudflare plan request-size limits still apply to a single public upload. Large transfers should use chunking or the optional direct Tailscale transport.
- Public uploads are additionally capped at 96 MiB by the Agent. File transfer requires an explicit per-device capability, enforces concurrent and rolling-byte admission, keeps 2 GiB free disk space, and limits the shared area to 10 GiB.
- The Windows installer is not Authenticode-signed and can trigger SmartScreen; verify it against `SHA256SUMS-0.3.8.txt`.

## Verification

- Shared, agent, web, and Android typechecks; production builds; the full functional/security suite; storage and calendar recovery tests; UI contracts; dependency audits; and leak stress tests are required for this release.
- Public verification covers HTTPS health, TLS downgrade rejection, edge authentication and Origin rules, authenticated WSS, named-Tunnel automatic restart, installer launch, and official Android signer continuity.
