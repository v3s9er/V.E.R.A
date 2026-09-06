# Mr.Robot 0.4.10 — compact chat and Discord model policy

## Desktop/mobile chat

- Desktop keeps model, access and reasoning in a single compact composer strip. PC selection, scenario and question budget are in the accessible More dialog. Secondary file/voice buttons use compact icons; steering/stop remain direct actions.
- Mobile removes duplicate mode, conversation and settings bars. A compact conversation header opens a scrollable settings/history sheet. Model/access/reasoning stay beside the composer even with the keyboard open. Folder, scenario, budget, pin/archive and recent conversations move into the sheet.
- Reduced nested borders and control height, consistent spacing, bounded model names and responsive sizing. Existing Android native resize/measured keyboard-overlap handling and iOS keyboard handling remain intact.

## Discord Agent 1.4.0

- PC access changes retain live registered-server Administrator checks, explicit full confirmation and the PC's global read-only ceiling. Added explicit slash checks and administrator-only labels. Existing administrator-only bot usage is unchanged; ordinary members have not been granted PC access.
- `/robot model-limit user:@member ceiling:sol` limits a user across this server's existing and future tickets. Other choices: spark, mini, luna, terra, astra, show, unlimited. Setting a policy while the target is running is rejected.
- Exact supported model order: gpt-5.3-codex-spark < gpt-5.4-mini < gpt-5.6-luna < gpt-5.6-terra < gpt-5.6-sol < gpt-6-astra. This is an app policy, not a cross-vendor benchmark. Unknown/other-vendor models fail closed for restricted users; unlimited removes the restriction.
- Host filters discovery and checks saved/default/direct model choices. Actual API/native provider calls are checked again. Discord cannot inherit PC-edited routing presets. Per-user policies persist privately and do not disappear when deleting a ticket. No policies are assigned to real users by this release.
- This is not a billing security sandbox against administrators, arbitrary PC commands, or independent model selection inside external native CLIs/plugins. Administrators can edit their own restrictions.

## Verification

Agent/Web/Mobile typechecks; UI/responsive/mobile contracts; Discord host, authority, tier/pre-call and session tests; 41 Python tests passed. Browser visual fixture renders the real desktop ChatView with a credential-free mocked client: 1100x800 and 390x780 checked, More dialog and preset-to-single-model selection exercised. Native Android keyboard/visual behavior still requires a phone or emulator check; no real-phone validation is claimed.

Built artifacts: `release/Mr.Robot-Setup-0.4.10-x64.exe` and `release/mobile/Mr.Robot-Mobile-0.4.10.apk` (Android versionCode 18). Windows installer is not Authenticode signed; APK uses the existing Android signing identity. No GitHub/Drive publication requested/performed in this change.

Earlier remote-tunnel verification failure remains separate and unresolved pending Cloudflare login. File-only encryption limitations from 0.4.9 still apply.

Artifact SHA-256:

Local installation verified: desktop 0.4.10.0 relaunched, installed ASAR matches
the final packaged ASAR, and installed Python bridge contains the model-limit
command. Discord standalone reconnected with Gateway ready and no active run.

- EXE: `08B60AE5303044857227A7C9DFA13C6F653F7EF67C4D4D0CE28DBD7F26E4A4CE`
- APK: `4934DE451CC5C9FF6ACEB58F4CF12FDDC8838ABE3C944809AE1AF3D5253343D5`
