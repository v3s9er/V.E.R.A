# Mr.Robot 0.3.2 security audit

Audit date: 2026-08-31  
Primary focus: Cloudflare remote connectivity, pairing, device credentials, WebSocket/HTTP authorization, file transfer, desktop IPC, Android credential storage, plugins and dependency supply chain.

## Outcome

No known npm advisory remains in either the root production/development dependency graph or the Android/Expo production graph. No repository or Git-history match was found for the previously supplied provider key, administrator secret/PIN prefixes, common API-key patterns, or private-key headers.

The fixed Cloudflare Tunnel implementation keeps the Agent on loopback and gives cloudflared only an outbound connector. A public address never becomes an administrator session: every protected HTTP call and every WebSocket RPC still needs the local administrator secret or a revocable, hashed per-device token.

## Findings fixed for 0.3.2

### High — desktop download IPC could be a token-forwarding confused deputy

The renderer supplied a URL and bearer token to Electron's main process. The old handler accepted arbitrary HTTP(S), followed redirects, and did not bind the token to the encrypted PC registry.

Fixed controls:

- Accept IPC only from the current main frame served by the embedded loopback Agent.
- Require the requested origin and credential to match the same encrypted saved-PC record, or the exact embedded local Agent origin and administrator secret.
- Reject redirects so a remote response cannot forward a device credential to another origin.
- Bound both advertised and streamed response size to 2GB.
- Keep atomic partial-file handling and cancellation cleanup.

### Medium — named-Tunnel verification admitted non-public destinations

The hostname parser required HTTPS syntax but initially allowed IP literals and internal DNS suffixes. That could turn the administrator-only verification request into an unintended local request.

Fixed controls:

- Reject IP literals and local/internal/LAN/home.arpa suffixes.
- Reject credentials, ports, paths, query strings and fragments.
- Reject redirects, cap the response at 16KB and require the exact `{ ok: true, app: "mr-robot" }` health contract.

### Medium — browser-facing responses needed stronger public-endpoint headers

Fixed controls:

- Disable Express identity disclosure.
- Add CSP, frame denial, MIME sniffing denial, referrer policy, permission policy and cross-origin isolation headers that do not break authenticated client flows.
- Mark every API response `no-store` so pairing and authenticated data are not cached.
- Add HSTS for clients that receive the response over Cloudflare HTTPS; ordinary HTTP loopback clients ignore it.

## Remote connection security model

### Tunnel credential

- The connector token is write-only in the UI/RPC contract.
- It is encrypted at rest with Windows DPAPI for the current user.
- It is passed to cloudflared through `TUNNEL_TOKEN`, not a command-line argument.
- Token-shaped child diagnostics are redacted and bounded before reaching status RPC/UI.
- The stored token can be deleted in Mr.Robot and should also be rotated or revoked in Cloudflare after suspected compromise.

### Agent exposure

- Cloudflare can publish only an `http://127.0.0.1:<port>` Agent origin; the plugin rejects arbitrary local services and LAN targets.
- Quick Tunnel remains opt-in and temporary. Named Tunnel is opt-in, uses a user-entered fixed HTTPS hostname, and may auto-start only after the administrator saves that choice.
- Enabling, configuring, starting, stopping and inspecting the transport are administrator-only plugin commands.
- An external verification succeeds before the pairing QR is refreshed.

### Enrollment and device authorization

- Pairing uses a six-digit PIN valid for five minutes and one successful exchange.
- Failure ceilings apply per client and globally, including distributed source identities.
- A PIN can bootstrap at most `ask` permission even if a modified client requests `full`; workspace/full elevation requires the local PC administrator.
- The long-lived device token is shown only to the enrolling client, stored as a hash on the Agent, encrypted with Electron `safeStorage` on desktop and Expo SecureStore on Android, and can be revoked per device.
- A full device permission is still not an administrator identity. Provider, plugin, global settings and scheduler control remain local-admin only.
- Permission downgrade, link revocation and global credential rotation invalidate live sockets, pending approvals and owned runs immediately.

### WebSocket and events

- Non-loopback/non-Tailscale direct sockets are rejected; Cloudflare reaches the Agent from the loopback connector and Tailscale uses its CGNAT range.
- Authentication is mandatory before RPC.
- Paired event visibility uses an explicit allowlist. Logs, provider state, plugin state, dependency state, voice transcripts and scheduler data require administrator access; unknown future events fail closed.
- A run is bound to its device link. Other paired devices cannot inspect, steer, approve or stop it; the local administrator can stop any run.

### Files and PC-to-PC synchronization

- Workspace and shared-folder paths are canonicalized below registered roots and reject lexical traversal, symlinks and Windows junction/reparse ancestors.
- Uploads use exclusive temporary files, byte limits, post-stream destination revalidation and atomic rename.
- Cross-PC file/sync pulls use 90-second, single-use, operation-scoped grants rather than forwarding the source PC's long-lived token.
- Server-side peer pull accepts only private/loopback, Tailscale and Quick-Tunnel origins. Arbitrary custom public domains remain blocked intentionally until a cryptographically pinned peer registry is available; relaxing this would reopen DNS-rebinding/SSRF risk.
- AI/provider tokens are not spent for direct device byte transfer or snapshot synchronization.

## Platform and plugin review

- Electron uses context isolation, renderer sandboxing, disabled Node integration, same-origin navigation, denied popup creation and an allowlisted HTTP(S)-only external-link handler.
- Desktop PC credentials are encrypted with Electron `safeStorage`; recovery preserves the prior encrypted snapshot instead of silently overwriting it.
- Android disables backup and stores device tokens separately in SecureStore. Cleartext transport remains enabled at the Android network layer only because dynamic Tailscale IP connections use HTTP; application validation rejects ordinary plaintext LAN/public origins.
- Destructive plugin tools receive the live run AbortSignal and host-side permission scope. Docker mounts are restricted to the selected workspace realpath and writable output cannot remount the challenge root.
- Remote-Link, dependency, provider and plugin control RPCs are not available to ordinary paired-device identities.

## Verification performed

- Full TypeScript typecheck: shared, agent, web and mobile.
- Full automated test suite: HTTP/WS auth, PIN ceilings, origin policy, path confinement, transfer grants, synchronization validation, plugin execution, provider URL security, scheduler ownership, routing/model execution, desktop/mobile UI contracts, QR parsing and voice lifecycle.
- Leak suite: plugin churn, 80 authenticated WebSocket cycles and repeated screen stream start/stop; final measured drift 1,332KB with stable listeners/clients/plugins (`NO LEAK DETECTED`).
- `npm audit` for the full root graph and mobile production graph: 0 known vulnerabilities.
- Secret scan of the worktree and exact sensitive-value prefixes in all Git history: no match.

## Residual risks and operating rules

1. A named Tunnel is a public HTTPS entry point. Do not treat an obscure hostname as authentication; keep PIN/device-token controls enabled and review/revoke old devices.
2. DPAPI protects data at rest from other Windows accounts, not malware or an attacker already running as the same user/administrator. The connector token also exists briefly in the cloudflared child environment while connected.
3. Do not paste a Tunnel token into chat, logs, screenshots or issue trackers. Rotate it in Cloudflare after any suspected exposure.
4. Cloudflare Access browser login is not enabled in this release because native Android/WebSocket clients do not yet complete its OAuth/service-token flow. Adding an Access policy without a compatible client would break mobile connectivity.
5. The app's direct transfer ceiling is 2GB, but a Cloudflare plan can impose a smaller request-body limit. Large files should use Tailscale/direct transport until resumable chunk upload is implemented.
6. Keep Cloudflare, Windows, Electron and Android updated. Dependency audit cannot detect a future zero-day or a compromised local account.
7. The Windows installer has verified 0.3.2 metadata and a published SHA-256 checksum but is not Authenticode-signed because no public-trust code-signing certificate is configured. Windows SmartScreen may warn; verify the checksum before running it.

## Recommended Cloudflare configuration

- Create one Tunnel per PC and one narrow public hostname per connector.
- Route only to the displayed loopback Agent origin; never `localhost` services by wildcard and never a LAN subnet.
- Disable the public hostname or revoke the connector token when the PC is retired.
- Keep Cloudflare analytics/log retention minimal for personal use and never add Mr.Robot device tokens as query parameters.
- Use the plugin's external connection test after hostname or Tunnel changes.

Cloudflare references: [Tunnel overview](https://developers.cloudflare.com/tunnel/), [Tunnel setup](https://developers.cloudflare.com/tunnel/setup/), [Quick Tunnel limitations](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/).
