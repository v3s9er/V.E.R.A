# Mr.Robot 0.4.12

## Remote connection

- A WAF-blocked optional tool portal no longer shuts down an independently
  authenticated mobile/chat tunnel. Portal access stays disabled unless its own
  exact origin proof succeeds. Anonymous pairing/ticket exposure still fails closed.
- Portal admission is reset on stop, restart, failure and configuration replacement.
- Encrypted file requests include a public, non-authorizing protocol marker for
  legacy edge header-presence rules. The real PC device bearer remains encrypted;
  the marker alone cannot authenticate file operations or ordinary APIs.
- No Access bypass, public administrator credential, or paid Cloudflare feature is
  introduced. A fixed hostname still requires the host PC and connector to be running.

## Native Android keyboard

- Compact landscape composer keeps the cursor, model/access/reasoning selectors,
  attachment/options controls and send/steer/stop actions above the IME.
- Multiline input becomes internally scrollable at reduced height; the redundant
  heading/status rows collapse only in the short keyboard viewport.
- Added a credential-free native instrumentation fixture, isolated from release
  packaging. Android 36.1 emulator tests cover portrait/landscape, 150% fonts,
  repeated keyboard opening and active-task controls, with screenshot inspection.

## Boundaries

- File protection remains file-only AES-GCM, not app-wide E2EE or forward secrecy.
- User phone/OEM keyboard and camera behavior still require user-device confirmation.
- Existing Discord administrator policy and explicit `allow_ai` ticket role remain.
- Windows installer is not Authenticode signed; Android retains its existing
  signing identity. No credentials, pairing codes or private user content belong
  in the public release.
