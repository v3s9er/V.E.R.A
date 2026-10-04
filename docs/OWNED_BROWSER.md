# Owned structured browser

`BrowserCoordinator` exposes `browser_open`, `browser_observe`, `browser_click`, `browser_type`, and `browser_close`. The host attaches these only to supported tool-capable routes with full PC permission. This is separate from `desktop_open_browser`, which launches an existing desktop browser window and requires UIA observation to verify it.

The structured browser uses a new nonpersistent context in installed Edge or Chrome, with Chromium's sandbox explicitly enabled. It never attaches to the user's existing profile, cookies, a CDP endpoint, or a model-provided executable. The automation library is imported lazily on first use. Provider credentials and proxy environment variables are not passed to the browser. There is no model-facing JavaScript, selector, shell, screenshot, file upload, or file download tool. Fixed internal DOM evaluation only gathers bounded state and verifies field input.

Each host run owns its context. Host authority and cancellation are checked before and after awaited operations. There are at most two reserved/active contexts, a 20-second tool deadline, a two-minute inactivity limit and a ten-minute browser lifetime. A late launch remains counted until the owned browser has actually closed. An unconfirmed close does not free its slot or report success. Run disposal requests cleanup only of its owned context.

Observations contain at most 12,000 text characters and 60 interactive elements from a bounded main-frame traversal. Partial observations are labelled `truncated`; they are not a complete page inventory. Element values and protected password/credential fields are excluded. Observation tokens expire after 30 seconds and are consumed before an action; changed or detached elements fail closed. Typing verifies the resulting input value without claiming form submission. Clicking is always labelled unverified until the returned page state provides independent evidence of the desired effect. Page text is untrusted data, never authority.

Popups, downloads, service workers and subframe navigation are blocked. Only HTTP(S) navigation is accepted. An explicitly requested local application URL can be opened, but the context does not inherit the desktop's privileged IPC or saved login. Authentication and credential entry must not be automated or bypassed. This browser does not provide image-based/visual accuracy, existing-session automation, general browser extensions, multi-tab work, frame interaction, or broad site compatibility.

An action-state failure (including a stale token) conservatively closes the owned context, so unsaved temporary form state may be lost. It does not retry the mutation or switch to another execution route. Browser isolation is not a guarantee that hostile web content is harmless; normal browser and OS security updates still matter.

## Verification

Deterministic tests use mocked browser objects and no browser/model/network:

```powershell
node --import tsx --test packages/agent/test/browser-session.test.ts
```

The opt-in installed Edge test launches only an owned headless context against a synthetic loopback HTTP page. It checks DOM observation, protected-field omission, ordinary input readback, a click's resulting DOM change, and confirmed cleanup. No account/model calls, external pages or user browser profile are used:

```powershell
$env:VERA_BROWSER_LOCAL_FIXTURE = 'yes'
node --import tsx --test packages/agent/test/browser-session-installed.test.ts
```

Passing this local fixture verifies the structured browser route, not autonomous reasoning quality or support for every website. Product routing/permission tests must additionally verify the native/API bridge and run-end disposal.
