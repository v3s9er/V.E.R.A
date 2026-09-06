# Mr.Robot 0.4.11

Includes the standalone Discord integration, file-only encrypted transfers and
compact desktop/mobile composer improvements documented in 0.4.8–0.4.10.

## Discord Agent 1.4.1

- New tickets require an explicitly assigned role named exactly `allow_ai`.
- Live checks before the form, thread creation and host registration; missing,
  removed or renamed roles fail closed. Failed registration removes the newly
  created incomplete thread. Client parameters cannot override authority fields.
- The bot never creates/grants the role. Server owners/admins also need it for
  new tickets. Existing tickets are preserved.
- Existing Administrator-only bot usage remains in place. This release does not
  grant ordinary role members PC access. PC permission/model-limit management
  remains administrator-only; per-user model ceilings persist across tickets.

## Distribution boundaries

- No runtime credentials, pairing QR/PIN, private configuration, signing keys,
  original security-bot source or user documents belong in the public repository.
- File encryption is file-only, not app-wide E2EE, and has no forward secrecy.
- The Windows installer is not Authenticode signed. Android signing private
  material remains local; the APK necessarily contains the public certificate.
- Native Android keyboard behavior still needs device verification. An existing
  remote tunnel problem is not resolved by this release; Access stays enabled.
- Root application source currently has no general open-source license grant;
  third-party components retain their respective licenses/notices. Publication
  does not imply ownership of their copyrights or a comprehensive legal audit.

## Verification

Full `npm test`, 47 Python tests, all platform typechecks and focused encrypted
file/model-policy tests passed. Public source/history and exact local-credential
audits passed; details in PUBLIC_RELEASE_AUDIT_0.4.11.md.

PC 0.4.11 is installed and relaunched. Installed ASAR matches the verified
installer payload; independent Discord client reconnected ready, not busy.
EXE/APK checksums are in release/SHA256SUMS-0.4.11.txt.
