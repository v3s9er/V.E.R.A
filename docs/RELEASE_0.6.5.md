# 0.6.5 — independent observation and scoped coordination

## Changes

- Single-mode trivial greetings, literal arithmetic and model-identity questions
  now use supported low effort even when the saved work preference is high/max.
  The model, saved preference, Daybreak and permissions do not change. Ambiguous
  follow-ups, short file actions and security requests are not downgraded merely
  for being short; substantive work retains the selected depth. Model-tuning
  profiles cannot accidentally overwrite the run's resolved effort afterwards.
  The desktop control explains this distinction; actual route/status reports the
  resolved effort. No extra classifier-model call is added.
- Trivial Codex conversations use the existing tool-less, conversation-scoped
  text transport instead of sending PC environment/tool schemas. Canonical
  history remains in the same Mr.Robot conversation. Queued work instructions
  transition back to native execution with the selected reasoning and existing
  authority checks; cancellation cannot launch that continuation. This is not a
  canned reply, model substitution or removal of computer tools from real tasks.

- Desktop initial size is capped to the active display's work area instead of a
  fixed 860-pixel height. Display removal/resolution changes bring normal windows
  back on-screen, with fitting minimum dimensions. This avoids hiding composer
  controls below short/HiDPI screens without changing OS display settings.

- Workspace PNG evidence now includes bounded, offline English/code OCR beside
  the original pixels. Tesseract.js/WASM and pinned language data ship with the
  desktop app: no runtime download, external OCR upload, shell, or model-selected
  executable. OCR is explicitly fallible and `verified:false`; it does not replace
  the image or prove that a code transcription is correct. Korean/general vision
  still uses the selected model. `ocr:false` skips the additional observation.
- OCR has at most two engines, a six-second observation deadline, input/output
  bounds and a 30-second idle retirement. Cancellation terminates its supervised
  workers. A same-image cache is limited to one evidence-tool lifecycle; learning
  and persistent OCR caches are disabled. Missing/bad assets fail back to pixels,
  not network downloads. These are resource bounds, not an OS security sandbox.
- Council preloaded images keep complete bounded OCR/provenance in their input;
  a compact image label no longer discards that observation. Ask-mode candidates
  cannot preload or read originals before permission. Existing workspace, hash,
  Discord isolation and read-only capability boundaries remain in force.
- Low-confidence OCR words receive bounded multiscale rescans. Disagreements
  remain explicit competing hypotheses, with a compact enlarged original-pixel
  review sheet for case/punctuation checks. Neither majority OCR nor confidence
  silently replaces the transcription; unflagged words may still be wrong.
- All parallel council groups share a physical call limit (default four, at
  most eight). Node deadlines start on admission, not while waiting in a queue.
  A timed-out adapter that ignores cancellation cannot free a slot prematurely.
  Fatal admission failures cancel sibling groups and prevent further rounds.
  Partial or absent proposals are still not votes or verified facts.
- Ontology retrieval distinguishes literal values from entity links. Named-entity
  queries no longer pull unrelated objects through a common `status=ready` value
  or a generic predicate keyword. Type conflicts remain local to the affected
  subject instead of invalidating other subjects sharing the same taxonomy.
- Returned ontology facts and rendered context agree on asserted/inferred/
  unresolved status. Evidence sources include recording/update timestamps, not
  a claim that the newest fact is true. Project/ticket scope and read-only bounded
  inference are preserved; this does not introduce automatic memory learning.
- Source versions are aligned to 0.6.5; Android source versionCode is 33. This
  does not imply a new APK or GitHub Release binary has been uploaded.

## Verification and limitations

Full repository tests and desktop/web/mobile type checks pass. Additional
regressions cover concurrency across groups, fatal cancellation, queued jobs,
OCR lifecycle and fallibility, literal-join leakage, and local type conflicts.
The Windows installer remains unsigned. Default models/routing, user permissions,
existing conversations and provider credentials are not changed by evaluation.

Live model results are recorded separately in
[OBSERVATION_0.6.5_2026-10-02.md](OBSERVATION_0.6.5_2026-10-02.md).
A small image test cannot demonstrate general accuracy, speed or benchmark rank.

## Design sources

Independent bounded workers and compact evidence handoffs follow the engineering
tradeoffs discussed in [Anthropic's multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system).
This release limits concurrency; it does not claim that more agents are better.

Small text requires direct source comparison, rather than treating image-model
agreement as proof. See [OpenAI image limitations](https://developers.openai.com/api/docs/guides/images-vision)
and [Tesseract.js local installation](https://github.com/naptha/tesseract.js/blob/master/docs/local-installation.md).

Explicit provenance and time metadata are informed by
[Zep's temporal knowledge graph research](https://arxiv.org/html/2501.13956v1).
Mr.Robot retains its bounded local fact graph; it does not implement Zep or
inherit that paper's reported performance.
