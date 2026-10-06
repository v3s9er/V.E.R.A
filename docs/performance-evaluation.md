# Performance evaluation and promotion rules

V.E.R.A now measures three different things separately. They must not be collapsed into a claim that a model became faster or more intelligent:

| Suite | What actually executes | What it can establish |
| --- | --- | --- |
| `performance-local.ts` | Production context cache, packer, MCP discovery and FIFO scheduler with synthetic inputs | Local overhead, boundedness, ordering, cancellation and serialized context size |
| `performance-transport.ts` | Production native transport with a deterministic local stdio fixture | Process/session reuse, first visible text delivery and cancellation latency, not inference speed |
| `performance-live.ts` / `performance-paired-live.ts` | Installed authenticated Codex CLI, selected model and effort, ephemeral no-tool broker | Actual end-to-end first-text time, completion, reported usage and correctness on the declared tiny tasks |

## Research basis

[AI Agents That Matter](https://arxiv.org/abs/2407.01502) argues for evaluating cost and correctness together, adequate holdout sets and reproducibility instead of accuracy-only optimization. We apply that principle by requiring unchanged completion/quality, checking usage, retaining unsuccessful outcomes and refusing to infer real-model performance from mock timings.

[Princeton's HAL harness](https://github.com/princeton-pli/hal-harness) uses standardized agent evaluation and usage/cost tracking. Its repository is archived as of July 2026; it is a methodology reference, not an installed runtime dependency. No HAL source or benchmark dataset was copied into this project.

The subscription transport uses the [official Codex app-server](https://learn.chatgpt.com/docs/app-server) through the existing V.E.R.A adapter. These experiments do not create paid API fallback credentials, start fine-tuning, upload private documents or change the selected production model.

## Repeatable commands

Run from the repository root after installing the existing dependencies. `build:shared` must precede agent typechecking if shared types changed. Output files are explicitly chosen; general evaluation reports refuse to overwrite an existing file.

```powershell
node --import tsx --test packages/agent/test/performance-evaluation.test.ts
npx tsc -p scripts/performance-tsconfig.json

node --import tsx scripts/performance-local.ts --samples 100 --out baseline.local.json
# Change one production implementation, not the benchmark inputs.
node --import tsx scripts/performance-local.ts --samples 100 --out candidate.local.json --baseline baseline.local.json

node --import tsx scripts/performance-transport.ts --samples 20 --out baseline.transport.json
node --import tsx scripts/performance-telemetry.ts telemetry.json

# Explicitly spends subscription usage; exact model and effort are mandatory.
node --import tsx scripts/performance-live.ts --allow-account-usage yes --model YOUR_MODEL --effort medium --samples 2 --out smoke.live.json

# Interleaved baseline versus the production concise response-style instruction.
# 20 repetitions * (4 measured tasks + 1 recall priming turn) * 2 variants = 200 calls.
node --import tsx scripts/performance-paired-live.ts --allow-account-usage yes --model YOUR_MODEL --effort medium --samples 20 --out-prefix experiment

node --import tsx scripts/performance-compare.ts --baseline experiment.baseline.json --candidate experiment.concise.json
```

`performance-compare.ts` exits `0` only when the evidence gate is eligible for review, `2` for no eligible promotion. This never switches application settings automatically. Other runners fail on transport/correctness regressions. The single-purpose telemetry script retains its original storage-benchmark schema so the captured pre-change evidence stays interpretable.

## Measurement contract

- Timers are monotonic. First text is the first nonempty **user-visible answer** delta, not a status, reasoning event or internal analysis.
- Percentiles use nearest rank. A 2-sample p95 is just the larger sample: smoke data is not a stable tail estimate.
- Missing usage or first-text measurements stay `null`, not zero. Input, output and cached input counters remain separate. Subscription token counters do not establish a dollar bill.
- Model, effort, CLI version, runtime, concurrency, workload and harness/fixture hashes must match for comparison. Production-source hashes may differ because that is the implementation being evaluated.
- At least 20 samples per case are required. A fixed-seed 1,000-draw bootstrap provides a descriptive 95% interval for mean latency differences. A shared experiment identity plus matching repetition IDs enables paired resampling; unrelated runs use independent resampling.
- Promotion needs at least one practically meaningful improvement, no measured quality/completion loss, no declared tail/first-text regression, and no usage-per-success regression over 10%. A latency regression requires p95 growth above 20% and the noise floor; the mean-difference interval also has to support the regression for total duration.
- Practical floors are 0.25 ms for local/synthetic paths and 100 ms for live inference. Improvements also require at least 5% mean reduction. These are engineering review gates, not universal statistical significance standards.
- An A/A repeat with unchanged production hashes and treatment cannot be promoted even if timings improve. File-system/cache/load drift is real; an observed faster run is not an implemented optimization.
- Cases alternate baseline/candidate order across repetitions. Each paired case has an independent ephemeral session. Recall gets one matched priming turn; priming latency/usage is reported as its own case, not hidden.
- Live inference is concurrency one, tools disabled, no native environment, no app/Discord history, no attachments and no production-profile changes. A failed transport stops further spending. Per-call timeouts are mandatory.
- Reports contain metrics and source hashes, not prompts, answers, user file paths, account IDs or credentials. The checked-in task definitions are synthetic and public.
- Live quality is the declared exact-output check after trimming surrounding whitespace and a Markdown fence, plus absence of tool calls. It is not a semantic-quality score. New runs additionally record only a lexical diagnostic enum: `exact_normalized_match`, `expected_value_present_with_extra_text`, or `expected_value_missing`. A marker can occur inside a denial or otherwise wrong answer; substring presence does not prove semantic correctness, memory accuracy or harmless extra formatting. These diagnostics never relax `qualityPassed`, and missing diagnostics in older reports stay unreported instead of being inferred or regraded.

## Limits and honest interpretation

The four live tasks cover arithmetic, Korean output formatting, bounded extraction and one-turn recall. They **do not** establish general coding quality, long-horizon planning, factual research accuracy, computer-use competence or resistance to arbitrary attacks. No safety settings are relaxed to win a benchmark.

The paired concise-style trial is a development experiment, not an unseen holdout. The tasks already request exact short answers, so a concise modifier may show no benefit or even add overhead. A failed/inconclusive candidate stays optional, not the default. Use a separate consented, redacted task set with executable acceptance checks and varied long sessions before claiming a general improvement or deploying a tuned model.

The bootstrap intervals are descriptive and are not corrected for multiple comparisons across cases. Minimum sample count alone does not guarantee statistical power or external validity. Freeze the grading contract before the run; do not reinterpret failed exact-output checks as success after seeing the results.

Service load, regional/network changes, prompt caching, model revision and Windows antivirus/background activity can influence timings. Repeat useful changes with alternating runs on the same host. Do not select the fastest trial and discard slower runs. Microbenchmarks are deliberately much smaller than a real conversation and cannot be converted into a claimed multi-second inference gain.

See [the measured September 23 report](performance-results-2026-09-23.md) for actual observations and their evidence boundaries.

For external public tasks, use the separate [BFCL subset workflow](external-agent-benchmarks.md). It reports tool-call accuracy and held-out effort comparisons, not this suite's tiny instruction-following score or an official leaderboard score. Its strict custom grader, pinned upstream hashes and disjoint partitions are covered by `npm run test:benchmarks`.

## Stored-knowledge recall regression

The `knowledge-recall` suite tests production retrieval through the real desktop renderer and `chat.start`, not a direct provider call. It contains three synthetic tasks: an exact scoped identifier among lookalikes, an absent scoped identifier, and a dependency chain with conflicting terminal facts beside a large shared-membership hub. The givens exist only in project/conversation-scoped `memory.add` records; task prompts do not repeat them. Setup receipts and read-back hashes must match before inference. Seeding is paced at 250 ms per record to respect the application's request limit; setup time is excluded from inference timing.

```powershell
# Freeze each binary separately; use the same seed, exact model, effort and repetition count.
node --import tsx scripts/app-benchmark.ts --app-path PATH_TO_FROZEN_STAGE_OR_EXE --expected-version VERSION --suite knowledge-recall --model EXACT_MODEL --effort high --repetitions 2 --timeout-ms 120000 --out-prefix release/validation/recall-plan --plan-only yes
# Use a new output prefix and the returned plan hash when executing the same options.
node --import tsx scripts/app-benchmark.ts --app-path PATH_TO_FROZEN_STAGE_OR_EXE --expected-version VERSION --suite knowledge-recall --model EXACT_MODEL --effort high --repetitions 2 --timeout-ms 120000 --out-prefix release/validation/recall-run --plan-hash PLAN_SHA256 --allow-account-usage yes

# No inference: baseline source versus current retrieval on 24 parameterized fixtures.
node --import tsx scripts/benchmark-knowledge-recall.ts --baseline FULL_COMMIT_SHA --out release/validation/recall-algorithm.json
```

Only the `ontology-adaptive` arm is supported by this suite. Compare app versions, not execution modes. A development Electron runtime loads the frozen stage or installed archive in a fresh profile; this is not an in-place test of the user's running profile. Normal product tools remain available, so a model may recover from weak initial retrieval by using a tool. That recovery counts as a successful answer, not proof that the initial evidence packet was correct. Record both layers separately.

Three cases, even repeated, are not sufficient for the live-performance promotion criteria above. The 0.7.8 change is a targeted correctness fix supported by deterministic regression tests; its small actual-app comparison is a smoke test, not a general accuracy, latency or leaderboard claim. Raw local evaluation evidence remains private and is not included in releases. This separation follows the [OpenAI evaluation guidance](https://developers.openai.com/api/docs/guides/evaluation-best-practices) on task-specific evaluation rather than relying on an overall impression.
