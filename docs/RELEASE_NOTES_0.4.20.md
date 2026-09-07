# 0.4.20 — Conversation-scoped native sessions

## Execution

- PC, mobile and administrator Discord Codex requests with a selected workspace now share the same conversation-scoped app-server adapter instead of starting an ephemeral `codex exec` task on every turn.
- Follow-ups send only new input and changed retained context. The provider retains earlier conversation/tool state. A host-verified transcript mismatch, changed provider/model/workspace/permission or different conversation creates a separate session.
- Up to four native workers stay warm, and idle workers close after five minutes. Local checkpoints allow exact-thread resume after idle eviction or app restart. They contain thread IDs, transcript hashes and usage counters, not credentials or duplicate conversation text. Checkpoints are bounded to 128 entries and seven days. Provider rollout retention remains governed by the user's Codex installation.
- Failed/cancelled turns invalidate the resume checkpoint; no uncertain side-effecting turn is automatically replayed. Failed resume before a turn starts can recover from Mr.Robot history.
- Usage accounting subtracts prior cumulative totals, including after resume. User-selected model and reasoning effort are preserved.
- Codex chat without a selected workspace uses the existing bounded text-only worker pool. Restricted Discord remains on the separate broker-only path: this update does not grant native host access to ordinary users.
- Conversation/status questions no longer receive unconditional coding-task instructions. Attachment inventories no longer tell the model to re-read originals on every follow-up.

## Progress

- Public task status, native tool activity and final-answer streaming are surfaced without exposing private reasoning.
- Native and Discord progress have periodic elapsed-time updates. Discord coalesces in-flight updates to the latest state instead of dropping them; update failures log only the exception type.

## Verification

- Synthetic process tests cover warm reuse, persisted resume, incremental input, usage deltas, identity/authority/history invalidation, approval rejection and cancellation.
- Installed Codex integration test uses a localhost synthetic Responses server and a temporary CLI home, not a paid model/account. Verifies three turns including process restart, retained conversation, high reasoning and per-turn usage. This is transport overhead testing, not a production model latency guarantee.
- Python Discord delivery test verifies latest-progress coalescing and cleanup. Existing authorization, attachment, sandbox, provider security and orchestration regression suites are retained.

The mobile client protocol is unchanged; existing APKs receive the improved execution through their connected updated PC. Claude and API providers retain their existing transport; shared intent/attachment instructions also improve those paths.

Reference: [Official Codex app-server lifecycle and thread resume](https://learn.chatgpt.com/docs/app-server).
