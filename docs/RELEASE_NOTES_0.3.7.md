# Mr.Robot 0.3.7 — private work calendar and commute links

Mr.Robot 0.3.7 adds an encrypted personal work calendar to the existing calendar plugin without mixing workplace data into ordinary AI-visible events.

## Work calendar

- PC and mobile now show a true seven-column month calendar with Seoul-date navigation and today highlighting.
- A local administrator can import one matching row from a macro-free `.xlsx` workbook for a selected year. The importer opens one validated file descriptor with read-only access, bounds ZIP and XML resources, rejects macros/external links, never evaluates formulas, and never saves the workbook.
- Only derived dates, work status, destination labels, manual overrides, and optional addresses are retained. The workbook path and row/group identifiers are not persisted.
- Private state and NAVER credentials use a dedicated Windows DPAPI(CurrentUser) store at `~/.mr-robot/private/work-calendar/state.bin`; there is no plaintext fallback or ordinary cross-PC sync. Sensitive replacements also refresh the encrypted recovery copy so deleted credentials do not return after corruption recovery.
- Manual per-date overrides take precedence and can be removed to restore the Excel, weekend, or holiday value.
- Paired devices need a separately revocable `private-calendar` capability. Read-only devices can view but cannot edit. Change events carry only a revision and date range to authorized devices.

## Holidays and NAVER Maps

- Weekends and Korean public holidays are interpreted in `Asia/Seoul`. The 2026 table incorporates the published almanac, the local-election date, and the April 2026 public-holiday amendment adding Labor Day and Constitution Day.
- Home and work addresses are sent to the fixed NAVER Maps API host only after explicit consent. Internal workplace labels are replaced with generic route names, geocoding and the one-shot car distance/time response are not cached or persisted, and saved NAVER credentials can be explicitly deleted from the PC UI.
- Public-transit and walking actions open NAVER Map routes. On Windows, a missing `nmap://` handler falls back to the strictly validated `https://map.naver.com` directions page. A separately disabled or failed car Directions API no longer blocks the transit, walking, or car route links. NAVER's public REST API does not provide detailed bus/subway/walking itineraries, so Mr.Robot does not scrape or impersonate a private endpoint.

## Security and regression fixes

- Private-calendar presence and import time are no longer exposed through the generic calendar status RPC.
- XLSX validation and reading share one read-only descriptor, closing the path-replacement/size-check race.
- Desktop, web, and mobile external navigation accept only bounded `nmap://route/public|walk|car` links with the exact reviewed coordinate/name/app contract. The desktop fallback additionally enforces the exact NAVER HTTPS origin and generated directions path; arbitrary protocols, hosts, credentials, ports, query keys, and duplicate values remain blocked.
- General mobile calendar events and scheduler controls remain available with their existing authorization rules, while all mutation failures are handled in the UI.
- Revoking a device capability or losing authentication immediately removes its rendered private month, address, route result, and edit state; late responses from the old connection cannot restore them.
- Reimporting or removing an override prunes unreferenced saved workplace addresses, malformed XLSX controls are rejected, and filesystem failures cannot echo a private workbook path into the administrator UI.
- Repository ignore rules block spreadsheet, private-key, and private-calendar artifacts by default.

## Version alignment

- Desktop, agent, web, shared packages, mobile package, and Android versionName are `0.3.7`.
- Android versionCode is `12`, minSdk is 24, and targetSdk is 36.
- The calendar plugin is `0.3.7`; other built-in plugins retain their independently versioned release lines until changed.

## Verification

- Shared, agent, web, and mobile typechecks, production build, security suites, and read-only synthetic/production-schema XLSX parser checks pass.
- The locally downloaded read-only source copy's SHA-256, length, and last-write timestamp were identical before and after parser validation and encrypted import. No workbook content or identifier is included in this repository.
- The Windows x64 installer was packaged at 97,909,785 bytes. Its SHA-256 is recorded in `release/SHA256SUMS-0.3.7.txt`; Authenticode is not configured.

## Android packaging status

The Android 0.3.7 source and versionCode 12 configuration are complete and typechecked. An update-compatible APK was intentionally not produced on this workstation because the preserved 0.3.x release signing key is unavailable here; the build refused to create or substitute a different identity. Recover the official key before packaging `Mr.Robot-Mobile-0.3.7.apk`. The Windows installer remains unsigned and may trigger SmartScreen; compare it with the repository SHA-256 file before running it.
