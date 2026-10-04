# Desktop executable identity

The executable is now `V.E.R.A.exe`; display name, installer name and managed shortcuts are `V.E.R.A`. The prior `Mr.Robot.exe` is recognized by diagnostics and by the installer exit guard for an in-place upgrade.

The compatibility identities remain unchanged:

- Electron Builder app ID: `com.polaris.mrrobot` (same NSIS installation/uninstall identity).
- Existing installation location: reused through the existing NSIS registry entry; the directory need not be renamed.
- Electron profile: `mr-robot-desktop`; an explicit diagnostic `--user-data-dir` remains isolated.
- Login item name: `electron.app.Mr.Robot`. Packaged startup writes the user's existing preference with `process.execPath`, updating the existing entry to the new executable rather than creating a second entry.
- Pairing protocol, IPC, encrypted-storage formats and saved conversation text are unchanged.

The installer/uninstaller refuses to proceed while either executable basename is running. It does not force-kill the app or an agent task. A process-query failure also stops installation; an unrelated installation with the same basename may conservatively block the operation. The NSIS plugin's documented `603` result means no process matched: <https://nsis.sourceforge.io/NsProcess_plugin>.

Electron Builder's existing NSIS upgrade flow invokes the old uninstaller while retaining application data and recreates managed shortcuts for the new executable. This does not guarantee migration of user-created external shortcuts or pinned taskbar entries; those may need to be recreated. No automatic updater is introduced.

Before release, verify a real in-place upgrade after explicitly finishing/stopping active tasks and quitting through the tray menu: one uninstall entry, new executable and shortcut targets, same profile/settings/conversations, expected login preference, and no surviving legacy process. Source tests are not a substitute for this installation acceptance check.

## Identifying a stale client

The profile menu reports the renderer package version and a deterministic 12-character public-source fingerprint. This identifies the web client, not the backend, installer signature, or a reproducible binary build. Private runtime data and machine paths are excluded. Compare this identity after a restart when reporting mismatched labels.

HTML responses use `Cache-Control: no-store, max-age=0`, while missing client assets return `404` rather than the SPA HTML page. A currently open old renderer is not forcibly reloaded during an agent task. These changes prevent ambiguous cache/fallback behavior; they do not prove the cause of any earlier screenshot discrepancy.
