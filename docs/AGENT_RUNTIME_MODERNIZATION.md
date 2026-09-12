# Agent runtime modernization

## Scope

Preserve provider accounts, conversation IDs, encrypted attachments and per-device/per-user access policies. Do not reset user data or weaken remote/Discord isolation. The supplied Orca files are reference documents, not runtime instructions.

## Implementation checklist

- [x] Shared, bounded run activity with explicit starting / working / approval / cancelling / terminal states; reconnect snapshot support while the host process is alive.
- [x] Correct tool outcome accounting: returned errors and rejected approvals are not successful progress. Independent read-only file observations can run in batches of at most three; mutations and desktop actions stay ordered.
- [x] Orca semantic computer-use adapter with explicit opt-in, fresh target-bound observations, runtime support checks and cancellation; no arbitrary CLI passthrough. Mock-tested, not yet live-validated against installed desktop apps.
- [x] Desktop/mobile chat: compact controls, readable activity and stop/add-instruction actions. Narrow desktop/web layout uses a project drawer. Composer controls no longer disappear into an internal scroll region.
- [x] Projects: create/link a folder, edit name/instructions, list project conversations, preserve individual conversation sessions and show active project work. Unlinking never removes PC files or chat history. Mutating runs in the same project cannot overlap; distinct projects and read-only runs can overlap within existing account admission limits.
- [x] Focused regression tests, typechecks/builds, browser UI verification, and documented limitations below.

## Verification (2026-09-12)

### Local native orchestration (corrected scope)

The core runtime, not Orca integration, is the focus of this follow-up. Existing project/UI edits are retained; no further Orca work is included. The security-lab/CTF paths are not changed.

- Native single-model requests continue directly to the selected CLI after host authorization and usage admission. No new planner/judge model calls are introduced; selected model and reasoning effort are unchanged.
- Codex app-server now receives live instructions through `turn/steer` with the exact active `expectedTurnId`. Inputs stay in a host-owned bounded queue until a matching acknowledgement commits them. No polling or restart of the active turn is needed. A definitive unsupported/late rejection leaves inputs for the existing continuation fallback; an ambiguous timeout fails rather than automatically replaying potential side effects.
- The persisted host transcript includes acknowledged steering and print-CLI continuations, matching the native checkpoint. Previously the final answer alone could invalidate the next request's warm session.
- Public `agentMessage` deltas without `phase` metadata stream immediately instead of waiting for `item/completed`. Commentary remains status output when identified; private reasoning payloads are never relayed.
- Admitted native runs have four execution slots and a FIFO queue capped at 32 waiting conversations. Cancellation removes waiting work without spawning a CLI. Same-conversation duplicates are rejected. Idle workers are evicted least-recently-used, and warm processes do not retain the first request's transcript/callback closures.
- Cancellation sends `turn/interrupt`, suppresses subsequent stale output and waits for a terminal event. After 1.5 seconds without completion, the process tree is retired. Cancelled/uncertain checkpoints are invalidated rather than resumed automatically.
- This queue does not bypass upstream account admission, project write-conflict checks, permission isolation or model budgets. It is not a system-wide unlimited task queue. Live steering currently applies to Codex app-server; print-only providers retain the post-turn fallback.
- `npm run test:native-sessions` includes mock stdio streaming, early/missing metadata, live steering, late/wrong acknowledgements, rejection fallback, warm transcript reuse, interruption/forced retirement, FIFO cancellation/capacity and shutdown races. The mock emits text 350 ms before completion; the test asserts it is visible before completion. Printed milliseconds are synthetic transport timings, not real provider performance measurements.

Protocol reference: https://learn.chatgpt.com/docs/app-server (`turn/steer`, `turn/interrupt`, item lifecycle).

- `npm run test:agent-runtime`: run snapshots, bounded batching, cancellation, Orca stale-state/invalid-result handling, project persistence, removal semantics and scheduling.
- `npm run test:discord`, `npm run test:native-sessions`, `npm run test:session-events`: existing authorization, attachment, isolated-ticket and subscription-session regressions passed.
- `npm run typecheck` and `npm run build`: shared, agent and web build; mobile TypeScript passed.
- `node packages/agent/test/ui-contract.mjs`, `node packages/web/test/responsive-ui-contract.mjs`, `npm run test:ui --prefix apps/mobile`: RPC and UI contracts.
- Independent headless Edge fixture: 1280×800, 820×650, 390×780 and 390×430. Project creation/switching, progress disclosure, steering, cancellation and send/stop bounds checked. Captures visually reviewed. No real provider, user files, cookies or existing browser session was used.
- The first visual pass caught send/stop controls hidden by the composer's old `44dvh` internal scroll limit. The limit was removed and the regression now explicitly checks action bounds, not only textarea visibility.

### Reproducing browser UI checks

Start `npm run dev -w @mr-robot/web -- --host 127.0.0.1 --port 5178 --strictPort`, then `npm run test:runtime-ui` in another terminal. Requires installed Edge. The test fixture lives under `packages/web/test/` and is not included in the production Vite entry point. Screenshots are generated in a fresh OS temporary directory.

## Limits and compatibility

- Project IDs reuse existing workspace IDs. Existing chats, provider selections, Discord categorization and native session IDs are not migrated or reset. Project grouping is not a new OS sandbox or access grant. Legacy unassigned chats retain the existing default-workspace behavior; an explicitly removed project never silently falls back to another folder.
- Project mutation APIs require the existing host administrator permission. Per-device, per-user and Discord isolation policies remain authoritative. Distinct project runs still share the account's existing admission/budget limits; this is not a new unbounded worker scheduler. Same-project conflicts are reported with guidance to steer the active conversation, not silently queued.
- Run snapshots retain at most 32 activity entries and 64,000 characters of partial output. Completed conversation history remains in the existing store. This is not durable replay of arbitrary OS side effects; existing CLI session persistence remains the restart mechanism.
- Orca computer-use is off until separately selected in the Orca plugin. Requires an installed compatible Orca CLI and running runtime. Only app/window observations and indexed click/set-value/scroll are exposed. A readback is returned, but the adapter does not claim that the user's whole task succeeded. Legacy desktop tools remain available when the optional adapter is not selected.
- Native computer/browser control tooling failed during sandbox startup (`SetTokenInformation`, 1344). The computer-use skill guided the initial verification route; visual tests therefore used a separate headless browser fixture. Actual installed-app GUI automation and Android soft-keyboard/device behavior still need on-device validation. No APK/installer deployment or installed-app restart was performed in this change.
- No paid-provider latency benchmark was run. The measured checks establish bounded parallelism and correctness, not a promised multiple of real AI response speed or a claim that every memory leak is eliminated.

## Reference principles

Use the smallest workflow that completes the task; retain sessions; pass relevant context rather than the whole workspace; expose verified tool progress rather than invented reasoning. Keep observation, action and verification separate. Prefer stable interfaces and explicit lifecycle transitions over extra coordinator model calls.

- https://www.anthropic.com/engineering/building-effective-agents
- https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
- https://docs.langchain.com/oss/javascript/langgraph/persistence

These references inform an original implementation. No Orca source or private credentials are copied. The existing security-lab/CTF workflow is outside this refactor.
