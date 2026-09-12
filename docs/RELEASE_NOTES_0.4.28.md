# Mr.Robot 0.4.28

- Windows native desktop tools connected to retained Codex sessions: inspect
  windows, observe UI elements/images, act, and recheck the resulting state.
- Real screenshot image delivery; compact/filterable UI trees and opt-in images.
- Persistent desktop helper, bounded traversal/payloads, run-scoped input lease.
- Semantic actions and guarded screenshot-based click fallback; readback of
  editable values and selection/toggle state; explicit unverified results.
- Live full-access checks, cross-ticket separation, stale-reference protection,
  cancellation and no automatic replay of uncertain input.
- Packaged standalone backend: Orca/Codex desktop plugins are not prerequisites.
- Native protocol, installed-CLI image transfer, lifecycle and regression tests.

Scope: Windows native Codex full-access sessions. This release does not add a
Claude print-CLI desktop bridge, OCR, or a new mobile APK. Paired mobile clients
using an authorized PC session benefit from the updated host implementation.
Existing model, reasoning and token-budget settings are not lowered or reset.
