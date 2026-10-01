# Mr.Robot 0.5: host-managed coordination

The main agent owns the user's conversation and final answer. On a complex task it can assign independent analysis/review to a helper, continue its own work, retrieve the result, and synthesize it. A simple question still needs only the main model. This is a host implementation, not a claim to reproduce private Codex internals or outperform every agent.

## Execution boundaries

- `agent_spawn` returns a host-generated ID immediately. The task and explicitly supplied context are separate from the main conversation. Provider/model/effort are inherited from the selected main model; model-provided arguments cannot change identity, authority, workspace, or token policy.
- `agent_message` queues a follow-up without restarting the current helper call. `agent_wait` waits at most 15 seconds; sequence cursors avoid returning old result bodies repeatedly. `agent_list` contains status, not a repeated transcript. `agent_cancel` only accepts a helper owned by this run.
- Each parent can have two simultaneous and six total helpers. A separate global three-slot FIFO admits workers. Each helper has at most four turns and eight read-tool rounds per turn, with a 120-second invocation timeout. Parent completion/cancellation aborts and drains remaining calls before releasing run admission.
- Helpers use isolated CLI text workers or the API tool loop, never the parent's native execution pool. Native parents cannot deadlock their children by occupying all native slots. Text-worker saturation now queues instead of failing immediately; queues are bounded and cancellable.
- Helpers may read/list the selected workspace through the host's canonical-path checks. They cannot run shell commands, write files, control the screen, inherit MCP servers, or recursively create agents. The main agent is the single writer and desktop controller. Multi-writer worktrees and arbitrary worker-model overrides are **not implemented** in this version.
- Ordinary isolated Discord users do not receive this new native/workspace capability. Their existing ticket and file boundaries remain unchanged.

## Budgets and accounting

API tool-loop parents settle a call before dispatching tools, so helpers use normal per-call admission and the selected finite/adaptive policy. Every invocation checks provider identity policy and global/principal in-flight admission. Usage is included once in the run total; worker counters are also shown in the run panel and stored in the private routing trace.

Native CLI calls currently reserve the entire remaining finite allowance. Consequently **native Codex helper delegation is enabled only when the user already selected unlimited/audit-only**. A finite native run stays a normal single native agent; the application never silently changes the policy. Audit-only still has queue, concurrency, time, output and repetition bounds. All helper prompts use the selected provider/account, so provider subscription limits or API charges still apply.

Only successful reads or the first delivery of a completed helper turn count as model-budget progress. Polling, stale cursors and failed reads do not create additional budget. A genuine timed wait is not treated as an unproductive tool loop, but immediate polling is still guarded.

## Context and tools

Task-first context packing preserves the current request before secondary handoffs. Output budgets include headers and omission markers, with valid UTF-8 boundaries. History sent to the model remains compact; browsing an old transcript page does not add that page to every model prompt.

MCP discovery sends server/tool summaries first and loads one requested schema on demand. Results are bounded and explicitly marked when truncated. Context7/Serena setup is opt-in; no external code is installed, credentials are not bundled, and no arbitrary server is enabled by this update. Native Codex can invoke the enabled host MCP discovery/call bridge at full permission. See [MCP setup](mcp-context7-serena.md).

## Conversation durability

Newly recorded original turns live in immutable, content-addressed chunks under the user's private `conversation-transcripts` store. `conversations.json` commits their reference only after chunk writes succeed. Prompt compaction no longer deletes these originals. Paging is authenticated, chronological and bounded; oversized display copies are labelled while archived bytes remain intact.

Legacy turns already discarded by older versions cannot be reconstructed. The UI reports that gap. Device sync still sends the bounded prompt snapshot, not the entire local archive; full cross-device archive replication is not part of this update. Local archive files are private runtime data and must not enter Git or release bundles.

## Verification

### 0.6.3: bounded vote/hybrid councils

Vote/hybrid deliberation no longer waits indefinitely for every candidate. Each analysis-only node has a deadline. After half the scheduled nodes (rounded up) return usable proposals, the host allows a short grace period for other proposals, then cancels outstanding candidates. This threshold is a latency policy, not proof of agreement or correctness. Empty responses and provider errors are not evidence. User cancellation and host budget failures remain fatal; they do not trigger retries or bypasses.

Default total-deliberation / per-node / post-threshold grace budgets are 45/30/5 seconds for economy, 75/60/10 for balanced, and 90/75/15 for quality/manual. The total budget includes agenda, internal rounds and cross-group discussion; later stages are skipped when it expires. Independent groups start concurrently. Earlier valid proposals survive a failed later round. The judge receives the latest evidence once, rather than the entire repeated meeting transcript. These are provisional responsiveness defaults, not benchmark-proven optimal values. A host-only override exists for testing; remote RPC/model input cannot set it.

The final judge independently checks partial evidence (or solves from the original request if none arrived). A native-capable judge in an authorized workspace now uses the same native sandbox/tool path as a single agent. Only the judge performs side effects; workers remain text-only, and ask-mode confirmation, Discord isolation, provider identity checks and per-call accounting are preserved. This improves final-tool parity; it does **not** make total compute or the internal harnesses identical between single and council execution.

Progress includes node identity, actual provider/model, completion/failure/deadline/cancellation status and elapsed milliseconds, without candidate text or raw provider errors. An adapter that ignores cancellation can no longer block the host indefinitely: its late result is ignored and its unknown usage retains the admission reservation. Built-in adapters still receive abort to interrupt/retire the real request; remote providers may continue billing work already accepted. The final verification turn remains governed by the normal caller deadline, not the council deliberation deadline.

`npm run test:coordination` exercises real host execution paths with fake providers/app-server processes. It covers model inheritance, context separation, path/tool denial, budget admission, cursor/progress deduplication, cancellation/draining, transcript transactions/paging, context budgets and MCP lifecycle/output bounds. Separate native-desktop and text-pool tests retain authorization and session-reuse checks. The UI preview uses fixture-only data and no AI calls.

These checks demonstrate behavior and invariants, not a measured production-model speedup. Real latency depends on the selected model, reasoning level, account limits and task. No claim of universal peak performance is made.

Protocol reference consulted: [OpenAI Codex app-server](https://learn.chatgpt.com/docs/app-server). Existing provider session isolation and correlation remain authoritative; no credential or native session ID is accepted from model tool arguments.
