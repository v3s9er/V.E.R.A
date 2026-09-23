# Measured results — 2026-09-23

Environment: Windows x64, Node 24.13.1, 16 logical CPUs. Measurements used synthetic data only. This is local engineering evidence, not a leaderboard result.

## Validated storage optimization

The baseline was captured before the telemetry implementation changed, from the telemetry implementation at commit `c40d2db`. Each row contains 100 measured operations after one explicit list/summary warmup. A fresh synthetic file started with 1,000 rows; 100 records were appended before list and summary measurements. Both revisions passed the same latest-ID and row-count assertions.

| Actual host operation | Before p50 / p95, ms | After p50 / p95, ms | p50 change |
| --- | --- | --- | --- |
| Record one trace | 2.187 / 4.133 | 0.465 / 0.686 | -78.7% |
| Read latest 100 traces | 0.903 / 1.419 | 0.130 / 0.172 | -85.6% |
| Summarize latest 1,000 | 1.469 / 2.902 | 0.041 / 0.053 | -97.2% |

Baseline telemetry-source SHA-256: `6899af07b4d62b4a8d8e0bbc6232697d8413c45f06a81b516ea585044542f00c`.

Measured candidate SHA-256: `192f243f99c64f258a26ceec0240da71ed09dfb152e12a6defc6697b4974e476`.

This removes repeated whole-file parsing from a synchronous hot path. The absolute savings are milliseconds, not seconds of model generation. File rotation, cold start, crash durability and different hardware require separate tests; the table must not be presented as a model-speed improvement.

A second candidate run with the same source hash also passed: record p50/p95 0.416/0.580 ms, list 0.127/0.206 ms, summary 0.039/0.047 ms. The repeated results support the local hot-path change while illustrating that exact timings fluctuate.

## Current local paths, not a before/after speed claim

100 samples per case, all invariants passed:

| Case | p50, ms | p95, ms |
| --- | --- | --- |
| Read 16 KiB evidence, application cache cold | 0.691 | 1.273 |
| Read 16 KiB evidence, application cache warm | 0.088 | 0.107 |
| Pack 24 bounded handoffs | 0.022 | 0.046 |
| Discover 12 summaries from 250 tools, warm cache | 0.007 | 0.009 |
| Resolve one requested tool schema | 0.005 | 0.006 |
| Release/drain 32 queued FIFO jobs | 0.027 | 0.100 |
| Cancel 32 pending jobs | 0.407 | 0.634 |

The synthetic full 250-tool page serialized to 312,901 bytes. The 12-summary discovery response was 3,655 bytes; one selected schema was 1,282 bytes. These are actual serialized sizes, **not tokenizer measurements or guaranteed billed-token savings**. They answer different retrieval stages and are not equivalent complete tool inventories.

An unchanged-source A/A repeat reduced cold-read p50 from 0.691 to 0.519 ms on the same machine. No implementation had changed: this is background/OS-cache/run variance, not an optimization. The comparison gate explicitly rejects promotion when both production hashes and treatment are unchanged, even if a descriptive interval favors the second run.

## Synthetic native transport

20 samples per condition, all correctness/stream-order/cancellation checks passed. The fixture intentionally emits text after 5 ms and completion after 20 ms; it does not contact a model.

| Condition | First-text p50 / p95, ms | Completion p50 / p95, ms |
| --- | --- | --- |
| New fixture process/session | 105.52 / 128.05 | 122.93 / 144.96 |
| Reused verified session | 22.82 / 35.14 | 51.11 / 64.99 |
| Cancel acknowledged synthetic work | not applicable | 14.34 / 20.15 |

This demonstrates a warm/cold host difference and bounded interruption. It is not a before/after comparison, nor real Codex TTFT. Runtime shutdown/restart overhead outside the measured request remains part of full application lifecycle costs.

## Actual subscription smoke

Codex CLI 0.153.4, explicitly selected `gpt-5.6-terra`, `medium`, concurrency one. 8/8 requests completed correctly. No native tools, personal conversation or files were supplied. Each case has only two samples, insufficient for the promotion gate.

| Tiny synthetic task | Mean first-text, seconds | Mean completion, seconds |
| --- | --- | --- |
| Arithmetic, cold session | 4.333 | 4.475 |
| Korean label reversal, warm | 2.615 | 2.882 |
| Bounded field extraction, warm | 2.471 | 2.652 |
| Recall marker from previous turn, warm | 2.650 | 2.851 |

The CLI reported 2,589–2,910 input tokens and 18–73 output tokens per request, including harness/provider context and reasoning usage where included by the provider. Some requests reported 1,792 cached input tokens. This is an absolute current smoke observation, not proof that model inference improved.

## Actual paired concise-profile experiment: not promoted

Same Codex CLI 0.153.4, `gpt-5.6-terra`, `medium`, concurrency one. The candidate adds the production `tuningInstructions({ responseStyle: 'concise' })` instruction; the baseline has no profile. There were 20 repetitions per case and treatment: four requested tasks plus a separately measured recall-priming turn, **200 actual calls**. Case sessions were isolated; only the recall turn reused its own priming session. Treatment order alternated AB/BA. The measured production sources remained unchanged throughout the experiment.

All 200 requests completed at the transport layer. **That is not 200 correct answers.** Strict exact-output checks passed 75/100 baseline and 82/100 concise requests. Quality means the originally declared normalized exact answer and no tool calls; the trial did not use a semantic grader.

| Case, 20 samples each | Exact-output passes, baseline / concise | Completion p50 / p95 baseline, seconds | Completion p50 / p95 concise, seconds | Paired mean difference 95% interval, seconds |
| --- | --- | --- | --- | --- |
| Arithmetic | 19 / 19 | 4.106 / 6.646 | 4.155 / 8.214 | -0.111 to +1.314 |
| Field extraction | 20 / 20 | 3.829 / 4.974 | 3.989 / 4.926 | -0.285 to +0.564 |
| Recall priming, expected READY | 3 / 9 | 5.131 / 6.862 | 4.930 / 7.621 | -0.519 to +0.709 |
| Recall, expected synthetic marker | 13 / 15 | 3.838 / 7.012 | 3.474 / 7.715 | -1.305 to +0.463 |
| Korean label reversal | 20 / 19 | 3.816 / 5.251 | 4.208 / 5.774 | -0.181 to +0.789 |

Every mean-difference interval includes zero: **no mean-latency improvement was demonstrated**. Arithmetic first-text p95 worsened from 6.448 to 8.090 seconds, crossing the declared tail-regression gate; the Unicode exact-output check also regressed. None of these findings supports enabling concise as the production default.

Reported input/output tokens totaled 269,453 for baseline and 271,874 for concise (**+0.90%**); cached input counts were 152,320 and 155,904 respectively. Totals include priming and failed exact-output checks. This experiment did not demonstrate token savings. These are provider counters, not measured monetary charges or a billing forecast.

The 200-call reports intentionally did not retain answers. Consequently, failed strict checks **cannot now be classified as extra wording, a wrong value or lost session memory**. A separate diagnostic used exactly four more synthetic calls: two fresh sessions each returned `READY` and then the correct marker. All four were exact matches. That did not reproduce the earlier failure, does not explain it, and does not establish that intermittent continuity problems are absent. The original trial remains failed; no retrospective regrading or promotion was performed.

Future runs record a bounded lexical diagnostic enum without storing responses. This distinguishes exact normalized output, expected-value presence with additional text, and absence of the expected value. Presence is not semantic correctness: a denial can contain the expected marker. The original 200 measurements have no such metadata and remain unreported for that diagnostic.

The full experiment's runner SHA-256 was `5f27c1c1dff50f2e1ac867a685661bce11f99efad631a0b917d396c8c08f6bc6`; the measured model-tuning source was `c58b2f993838731aadb462e8925e5ba2889fa41bc61bdab4476bc8108c9c46d0`. The later lexical-diagnostics-only harness change does not describe a rerun. Raw numeric reports remain local, outside Git. No production profile was automatically changed.

Across this work, the live calls were 8 smoke + 200 paired + 4 diagnostic = **212**. No private conversations, attachments or native tools were supplied. Broader quality, long-session memory and real application workloads still need independent evaluation; these small instruction-following tasks do not establish a general agent performance rank.
