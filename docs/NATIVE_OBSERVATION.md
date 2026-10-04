# Native tool observation

V.E.R.A's run panel shows host-observed tool and helper lifecycle events, not
private model reasoning. A returned tool call is not proof that its result is
correct. Completed output still needs task-specific verification.

Fresh native Codex threads and warm continuation can opt in to the raw `exec`
lifecycle. Only structural call metadata is retained for the run feed; raw code,
arguments and outputs are not copied into observation events. Nested command
execution is a separate observed call, not another model token charge.

Cold-resumed sessions preserve their thread and conversation history. The resume
protocol does not provide the same raw-event opt-in. An older CLI may also lack
that feature. For these runs the host sets a sticky, run-local
`observationLimited` flag. PC and mobile show:

> 일부 내부 도구 기록은 이 연결에서 제공되지 않습니다

The notice survives later statuses and run snapshots. It does not change the
actual phase, verification status or error evidence. A fresh run starts with its
own flag. It is independent of `activityTruncated`, which means older **observed**
rows were evicted from the bounded display. Missing observations do not establish
that no tools ran, nor are observed tool counts token-usage totals.

## Opt-in functional acceptance

`scripts/tests/app-native-observation.smoke.mjs` defaults to a read-only plan:

```powershell
node scripts/tests/app-native-observation.smoke.mjs --app-path packages/desktop/.stage --model gpt-6-sol
```

Actual execution requires separate approval and both `--allow-account-usage yes`
and a new `--out-dir`. It creates a fresh desktop profile, agent home and scratch
project. Installed-path mode rejects an unsupported archive version or startup
modules that do not exactly match the reviewed repository's `main.mjs` and
`branding.mjs`, **before launching**. These modules honor the explicit isolated
profile before acquiring an instance lock or starting the agent; post-launch
path checks provide an additional guard. Both modes use development Electron:
the installed-path mode loads the verified adjacent `resources/app.asar`, **not
the installed EXE**. This avoids packaged startup changing OS login-item state
outside the isolated profile. It validates the installed application code and
normal local RPC flow, not packaged-shell autostart, update or installer behavior.
It tests an objectively
checked random-file SHA-256 artifact and one explicitly requested read-only
helper. Optional `--same-conversation yes` checks continuity as well. Each case
has a bounded deadline and cancels only its own run.

Evidence contains lifecycle metadata, checks, hashes and aggregate counts, not
raw code, reasoning or tool payloads. These are functional product smokes, not
unbiased model-quality benchmarks. Merely passing the non-inference harness
tests or printing its plan does not establish that a real model run passed.
