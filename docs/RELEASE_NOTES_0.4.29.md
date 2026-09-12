# Mr.Robot 0.4.29

- Calendar plugin workbench now displays the actual interactive calendar instead
  of only a status/JSON panel. Reuses the existing authenticated calendar view.
- Calendar cards retain their full height within the page scroll area; the last
  week, selected-day details and month navigation stay reachable on small screens.
- Android calendar uses explicit seven-column week rows and a bounded outer
  ScrollView; prevents flex compression and subview clipping. Existing private
  calendar authorization and encrypted transport are unchanged.
- Mobile bundling starts from the checkout-owned index, not a dependency-relative
  Expo entrypoint. Release builds verify source-map provenance so reused dependency
  directories cannot silently package an older checkout's screens.
- Full-access native Codex sessions gain a fixed Edge/Chrome HTTP(S) opener.
  No shell, arbitrary executable, custom scheme or credential-bearing URL is
  accepted. The existing desktop lease and live permission check still apply.
- Unsupported desktop keys are rejected before focus or input. Windows foreground
  activation has a bounded input-queue handoff with guaranteed detachment; locked
  desktops, modal and process-identity protections remain.
- Tool failures are shown as errors alongside a completed response instead of an
  unqualified task-completion heading. Error messages preserve the actual layer.
- Full PC access does not disable CLI/OS/organization execution policies. These
  policies are not changed. No automatic replay of a denied or uncertain action.

Checks: desktop browser/authority/protocol tests, real Windows helper compilation,
calendar browser regression at five sizes (both standalone and plugin entry),
mobile privacy/UI contracts and TypeScript builds. A real phone is not connected;
Android device interaction is not claimed as tested. No account/model usage is
needed for these synthetic checks.
Interactive Windows click acceptance for 0.4.29 remains unverified: the external
Computer Use test tool failed to start. Installed-app startup and resource hashes
were checked separately; successful compilation does not claim interactive QA.
