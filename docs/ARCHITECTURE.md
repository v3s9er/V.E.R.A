# Mr.Robot architecture

## Product boundary

Mr.Robot has one authority boundary: the PC agent owns computer tools, credentials,
conversation persistence, and permission decisions. Web and mobile apps are
authenticated clients. They submit a task over the paired WebSocket connection;
the PC agent selects a model, calls audited tools, and streams progress/results
back to the requesting client.

Direct screen streaming and mouse/keyboard control were removed from the normal
product UI. The low-level implementations remain internal because the PC agent
needs them as tools. Direct mutating RPC calls are rejected unless permission
mode is `full`.

## Model modules and routing

Every model is registered as a module with a normalized interface:

- OpenAI-compatible API (OpenAI, DeepSeek, Groq, OpenRouter, Mistral, etc.)
- Anthropic API
- Ollama/local OpenAI-compatible models
- official Codex CLI, using the user's existing login
- official Claude Code CLI, using the user's existing login

Consumer subscription credentials are never copied or converted into API keys.
In single-model mode with a selected workspace, CLI modules launch the official
Codex or Claude Code executable without a shell, in that workspace, with the
selected model and mapped permission mode. The native agent owns its established
tool loop. This avoids paying a second API model to reinterpret its plan. In a
multi-node preset, provider-neutral nodes remain inside Mr.Robot's bounded loop.

The router first classifies task shape and complexity, then selects the configured
role node (`fast`, `general`, `reasoning`, `coding`, `vision`). The graph editor
persists freely positioned input, classifier, model, critic, memory, and output
nodes plus their edges. Model-node position defines ordered role fallbacks. Explicit
per-conversation model selection always wins. A zero premium-call budget forces
a cost-tier-0 model when one is available.

This intentionally starts with an interpretable router. Local telemetry records
the selected route, tokens, latency, tool count, failures, and estimated cost
without storing prompt bodies. Once enough preference data exists, the heuristic
can be replaced by a learned router without changing the provider or UI contracts.

Token policy keeps the static system prefix short, exposes only task-relevant
computer tool schemas, caps runs at 16 model steps, blocks a third identical tool
call, bounds tool output, and keeps recent turns plus a compressed older summary.

The bundled Orca plugin is an execution backend rather than a model provider.
For coding-shaped requests only, it exposes bounded JSON tools for repository and
worktree discovery, isolated Codex/Claude delegation, and terminal follow-up. Read
operations are marked non-destructive; worktree creation and terminal input pass
through the same permission gate as every other mutating Mr.Robot tool. The plugin
uses the official `orca` CLI with `shell: false`, persists only its executable path
and defaults, and can auto-open the local Orca runtime before a delegated task.

Research basis:

- [FrugalGPT](https://arxiv.org/abs/2305.05176) motivates a cheap-first cascade
  that escalates only when expected quality is insufficient.
- [RouteLLM (ICLR 2025)](https://proceedings.iclr.cc/paper_files/paper/2025/hash/5503a7c69d48a2f86fc00b3dc09de686-Abstract-Conference.html)
  learns strong/weak routing from preference data and exposes a cost-quality
  threshold. Mr.Robot preserves the data and policy boundaries needed to adopt this.
- [OpenAI model guidance](https://developers.openai.com/api/docs/guides/latest-model)
  recommends selecting reasoning effort intentionally, using low effort for
  latency-sensitive work and higher effort only when evaluation shows a gain.

## Conversations and memory

`conversations.json` stores independent conversations with title, status,
reasoning effort, optional pinned provider, usage, and normalized turns. Writes
are atomic (temporary file then rename). Large conversations keep recent turns
verbatim and compress older turns into a bounded summary. The UI reports how many
messages were compacted.

`memory.json` is an explicit long-term memory store. Mr.Robot does not silently turn
all chat content into memory. The user adds or removes durable facts, and a small
keyword ranker injects the most relevant items into a task. This reduces privacy
risk and avoids paying a model merely to retrieve a handful of personal facts.

OpenAI's current API guidance also supports persisted reasoning and multi-turn
continuation where available. Provider-specific native continuation can be added
behind the same conversation contract; Mr.Robot currently keeps a portable,
provider-neutral history so conversations can switch models.

## Workspaces, context broker, and run control

Registered workspaces are explicit capability roots. A conversation stores only a
workspace ID; the absolute path stays PC-local and is not copied to another device.
Codex/Claude native runs receive that path as `cwd`. API tools resolve and validate
paths against the workspace permission profile.

The context broker hashes file bytes and tracks size/mtime in a bounded LRU. A
second local reader reuses the parsed text and role-specific excerpts. This saves
disk parsing and repeated orchestration payloads, but does not falsely claim that
different vendors share a server-side prompt cache: every model still charges for
the tokens it actually receives. Runs expose cancel state and a steering queue;
additional commands are consumed at the next safe stage/tool boundary.

## Plugin boundary

Calendar, Cloudflare Quick Link, optional Tailscale transport, voice wake, MCP host, CTF analysis, Docker sandbox,
and Orca are built-in plugins—not privileges hidden in the core. Every manifest
declares kind, capabilities, permissions, dependencies, and enabled state. The host
can disable a plugin persistently, hides its AI tool schemas while disabled, and
still allows its bounded status/config commands. MCP server descriptions and CTF
commands are treated as untrusted input and pass through the normal approval gate.

Workspace and shared-file transfer is ordinary authenticated byte streaming; it
does not call a model and consumes zero model tokens. A source PC issues a
90-second, single-use capability scoped to one file or one state snapshot, so the
destination PC never receives the source device's long-lived credential. Cloudflare
Quick Link supplies an optional VPN-free HTTPS/WSS path and Tailscale remains an
optional encrypted transport. Mr.Robot keeps pairing, device revocation, and
per-device permission caps at the application layer.

## CTF sandbox

`mr-robot/ctf-toolbox:0.3.3` is an Ubuntu 24.04 image containing reusable reversing,
pwn, crypto, forensics, and network-analysis tools. Default execution uses a
read-only root, non-root user, `--cap-drop=ALL`, `no-new-privileges`, no network,
bounded memory/CPU/PIDs, an in-memory `/tmp`, a read-only challenge mount, and a
separate writable output mount. Network and ptrace are exceptional explicit
options and therefore require approval. This is defense in depth, not a guarantee
against every kernel/container escape; untrusted public challenges should run on
an updated Docker/WSL host.

## Permission profiles

- `read-only`: blocks every destructive computer or plugin tool.
- `ask`: pauses destructive tools and asks the requesting client.
- `workspace`: file writes/moves/deletes under configured roots run automatically;
  other destructive actions still ask.
- `full`: executes all in-scope tools without confirmation.

The default is `ask`. Each 5-minute, single-use PIN exchange creates a random
per-device token; only its SHA-256 hash is stored and the displayed PIN rotates
immediately after enrollment. A link has its own permission cap and an independent
`work-sync` capability, and can be renamed, reduced, elevated by a local
administrator, or revoked independently. QR v3 holds only connection routes,
transport metadata, and the short PIN—not the master credential. A non-admin
device token cannot raise global permissions or edit providers.

Provider API keys are encrypted with Windows DPAPI `CurrentUser` scope and fixed
application entropy. Plaintext configurations are migrated atomically at load.

The desktop and mobile chat toolbar stores a requested permission mode on each
conversation. At run time the server takes the lower of that request and the
paired device's permission cap before starting an API tool loop or native CLI.
Thus a mobile conversation cannot use its UI to exceed the cap granted on the PC.
The older global safety setting is the default for newly created conversations.

## Subscription adapters

Claude Code officially documents Pro/Max subscription login and non-interactive
JSON output through `claude -p`; see [setup](https://docs.anthropic.com/en/docs/claude-code/getting-started)
and [CLI reference](https://docs.anthropic.com/en/docs/claude-code/cli-usage).
The Codex adapter likewise expects an already authenticated official `codex`
command. Availability, plan limits, and supported models remain the vendor's
responsibility and are checked through the module connection test.

## Further production hardening

The public beta is usable now. A fully managed commercial release should additionally:

1. Add a publisher certificate, signed auto-update, and release channel. The
   current branded NSIS x64 installer is unsigned.
2. Add learned routing thresholds and quality evaluation labels on top of the
   existing local telemetry; enable critic escalation only when measured ROI wins.
3. Add a document-search node with metadata filters, bounded top-k retrieval, and
   optional reranking when RAG is introduced.
4. Add hardware-farm Android end-to-end tests and, when an owned backend and OAuth
   credentials exist, a persistent Google/Firebase device registry plus E2EE relay.
