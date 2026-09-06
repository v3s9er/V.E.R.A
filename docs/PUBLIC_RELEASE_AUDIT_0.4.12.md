# Public release audit — 0.4.12 (2026-09-06)

## Verified changes

- Full `npm test`, Agent/Web/Mobile typechecks and focused encrypted-file/Discord
  model-policy tests passed. New regressions distinguish optional portal denial
  from transport admission, reject exposed pairing even with a blocked portal,
  and prove the public file-format marker cannot authorize ordinary/file APIs.
- Android 36.1 emulator, actual Android IME: multiline insertion cursor and
  send/stop bounds, repeated open/close, portrait/landscape, 150% system fonts.
  Screenshots exposed a horizontal layout failure missed by the initial vertical
  assertion; fixed both the layout and test. This is not physical-device QA.
- Live named-domain probes: anonymous login redirect, authenticated ping/ticket,
  TLS WebSocket authentication and read-only RPC. Optional portal remains blocked.
  File-format marker reaches the encrypted origin endpoint only after Access;
  invalid/missing file keys are rejected by the origin. No physical phone transfer
  or Internet-wide availability guarantee is claimed.
- Existing Cloudflare domain is Free. No dashboard policy, Access bypass, service
  subscription, worker, storage product or billing option was changed in this fix.

## Public distribution review

- `audit-public-release.mjs` scans the staged source/current text and reachable Git
  text history; `audit-local-credentials.mjs` compares known local secret values
  and their encodings against source/history, desktop stage and decompressed APK.
  No detected credential matches. Actual credential values are never reported.
- No private Cloudflare/Discord configuration, pairing QR/PIN, signing key, private
  calendar/document, original security-bot source or character voice asset is added.
- Dependency versions are unchanged; direct licenses remain permissive and existing
  third-party notices are retained. No new copyright/license grant is invented.
- Android versionCode 20 uses the existing release certificate. Windows remains
  unsigned by Authenticode. Native test application ID/entry are separate from
  production and prohibited in release task graphs.

Scope limits from the previous audit remain: not an independent penetration test,
exhaustive legal clearance, decompilation of every historical binary, or proof of
zero unknown secrets. Previously disclosed credentials must be revoked separately.
File encryption is file-only and has no forward secrecy. Existing Discord policy
requires both administrator usage and explicitly assigned `allow_ai` for new tickets.
