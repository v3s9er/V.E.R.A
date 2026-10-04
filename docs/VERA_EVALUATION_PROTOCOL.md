# V.E.R.A actual-application evaluation

`scripts/app-benchmark.ts` runs the real desktop bundle through Electron's renderer
and authenticated native local RPC `chat.start`. It never constructs a substitute
AgentLoop or calls the provider directly. A fresh application home, desktop profile,
project and conversation isolate each evaluation from the user's app data. Codex
uses its own existing sign-in; the harness copies no credentials or user provider
configuration. Only the exact requested model is configured and catalog-checked.

The stage directory is the preferred input. An installed executable path identifies
its adjacent `resources/app.asar`; development Electron loads that real archive
with a new profile, rather than opening the installed executable and its shared
single-instance profile. The report identifies this shell difference. This tests
the actual bundled agent and RPC path, not installer or operating-system lifecycle.

## Planning and execution

Run from the repository root with existing dependencies and `build:shared` ready.
The stage must already be built and frozen by the release coordinator. The harness
does not install dependencies, rebuild, publish, or change the normal app settings.

```powershell
# No model inference, app launch, or account discovery. Writes a new immutable plan.
node --import tsx scripts/app-benchmark.ts --app-path packages/desktop/.stage --expected-version 0.7.0 --suite aime --cache release/validation/aime-pinned.json --year 2022 --model gpt-6-sol --effort high --arms single,adaptive --repetitions 2 --timeout-ms 300000 --token-policy audit-only --out-prefix release/validation/vera-aime-plan-001 --plan-only yes

# After the coordinator freezes the build and authorizes the measurement window:
# Replace PLAN_HASH with the exact hash printed above. Use a NEW output prefix.
node --import tsx scripts/app-benchmark.ts --app-path packages/desktop/.stage --expected-version 0.7.0 --suite aime --cache release/validation/aime-pinned.json --year 2022 --model gpt-6-sol --effort high --arms single,adaptive --repetitions 2 --timeout-ms 300000 --token-policy audit-only --out-prefix release/validation/vera-aime-run-001 --plan-hash PLAN_HASH --allow-account-usage yes

# Independent synthetic ontology treatment: 6 cases x 3 arms x 2 repetitions.
node --import tsx scripts/app-benchmark.ts --app-path packages/desktop/.stage --expected-version 0.7.0 --suite relations --seed vera-relations-001 --model gpt-6-sol --effort high --arms single,adaptive,ontology-adaptive --repetitions 2 --timeout-ms 180000 --out-prefix release/validation/vera-relations-plan-001 --plan-only yes

# Primary-data preparation only: select six IDs BEFORE downloading their grids.
# Reads identifier fields from prior validation JSON; downloads no executable code.
node --import tsx scripts/benchmark-arc-data.ts --out-cache release/validation/arc2-vera-unused-001.json --reports-dir release/validation --selection locally-unused --seed vera-arc2-070-unused-v1 --count 6

# ARC text grids: 6 tasks x 2 arms x 2 repetitions = 24 actual-app calls.
node --import tsx scripts/app-benchmark.ts --app-path packages/desktop/.stage --expected-version 0.7.0 --suite arc2 --cache release/validation/arc2-vera-unused-001.json --arc-selection locally-unused --model gpt-6-sol --effort high --arms single,adaptive --repetitions 2 --timeout-ms 600000 --out-prefix release/validation/vera-arc2-plan-001 --plan-only yes

# Non-inference validation of the harness:
node --import tsx --test scripts/tests/app-benchmark*.test.ts
```

Use the actual frozen version for `--expected-version`; do not change a version
check to disguise a different app. Full AIME is 30 cases per year, so the first
command plans 120 calls. A smaller explicitly selected `--ids` set can be used for
initial development smoke tests, but is labelled `explicit-development-subset` and
cannot be reported as the complete year or unseen holdout. `--cli` selects an
existing Codex CLI path when the normal `codex` command is unavailable.

Plan, manifest, progress and report files use exclusive creation. Existing evidence
is never overwritten. `--plan-hash` binds the dataset, task hashes, app and selected
executed harness source hashes, model, effort, arms, schedule, permissions and deadlines. Changing
the output prefix or execution consent does not change the plan. App runtime and
executed harness source hashes are rechecked before every case and after the last
case. Freeze the selected app artifact and harness imports while a run is active.
The separate `checkoutReferenceHashes` are informational: agent/server/ontology
source in the checkout is not executed when the benchmark loads a frozen bundle,
and the harness does not assert that this snapshot produced an older installed
artifact. This permits candidate development while a frozen baseline is measured.
Retain a release build manifest to associate candidate source with its build.
No inference starts in plan mode.
`--preflight-only yes` additionally launches the isolated app and checks version,
profile isolation, exact catalog availability and graph models, then closes it
without calling `chat.start`. It also requires a fresh output prefix.
The isolated configuration explicitly allows workspace execution only beneath its
own temporary scratch root. Preflight checks both the effective settings and a
generated conversation's permission after the server applies its safety cap; every
measured conversation is checked again. An unexpected approval request cancels only
that owned run and is reported as `approval_required`, not a wrong answer.

## Task inputs, model identity and tools

AIME uses the existing SHA-256-pinned AI-MO cache and strict `Answer: N` grader.
Reference answers remain in the controlling evaluation process; they are never
sent in a model request, model workspace, ontology fact or report. Native product
tools remain available for bounded local calculations. Instructions exclude the
network, external files, other conversations and answer-key lookup. This is a
product-permission experiment, not an OS sandbox or proof that public tasks were
absent from model pretraining. The full dataset provenance is documented in
`competition-evaluation.md`.

Every arm has the same selected model, fixed reasoning effort, task text, normal
native tools, workspace permission, token policy and wall deadline. Single and
adaptive use separately pinned same-model graphs in the isolated application.
Adaptive may invoke zero helpers; that is an intended result, not a missing stage.
Comparative adaptive runs require `audit-only`: the current native product disables
helpers for finite token policies. The harness rejects that confound explicitly.
Final route, telemetry model, worker model events, streamed text and stored final
answer must agree. Native transport must actually be observed. A mismatch stops
the experiment instead of silently switching models or treating it as an answer.

AIME does not supply an ontology; `ontology-adaptive` is rejected for this suite.
The synthetic relations suite gives every arm identical dependency and owner facts.
Only its ontology arm additionally stores those facts in the fresh project and
conversation, and requires inferred knowledge to appear in actual run telemetry.
Ground truth tests transitive dependency, unknown facts and unresolved conflicting
owners. These six parameterized cases are functional regressions, not six public
competition tasks or evidence that ontology improves all reasoning.

### ARC-AGI-2 text-grid protocol

The adapter uses only the [primary ARC-AGI-2 repository](https://github.com/arcprize/ARC-AGI-2),
revision `f3283f727488ad98fe575ea6a5ac981e4a188e49`. Its 120-file evaluation
path/blob manifest is pinned by SHA-256, and every selected raw JSON is checked
against both its pinned Git blob identity and SHA-256. The cache retains the
repository's [Apache-2.0 license](https://github.com/arcprize/ARC-AGI-2/blob/f3283f727488ad98fe575ea6a5ac981e4a188e49/LICENSE)
with a pinned digest; downloaded data remains private under `release/validation`
and is not included in the application. Preserve its license/attribution if ever
redistributing that data. No upstream implementation code is imported.

`locally-unused` is deterministic seed/hash selection over identifiers after
excluding known development tasks and IDs in a recorded, hashed inventory of
top-level validation JSON files. It is NOT a guarantee that the task never
appeared elsewhere locally or in model training. Initial exclusions include
`2c181942`, `38007db0`, `3dc255db`, and `88bcf3b4`; all other discovered prior IDs
are also excluded. Selection happens before task contents are fetched. Do not
inspect the newly selected tasks to tune the solver before the frozen run.
For deliberately chosen or reused tasks, prepare a separate cache with
`--selection development --ids ID1,ID2` and pass matching ordered `--ids` plus
`--arc-selection development` to the harness. A cached selection cannot be
relabelled. Later repetitions are repeated measurements, not fresh holdout tasks.

The model receives demonstration inputs/outputs and test inputs only. Held-back
test outputs stay in the controller's cache and grader, never the model request,
scratch workspace, ontology or report. A fresh whitelist projection constructs
the prompt. Digit rows are a text serialization, so this does not test image/OCR
accuracy. Dimensions and every cell of EVERY test output must match exactly;
missing/extra grids, prose, ragged rows and multiple alternatives fail the format
check. There is no fuzzy matching, LLM judge, answer repair, retry or best-of-two
selection. Each task-arm-repetition is strict pass@1; the two repetitions are
reported separately in samples, not combined into official ARC pass@2.

The planned six-task paired run has 24 calls with 600-second deadlines: at most
four hours of active turn time plus startup/cancellation overhead, not an ETA.
Token expenditure is unknown in advance and all arms retain normal native tools.
ARC has no ontology treatment in this adapter. Report it separately from AIME and
synthetic relations; it is neither a visual score nor an official leaderboard run.

## Metrics and validity

AB/BA scheduling alternates the first arm by task and reverses it on the second
repetition. Three-arm runs rotate and reverse. Every requested task-arm-repetition
stays in the denominator. No retries are performed. Timeouts cancel the owned run
and await settlement; failed settlement stops the run. Only generated conversations
in the isolated home are archived. Temporary evaluation data is retained for local
diagnosis; no unrelated project, conversation or file is removed.

Each sample records total wall duration, first answer text, tool lifecycle events,
worker state/usage events, model identity, native transport milestones, knowledge
counts, answer hash, deterministic pass/fail and failure category. Prompt bodies,
reference answers, raw tool arguments/results and raw provider errors are excluded
from reports. Whole-turn tokens already include helpers; worker tokens are never
added again. Cache tokens are a subset of input tokens and are not double-counted.
Unreported/invalid usage remains unknown, including cancellation paths. Completion
p50/p95 includes failures; first-text p50/p95 explicitly counts only observed text.
Tokens per success is reported only when every requested run has known usage.
Subscription tokens are not converted to invented dollar costs.

Same model and deadline are not equal compute: orchestration can buy extra model
calls. Compare accuracy and latency jointly, then add a separate equal-total-token
study if needed. Do not combine post-failure retries with pass@1, select only the
fastest baseline, or claim a latency gain from first-text alone. Before promoting a
policy, freeze it and run a predeclared unused local split with independent tasks.
Public AIME and ARC can be contaminated even when unused in this local tuning.

## Current evidence and next public evaluations

`release/validation/vera-app-smoke-070-004.report.json` validates the 0.7.0 staged
application path after this permission preflight fix. Exact gpt-6-sol/high answered
both selected AIME 2024 #15 problems correctly in both arms over two AB/BA
repetitions: single 4/4 and adaptive 4/4, with valid frozen provenance and no missing
runs. All eight used native transport but recorded zero tools or helper events.
This is an execution smoke test, not evidence of a multi-agent or ontology gain.
Latency and token variation between repetitions was large. The earlier `003`
attempt was clamped to approval mode by the fresh configuration's default and
waited for approval; it is an execution failure, not an accuracy observation.

The earlier installed `app-hard-aime-0611.ts` runs used gpt-6-sol high and achieved
10/10 in both single and council arms; total times were 354.0 and 793.3 seconds.
Those ten late-numbered AIME 2022 tasks are already development data. The previous
two-task ARC adaptive experiment used Astra/Sol/Luna together, so it cannot establish
a same-model Sol gain. All six answers passed, with adaptive slower than single and
faster than its fixed pipeline. `scripts/performance-paired-live.ts` calls the CLI
text transport directly and is not an actual-app orchestration benchmark.

Use a pinned, predeclared unused subset of the official
[ARC-AGI-2 public evaluation set](https://arcprize.org/arc-agi/2) for compositional
grid reasoning; it has 120 public evaluation tasks and explicitly reports cost.
Keep previously inspected IDs out of the local holdout. Report this harness's
strict pass@1 separately from ARC's official pass@2 and private leaderboard.
For repository and interactive GUI capability, separate containerized SWE-bench
and environment-state tasks are needed; AIME is only an arithmetic reasoning probe.
No official submission or broad agent-ranking claim is made by this harness.

## Research-derived implementation candidates

These are design references, not imported implementations or promised effect sizes.

- [Anthropic's multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)
  motivates independent bounded branches and artifact references, while reporting
  substantial token overhead. Its internal research improvement uses mixed models
  and does not predict a Sol gain here. Implement dispatch only when a new branch
  can change the conclusion; retain source references and aggregate all usage.
- [Effective context engineering](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents)
  supports small upfront context plus on-demand retrieval. Test compact provenance
  packets and scoped `knowledge_lookup`, preserving conflicts and missing evidence.
- [LAMaS, revised August 2026](https://arxiv.org/abs/2601.10560)
  distinguishes critical-path latency from total inference cost and adaptively
  removes redundant future interactions. An independent implementation can start
  with deterministic latency budgets and cancellation of unnecessary pending work;
  do not claim its trained-controller results without reproducing that method.
- [Voting or Consensus?](https://arxiv.org/abs/2502.19130)
  varies decision protocol while fixing other debate parameters and finds that
  additional discussion rounds can hurt. Test independent drafts and a bounded
  verification step against single execution before increasing agent/round counts.

- [Towards a Science of Scaling Agent Systems, version 3](https://arxiv.org/html/2512.08296v3)
  compares task/architecture alignment across six agentic benchmarks. Coordination
  can help decomposable work and hurt sequential work; its measured gains are not
  universal routing thresholds. Keep static reasoning, interactive file/tool work,
  and scoped-memory tests separate. Do not infer an orchestration advantage from
  AIME or ARC accuracy alone.
- [Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)
  motivates independent outcome checks, repeat consistency and isolated trial
  state. The native functional smoke checks the resulting file hash and completed
  helper, not a model's claim that it performed an action. All-repeat success is
  reported separately from selecting a successful attempt.

## Metadata-only report

```powershell
node --import tsx scripts/app-benchmark-report.ts PLAN.json REPORT.json NEW-SUMMARY.md
```

This offline command performs no model calls. It validates the canonical plan hash,
the complete paired task schedule, model/effort/native-route agreement, persisted
and streamed final agreement, usage accounting and cleanup evidence. Duplicate or
unplanned samples fail validation; missing runs remain in the planned denominator.
Unknown or capped usage is not treated as zero or an exact total. The Markdown
contains only allowlisted aggregate metadata, never prompts, solutions, local
paths, raw tool payloads or provider errors. Existing output files are not replaced.

## Native observation limitations

Native CLI code-mode calls are not always included in ordinary item notifications.
Version 0.7.0 opts new Codex threads into raw item events where the CLI supports the
field, immediately discards text/reasoning/arguments/results and retains only the
bounded allowlisted `exec` lifecycle. Cold resume preserves the existing thread;
it never starts a different conversation merely to improve logging. If that
connection cannot enable raw events, PC/mobile show a persistent observation
limitation rather than implying that zero observed tools means zero tool use.

Older frozen evaluation bundles predate this correction. Their native tool counts
can undercount code-mode execution. In the first eight completed ARC runs, a private
metadata-only cross-check found matching provider final usage, checkpoints and
report totals; the missing tool events did not imply duplicate token accounting.
These historical scores must not be relabeled as measurements of the later bundle.

The separate `test:native-observation-live` command defaults to plan-only and needs
`--allow-account-usage yes` plus a new output directory for inference. It uses fresh
app/profile/project state and normal desktop RPC, requests exactly `gpt-6-sol`,
checks a random scratch-file SHA-256 artifact and one read-only completed helper,
and cancels/settles only its own run on deadline. These deliberately prescribed
operations are functional regression checks, not evidence of autonomous model
quality or a public benchmark score.
