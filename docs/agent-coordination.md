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

`npm run test:coordination` exercises real host execution paths with fake providers/app-server processes. It covers model inheritance, context separation, path/tool denial, budget admission, cursor/progress deduplication, cancellation/draining, transcript transactions/paging, context budgets and MCP lifecycle/output bounds. Separate native-desktop and text-pool tests retain authorization and session-reuse checks. The UI preview uses fixture-only data and no AI calls.

These checks demonstrate behavior and invariants, not a measured production-model speedup. Real latency depends on the selected model, reasoning level, account limits and task. No claim of universal peak performance is made.

Protocol reference consulted: [OpenAI Codex app-server](https://learn.chatgpt.com/docs/app-server). Existing provider session isolation and correlation remain authoritative; no credential or native session ID is accepted from model tool arguments.
