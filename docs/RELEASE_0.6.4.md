# 0.6.4 — source evidence and native observability

## Changes

- Desktop renderer exit/load failures now retry the trusted local UI at most
  twice, then show a retry dialog instead of leaving an unexplained blank window.
  Reopening a failed window retries its UI without restarting agent work or
  deleting conversations/settings. Startup diagnostics contain fixed codes only.
- Source-dependent Codex council candidates can request workspace-confined PNG
  observations, text and Python syntax checks through the existing isolated,
  per-call-metered transport. Pixel evidence is delivered as actual image input,
  not a path string. Candidates still have no native environment, shell, writes,
  desktop, plugin or delegation capabilities. Discord isolation is unchanged.
- `evidence_image` returns the original SHA-256, dimensions, selected coordinates,
  crop hash and lossless pixels. Hash mismatch, junctions, traversal, oversize
  inputs, invalid crops, animated and interlaced PNG are rejected. Other image formats keep
  using the native viewer; the new crop reader does not claim universal support.
- `evidence_python_syntax` uses an installed CPython parser on stdin data, in
  isolated/no-site mode. It does not execute submitted code. It can check a
  transcription before a permitted native sandbox execution. Parser availability,
  visual transcription accuracy and runtime/output correctness remain distinct.
- Evidence instructions separate original observation, interpretation, peer
  proposals, memory and tool-verified results. Code-image problems require
  source-specific guards/slices/output checks; no answer-key special cases.
- Native tool lifecycle notifications now reach chat progress and telemetry.
  Duplicate events are counted once; missing completion is not labelled success.
  Only call identity/category/status/duration is emitted, never command payloads,
  tool output or private reasoning. `toolElapsedMs` is accumulated tool duration,
  not elapsed wall time; concurrent tools may overlap.
- Image echoes are not copied into the pre-turn correlation queue. Transport,
  evidence sizes, stage rounds and time budgets remain bounded.
- Isolated workers send unchanged images only once per successfully completed
  thread context. Only identity hashes are retained; another user/thread or a
  changed policy gets a fresh context. Request validation precedes allocation.
- For bounded groups with multiple explicitly named local PNG originals (up to
  four), Codex candidates divide the originals and receive their assigned pixels
  on the first call. Their readers cannot open another candidate's assigned file.
  Complementary assignments wait for every candidate or the existing deadline;
  the redundant-proposal half-quorum cannot cancel an unread source. No directory
  crawling, external image fetching, model substitution or new host rights.
- The last council evidence step is reserved for a concise proposal, including
  unresolved details. Repeated inspection no longer consumes every step and then
  discards all observations without a handoff. Structured responses constrain the
  call batch, and final-only steps allow no further calls.
- Council failure progress carries fixed diagnostic codes, not raw errors.
  Evidence readers show image/document/syntax status instead of PC-screen status.
  Disconnected progress consumers cannot terminate native work.
- Native evidence instructions are injected only when those tools are actually
  available. Ordinary tasks and other providers are not told to call unavailable
  Codex-specific evidence tools.
- Desktop/server/source manifests are 0.6.4; Android source version is aligned
  (versionCode 32). An Android source version is not proof of an APK build/upload.

## Verification boundaries

- Exact model for live comparison: `gpt-6-sol`, medium, Daybreak off, unchanged
  one-round two-candidate council. Normal installed-app `chat.start` entrypoint.
- Earlier 0.6.3 failures, images and independent references are retained locally.
  No copyrighted originals or user runtime state are added to public source.
- A parser pass cannot prove that transcription matches the original. A single
  public-task run cannot establish general accuracy, speed or benchmark rank.
- The initial 0.6.4 candidate had a 420-second single-agent timeout and exhausted
  council inspection steps. It was not counted as a successful speed improvement.
  Its raw records were retained before the inspection/handoff revision.
- Windows installer is currently unsigned. Existing user data is preserved and
  backed up locally before installation; secrets are not included in artifacts.

Protocol references: [Codex app-server lifecycle and image input](https://learn.chatgpt.com/docs/app-server),
[PNG decoder/crop API](https://github.com/pngjs/pngjs).

Live results and remaining limitations are recorded in
[competition-evaluation.md](competition-evaluation.md).

## Ontology revision

- Added local, bounded class/relationship inference, explicit functional-value,
  disjoint-type and cycle conflicts, premise provenance and partial-result flags.
- Replaced automatic legacy memory context injection with scoped knowledge
  retrieval. Provenance is packed once instead of repeated for each deduction.
- Added explicit assertion/correction controls and a readable knowledge inspection
  panel. Isolated Discord tasks still receive no private memory.
- Added numeric-only retrieval telemetry, scope/cache/rule regression tests and
  real chat-handler isolation tests. No model weights, selected provider, user
  permissions, account credentials, or global routing defaults were changed.

See [ontology.md](ontology.md) for the exact supported rules and limitations.
