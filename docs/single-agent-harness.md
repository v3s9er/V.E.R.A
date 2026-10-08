# V.E.R.A 0.8 — single-agent harness

## One execution owner, specialized services

The selected model remains responsible for the whole task. VERA does not add a planner model, a voting panel, a helper model or a fallback model. Saved legacy scenarios remain readable, but their model graph and premium-node limits are inactive. Actual run token admission still applies before each model call. Per-user Discord provider/model/effort assignments are preserved; an unsupported assigned effort fails explicitly instead of silently downgrading.

The supporting modules are ordinary code, not agents:

```
User request → selected agent + existing session
                 ├─ context selection / project rules
                 ├─ Serena symbols / Context7 versioned docs (optional MCP)
                 ├─ selected-document retrieval + approved scoped claims
                 ├─ existing execution tools and work ledger
                 └─ actual verifier → same-agent correction → final result
```

Simple local conversation can use the existing lower-effort text path with the same model. Saved effort is not overwritten. Discord keeps the administrator's explicit effort even for a greeting. The single-agent instruction and supported vendor tool settings disallow helpers; this is not an OS-level guarantee against arbitrary programs launched through an unrestricted shell.

## Sessions and separate caches

- Codex native sessions keep the existing warm process pool and durable thread checkpoints. Workspace, authority, provider/model, instructions, tools, account environment and harness policy revision partition reuse. A policy change cannot revive a helper-enabled worker.
- Turn context is not the same as stable session instructions. Retrieved excerpts can change without being treated as a new global instruction.
- File/document caches recheck content hashes; schema discovery and retained MCP results have independent bounded lifetimes. A cached tool result is not fresh execution evidence.
- Provider-reported cached input remains a subset of input, not another additive token count. Local byte/character savings are not advertised as provider billing savings.
- Cancellation waits for owned execution retirement. A crash-uncertain task is not blindly replayed.

## Project knowledge and rules

Existing project instructions and the entity/relation ontology remain available. The ontology preserves provenance and conflicts; it is not a permission engine or proof of arbitrary facts. Work ontology records requested tasks, dependencies, reported states and declared-file checks.

In **Settings → project harness**, select a workspace and explicit relative `.md`, `.markdown`, `.txt` or `.json` documents. There is no whole-PC crawl. The first retrieval implementation is bounded lexical/entity retrieval, not an embedding model or a claim of semantic-search equivalence. It returns source hashes and line excerpts, never treats retrieved text as instructions, and exposes cache/read metrics.

The model may propose a claim with exact quotations. It cannot approve or promote it. The user reviews it in the same settings panel, approves it for reuse, or retracts it. Before reuse, sources are checked again. Conflicting claims stay separate; old claims are not silently overwritten. A source quote proves provenance, not the semantic truth of the claim.

Private selection, verifier configuration and candidate audit records are stored below the agent home `harness/`, outside the workspace. Selecting a workspace containing that private state is rejected; use a specific project folder rather than an entire drive/home directory. These files are never a public training dataset. There is no automatic model-weight training or unattended deployment.

## Actual verification

The settings panel registers named verification profiles. The model selects a profile ID, never supplies the command or an approval flag.

- JSON artifact checks validate actual file bytes against a documented small schema subset. Unsupported schema keywords are rejected, not ignored.
- Command profiles declare an executable, argument array, source files and timeout. Full-host execution requires explicit saved approval and current full permission. It is **not isolated**.
- Workspace-only command execution requires a real host-provided sandbox adapter. If unavailable, the UI and receipt say so; it does not silently run on the host. Existing sandbox tools remain separate.
- Receipts include exit/status, bounded output, declared-source revision and duration. Timeout, cancellation, changed sources or unconfirmed cleanup cannot be passing receipts. Exit zero is not proof that the test suite covers every requirement.
- Final failed **work-ledger file checks** allow at most one same-agent correction continuation. This is not an infinite repair loop, nor automatic repair of every registered test profile. A failed profile can guide the existing same-agent tool loop.

## Provider and UI boundaries

Codex's native dynamic tools and API tool-calling routes can use the new host knowledge/verifier capabilities. Claude native execution remains single-agent, but does **not yet have VERA's dynamic host harness bridge or Codex warm-session pool**. It is not silently rerouted to a different provider. External CLI features retain their own compatibility limits.

PC and browser share the new settings UI, including narrow-screen layout. Existing mobile clients can keep using the updated server, but a native Android harness editor is not added in this release. Discord does not receive the administrator's private knowledge tools; its direct model and existing isolation remain unchanged.

## Optional tools and validation

See [Context7/Serena setup](mcp-context7-serena.md). They are separate upstream installations, not vendored VERA source. Only relevant tool schemas are discovered on demand; large MCP results can be paged without re-executing a tool.

Run `npm run test:harness`, `npm run test:harness-ui`, and (after separate installation) `npm run test:harness-mcp-installed`. Installed-tool checks use synthetic source and a public documentation query, not user documents or an AI model. Full application smoke tests use a local fixture provider and therefore test integration, **not real-model accuracy or superiority to standalone Codex/Claude**.

Design references: [Codex app-server sessions and dynamic tools](https://learn.chatgpt.com/docs/app-server), [Serena](https://github.com/oraios/serena), [Context7](https://github.com/upstash/context7), [ACE](https://arxiv.org/abs/2510.04618), [GEPA](https://arxiv.org/abs/2507.19457). These inform modular retrieval and evidence-based iteration; published research scores do not transfer to VERA. No external agent framework source was copied for this redesign.
