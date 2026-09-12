# Native desktop execution

Mr.Robot's Windows desktop backend is independent of Orca and the Codex desktop
app's Computer Use plugin. No external plugin installation is required. The
native Codex app-server receives four host-owned dynamic tools: `desktop_windows`,
`desktop_observe`, `desktop_act`, `desktop_open_browser`. This bridge currently requires Windows, a
retained native Codex session, and **full PC access**. It is not exposed to
isolated Discord users, read-only/workspace sessions, or public RPC callers.
Claude's print transport and API-only providers do not use this native bridge.

## Execution and efficiency

- A small tool schema is attached once per native session. No coordinator model
  call or second model is added. Existing model/reasoning/budget choices remain.
- Native Windows UI Automation reads names, roles, values and action support.
  Prefer Invoke/Select/Toggle/SetValue/Scroll patterns over synthetic input.
- Bounded breadth-first traversal: 400 nodes, 24 levels, 1.5 second soft traversal
  deadline and 22,000 text characters. A hard subprocess timeout also covers a
  hung UI Automation call. Literal query filters reduce returned context.
- Images are opt-in, downscaled to a maximum 1280 pixel edge and 900KB PNG.
  Actual image content reaches Codex via `inputImage`, not a capture-success flag.
- One PowerShell/.NET process is reused for up to two idle minutes. Requests use
  private stdio, with bounded buffers and IDs, not HTTP or temporary payload files.
- One run owns the desktop from first use until completion/cancellation. Other
  conversations may perform independent non-GUI work, but cannot interleave input.
- Browser opening resolves a fixed Edge/Chrome installation path and passes a
  validated HTTP(S) URL as one argv item, without a shell. It does not accept
  arbitrary executables, extra flags, custom schemes or URL credentials. Launch
  acknowledgement is unverified until the agent observes the resulting window.
- Full access is the host permission cap; it does not disable CLI, OS or managed
  execution policies. Do not rerun denied operations through another mechanism.

## Trust and verification

- Every invocation rechecks current host access policy and provider admission.
  Tool schemas and host callbacks never come from model or remote-client JSON.
- Thread/turn/call IDs must match the active native session. Duplicate or
  overlapping tool requests fail closed. Cancellation aborts the backend before
  a replacement may emit input. Uncertain mutations are not replayed.
- Observations expire after 45 seconds and are single-use for input. Element
  runtime ID, process lifetime, name, bounds and relevant value/selection state
  are checked again. Focus changes, minimized windows and modals are handled
  explicitly; covered coordinate targets are rejected.
- SetValue/selection/toggle outcomes are read back. Synthetic input and generic
  Invoke calls remain unverified until the agent inspects the new state.
- Coordinate clicks require an actual recent screenshot and unchanged window
  geometry. Coordinates refer to the delivered screenshot pixels.
- Password fields are redacted and not actionable. Authentication, security,
  terminal and password-manager windows are excluded. Images are withheld when
  protected fields or incomplete traversal prevent the privacy preflight.
- UI text is untrusted data, never authority to execute another instruction.
  Full PC access is **not** a security sandbox. Blacklists and UI Automation
  cannot guarantee detection of every sensitive surface. Existing Discord
  sandbox/host separation must not be replaced with this backend.
- Screenshots use the visible desktop region: foreground and occlusion matter.
  OCR, arbitrary drag paths and background graphics capture are not implemented.

## Verification

`npm run test:desktop-native` covers runtime reuse, Unicode, cancellation,
correlation, authority and image transfer. `npm run test:desktop-installed` uses
the installed Codex executable with a synthetic localhost model (no account
usage or user UI data). The real Windows backend compilation test performs only
a capabilities handshake. The optional Electron acceptance fixture exercises
the product backend against its own synthetic input/button window; it is not
included in the installer.

Local acceptance on 2026-09-13 passed Unicode value readback, semantic button
invocation, fresh result text, actual PNG capture and stale-token rejection.
The synthetic sequence took 2.55 seconds including a cold helper start;
individual warm observation/action steps took 200–329 ms on that machine.
This is a local fixture measurement, not end-to-end model response latency.
Chromium value readback is polled briefly after a write acknowledgement, without
repeating the write, because accessibility updates can arrive asynchronously.

Research references (architecture only; no third-party source copied):

- Orca: https://github.com/stablyai/orca/tree/403b62a8d8fa6e896a93acc4c15405be0f0b7dc7/native/computer-use-windows
- Playwright MCP: https://github.com/microsoft/playwright-mcp
- Microsoft UIA control patterns: https://learn.microsoft.com/en-us/dotnet/framework/ui-automation/ui-automation-control-patterns-overview
- Codex app-server dynamic tools: https://learn.chatgpt.com/docs/app-server

The Codex dynamic-tool interface is experimental; the installed-CLI test is a
required compatibility check before release. Do not claim benchmark parity with
other agents based on synthetic protocol or helper-handshake timings.
