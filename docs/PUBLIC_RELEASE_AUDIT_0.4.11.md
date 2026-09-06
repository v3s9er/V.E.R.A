# Public release audit — 0.4.11 (2026-09-06)

## Scope and evidence

- Public source index/worktree and all reachable Git textual history scanned by
  `scripts/audit-public-release.mjs`: no detected credential/private-state findings.
  Added Discord bot-token detection. New source files are staged before scanning.
- Supplemental `scripts/audit-local-credentials.mjs` compared 9 local credential
  values (including 3 DPAPI-decoded payloads), their UTF-8/UTF-16/base64 forms with
  the index, history, desktop stage and decompressed APK. No matches. Values are
  never printed. Short PINs and unknown credentials remain outside exact matching;
  the format scanner separately detects labelled pairing codes.
- Final desktop ASAR is version 0.4.11; its 57 archive entries contain no forbidden
  runtime/credential paths. Extracted installer ASAR equals packaged ASAR by
  SHA-256. Generic Python plugin modules are unpacked; no security-bot code/config
  or installed Python environment is included.
- APK Android versionCode is 19. Existing signing identity verified by build
  script; private signing material is not distributed. Windows is **not**
  Authenticode signed. Public certificates/hashes are not secret signing keys.
- `npm audit --omit=dev --json`: root and mobile production dependency findings
  both zero on this audit date. This is registry coverage, not proof of absence.
- Agent/Web/Mobile typechecks, Discord Python tests (47), host/session/model-policy
  tests and secure-file crypto/HTTP tests pass. Obsolete fixed Android version and
  old plaintext-transfer structural assertions were updated to the current
  synchronized version/encrypted client, retaining redirect rejection checks.
- Desktop 1100/390px fixture checks from 0.4.10 remain applicable. No native phone
  keyboard/camera/remote connectivity verification is claimed.

## Copyright and redistribution review

- 640 dependency records with installed legal notices regenerated deterministically
  in `THIRD_PARTY_NOTICES.txt` and included by desktop/mobile packaging.
- Direct runtime npm dependencies inspected: permissive MIT/Apache/BSD/ISC family.
  Copyleft inventory flags Sharp's development-only libvips binaries; the application
  bundle does not redistribute those binaries. Generated brand images derive from
  the repository's SVG generator, not downloaded TV/character artwork.
- No audio recordings, cloned-character voice assets, voice-model weights, private
  work calendars/documents or original security-bot source are tracked for release.
- Python/discord.py are installed externally, not copied into this installer. Its
  upstream [MIT license](https://github.com/Rapptz/discord.py/blob/master/LICENSE)
  and copyright remain with the original authors. Runtime-downloaded tools/models
  retain their separate terms; this release does not grant rights to them.
- The root application has no general open-source license grant. None is invented
  during this audit. Third-party copyright notices are not removed to make the
  contributor list appear exclusive. No assistant co-author is added to commits.

This is a scoped engineering review, not exhaustive provenance investigation,
legal clearance, independent penetration testing or a guarantee of no secrets.
Old binary releases are not retrospectively decompiled by this audit. If any
credential has been disclosed elsewhere, excluding it here does not revoke it.

## Remaining product boundaries

`allow_ai` is required in addition to the existing administrator-only bot policy;
ordinary members have not been granted PC access. File encryption is file-only,
not app-wide E2EE, and lacks forward secrecy. Existing remote-tunnel verification
failure remains unresolved; Cloudflare Access has not been bypassed or disabled.
