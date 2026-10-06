# Native-first execution and work ontology

V.E.R.A keeps one default coordinator: the selected subscription agent. The host supplies permission boundaries, run ownership, cancellation, scoped knowledge, objective receipts and UI state. It does not insert a second LLM planning or voting pass into ordinary native requests.

## Execution ownership

- A simple conversational turn remains on the existing tool-free path with the same selected model. Adaptive effort can be lower without changing the saved preference.
- Eligible default Codex native runs may use the CLI's built-in helpers. The host does not simultaneously expose its own `agent_*` helper tree. Eligibility requires a non-isolated local run, a persistent native session, `audit-only` accounting and helper mode enabled.
- Explicit multi-model adaptive/council/pipeline presets retain their existing behavior. They are opt-in configurations, not silently replaced by the default. API execution retains its bounded host helper implementation.
- Discord stays on its administrator-assigned single model/effort path. Neither native delegation nor the new private work ledger is added to it. User assignments, tickets, provider credentials and stored conversations are not migrated.
- Native child model/effort defaults match the parent. These are **defaults, not an enforceable CLI allowlist**: an observed override aborts the run, but may already have started at the provider. This route is unsuitable for strict per-user model ceilings, and is not enabled for Discord.
- Child text and raw usage cannot become the parent's answer or accounting. Host dynamic tools belong only to the parent thread. Unknown/child requests are denied individually; ownership is established from correlated parent events. Delegated usage is marked incomplete when child coverage is unknown.
- Completion requires observed children to settle and the owned native process tree to retire. Every delegation-enabled run retires even if no child was observed, because absence of events does not prove absence of child work. Cancellation/failure also drains the owned process before releasing its run slot. The next request resumes the saved main conversation; this route trades process warm reuse for confirmed shutdown. Ordinary tool-free turns are unchanged.
- Current CLI `subAgentActivity` and legacy `collabAgentToolCall` records are correlated to the parent before granting child ownership. Raw spawn metadata is reduced to explicit model/effort overrides only; prompts and arguments are not retained. Resumed-thread raw observation is protocol-limited. All delegation-enabled usage is therefore marked incomplete through the final aggregate, even when parent token counters are positive.

## Two distinct ontologies

The existing knowledge ontology describes project entities and explicit relationships (`depends_on`, `part_of`, `owner`, etc.). It uses scoped saved claims and fresh manifest declarations, retains conflicting evidence, and does not infer permissions or verified runtime behavior. `knowledge_lookup` remains query-only and refreshes manifest evidence after changes.

The new **run-local work ontology** describes requested tasks, prerequisite edges, model-reported states and host-observed file receipts. It is not a replacement for project knowledge and does not automatically turn model output into stored facts.

| Host tool | Purpose | What it does not prove |
| --- | --- | --- |
| `work_plan` | Atomically declare up to 12 tasks, acyclic dependencies and up to 32 file checks | That the plan is complete or correct |
| `work_update` | Record planned/running/completed/blocked claims | That completed work was checked |
| `work_check` | Re-read the task and prerequisite files; test exists, literal contents or SHA-256 | That a test suite ran or that the whole answer is correct |
| `work_status` | Return bounded claims and actual check receipts | Permission, global truth or prior-run verification |

A completed task is marked verified only when it has explicit passing checks and verified prerequisites. A task without checks stays merely reported. Checks must reflect the user's acceptance criteria; choosing a convenient marker is not evidence of overall success.

The workspace root and each opened file are checked for scope and identity; reads are capped at 2 MiB per file, reject redirected/outside paths and do not execute code. Receipts return fixed failure codes and hashes, not raw file contents, titles or paths. Potential mutations invalidate receipts. Finalization rechecks only task roots explicitly checked in that run. There is no automatic replay, background planner or extra model call.

This ledger is intentionally **not persisted between runs**. Existing conversation/session persistence and crash-uncertainty metadata remain in charge of recovery. Historical tool results are not current verification. A fresh run must declare/check its relevant work again. This avoids silently reusing stale acceptance or turning a recovered task into permission to repeat a side effect.

## Presentation and evaluation

PC/web and mobile source show separate counts for model completion reports and declared-file verification, with stale/failed checks visible. Raw work-tool JSON and file content are not rendered as progress. Native helper activity is identified separately from V.E.R.A's host workers; no hidden reasoning is exposed.

`npm run test:work-orchestration` covers protocol ownership, cancellation, dependencies, false completion, stale evidence, repeated repair checks and evaluation grading. The `work-ontology` actual-app suite uses an isolated profile and renderer RPC, exact artifact hashes, observed tool events and host summaries. It is a small functional regression, **not an external competition score, proof of general accuracy gains or a comparison with standalone Codex/Claude Code**. Its prompts explicitly request the new tools, so successful use does not establish automatic adoption on arbitrary tasks.

The native wire interface was checked against installed Codex 0.159.3 and the official [app-server](https://learn.chatgpt.com/docs/app-server) and [subagent configuration](https://learn.chatgpt.com/docs/agent-configuration/subagents) documentation. ARTEX's queue/evidence separation was an architectural reference only; no ARTEX source or security-analysis integration is copied. V.E.R.A's existing MIT license and third-party notices remain unchanged.

### Development functional run — 2026-10-06

A V.E.R.A 0.7.9 development functional run completed on **2026-10-06, 04:15:21–04:18:55 UTC** with `gpt-6-sol`. Three synthetic cases ran twice each, and all **6/6 executions passed**. Both artifact cases used the default native route with actual `high` effort. The greeting used the same model's text route with actual `low` effort; the saved requested preference remained `high`. No routing preset was selected.

| Case | Passes | Observed route / effort | Completion, seconds | First text, seconds |
| --- | ---: | --- | ---: | ---: |
| Exact file creation | 2/2 | Native / high | 32.732–51.432 | 31.810–49.903 |
| Failed-check recovery with a requested dependency | 2/2 | Native / high | 53.901–54.682 | 51.280–52.201 |
| Short greeting | 2/2 | Text / low | 3.152–4.060 | 3.000–3.186 |

These are the two observed values' ranges, not population percentiles. Completion includes the application response and persistence/event/telemetry read-back; profile and fixture setup is excluded. Artifact hashes matched exactly. Recovery recorded a failed check before successful final verification; greetings emitted no work-tool or work-ledger observations. Native tool arguments remain private, so the application suite does not independently reconstruct the requested dependency graph or check definitions.

| Case | Reported input | Cached input, included in input | Reported output | Reported total |
| --- | ---: | ---: | ---: | ---: |
| Exact file creation, two runs | 237,799 | 177,408 | 1,694 | 239,493 |
| Recovery, two runs | 290,915 | 264,960 | 2,157 | 293,072 |
| Greeting, two runs | 7,038 | 0 | 14 | 7,052 |
| All six executions | 535,752 | 442,368 | 3,865 | 539,617 |

All six samples supplied positive aggregate usage reports. Input is cumulative provider-reported input, not unique prompt length; cached input is a subset and is not added again to total usage. These are reported token aggregates, not independently measured billing or a dollar-cost estimate. This run did not establish child-delegation behavior or complete delegated-token coverage.

**This run does not demonstrate a performance improvement.** There was no matched baseline, standalone-agent comparison or equal-compute comparison. Repetitions are not additional independent tasks, and the artifact prompts explicitly requested the work tools. The result supports these narrow functional checks only. This development snapshot preceded the final native-event and aggregate-usage corrections below.

### Final build checks — 2026-10-06

The final staged 0.7.9 application passed all three cases again through its renderer RPC: creation **45.228 s**, failed-check recovery **49.301 s**, and greeting **4.011 s**. The model, route, effort and exact-artifact gates were unchanged. Artifact-run total token coverage is now correctly **unknown**, not zero or a complete parent-only aggregate; the greeting reported 3,526 tokens. No cost or speed improvement is inferred from this single repetition.

A separate account-backed native transport check on Codex 0.159.3 with `gpt-6-sol/high` observed exactly one native helper spawn, a completed wait and the correct synthetic arithmetic result in **20.853 s**. Parent counters reported 31,054 tokens; full child usage remains unknown. The initial observation check failed because the CLI uses `subAgentActivity`; it was retained as a failure and corrected, not counted as successful delegation merely because the answer was correct. This is a transport integration check, not a difficult-task quality benchmark.

Regression coverage also checks that final file receipts occur after explicit host helpers settle, not before late cancellation side effects; failures stay visible in the UI even if the model already wrote a completion sentence. Work guidance avoids repeated status/check loops caused solely by conservative wrapper invalidation. This does not weaken mutation invalidation or remove the host's final fresh read.
