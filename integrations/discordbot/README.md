# Discord Agent plugin

## License

Original Mr.Robot Discord integration code is licensed under the [MIT License](LICENSE).
Copyright (c) 2026 v3s9er. Keep the copyright and permission notice in copies or
substantial portions. Third-party components retain their own licenses.
This software license does not grant access to AI subscriptions, accounts or
APIs, and does not override Discord or model-provider terms of service.

The optional first-party plugin connects Discord to the normal Mr.Robot agent.
**Standalone mode** reads only `bot_token` and `server_name` from a local
`config.json`. It does not import the security bot, execute its `main.py`, or need
its GUI/news/KTX dependencies. Connection settings stay in their original file,
read-only; no token is copied into the plugin store, command line or installer.

**Compatibility mode** optionally hosts the original security bot and the AI
adapter on one Discord client. Only `legacy_adapter.py` depends on that source.
Use this mode for news/KTX and AI together, not two simultaneous bot processes.
Existing configurations retain compatibility mode to avoid silently losing news
features. New configurations default to standalone; existing users can select it.

## Setup

1. Install `python -m pip install -r integrations/discordbot/requirements.txt`.
   Only compatibility mode also needs the original bot's dependencies.
2. Close the existing security bot before switching connection ownership.
3. Enable **Discord Agent** in Mr.Robot Plugins; select **Standalone**, supply
   the directory containing `config.json` and the absolute Python executable
   path, then choose **Save & Connect**. A config-only folder is sufficient;
   the existing security bot folder can also be used without running its code.
4. The existing bot must already belong to your Discord server. Its application
   needs application-command installation permission. `/robot` is upserted
   without deleting existing commands. Global command propagation may take time.

Commands: `/robot ask message`, `/robot models`, `/robot status`, `/robot new`,
`/robot stop`, `/robot access`, `/robot result`, `/robot approval`.
The ask command optionally accepts provider ID, model and effort.
Access selects read-only, ask, workspace or full per server/channel/user.
Full requires `confirm_full:True` and grants that user's runs PC-wide access.
Changes requiring approval show requester-bound, expiring approval/deny buttons.
If approval delivery fails, the normal PC approval timeout denies the operation.

## Personal thread workspace (0.4.7)

Run `/robot bind` in one text channel per registered guild. Its persistent panel
opens a ticket-title form and creates private user-owned threads only on request;
it also lists/reopens sessions. The PC plugin can provision the `ai_talk` channel
and pinned panel; newly created channels are administrator-visible by default.
`/robot unbind`
disconnects the parent without deleting history; `/robot sessions` lists your threads.
Plain messages in a managed thread run as that thread's owner, after a live admin check.
Thread controls provide model/effort/access settings, stop (including queued messages),
archive and confirmed deletion. Deletion removes Discord history permanently but
retains the separate PC conversation. Busy sessions must be stopped before deletion.
Ownership, bindings and conversation/settings mappings persist in the host plugin
store, not in the bot source. Other administrators cannot operate someone else's session.

Enable Message Content Intent in the application's Bot settings and reconnect.
Only the enabled intent is requested, with slash fallback when it is unavailable.
The bot needs View Channel, Send Messages, Read Message History, Create Private
Threads, Send Messages in Threads and Manage Threads; pinning also needs Discord's
message-pin permission. Private threads remain visible to Manage Threads moderators.
Messages and thread results are therefore not exclusively visible to the requester.
Attachments are explicitly rejected until file-input support is implemented.
Queue limits are 16 total/4 per thread; session limits are 64 total/20 per user.

## Security and limits

### User model ceilings (Discord Agent 1.4.0)

Server administrators can run `/robot model-limit user:@member ceiling:sol`
or choose `astra`, `show` (inspect), or `unlimited` (remove the restriction).
The policy is stored privately per guild/user, not per channel; opening/deleting
tickets or restarting the bot does not reset it. Other users/guilds are isolated.
Changes are refused while the target user's run is active. No limits are assigned
automatically to existing users.

The explicit application ordering is `spark < mini < luna < terra < sol < astra`.
Exact model IDs are gpt-5.3-codex-spark, gpt-5.4-mini, gpt-5.6-luna,
gpt-5.6-terra, gpt-5.6-sol, gpt-6-astra. This is an administration policy, not
a benchmark ranking. Unknown IDs/aliases and other vendors (including Claude)
are denied for limited users rather than guessed into a tier. `unlimited`
restores all configured providers. Adding future model IDs requires an explicit
policy update.

Catalogs and saved/direct selections are checked by the Node host. Limited
requests resolve their provider/default explicitly. Every actual provider call
through Mr.Robot's loop is checked again, including API/native execution and
fallback providers. Discord runs do not inherit PC routing presets. Policy
errors never silently upgrade or rewrite a user's chosen model.

Both `/robot access` and `/robot model-limit` require live server Administrator
membership; UI visibility alone is insufficient. Full PC access still needs
explicit confirmation and cannot override the PC's global read-only lock.
Since 0.4.15, allow_ai members may use isolated tickets. Administrators
may edit their own limits. This is not a spend-security boundary against a user
already authorized to run arbitrary PC commands or against model selection
inside a third-party native CLI/plugin; those programs remain separate trust
boundaries. No provider credentials are sent to Discord.

### Recent-message controls (0.4.8)

Every plain-chat receipt and final answer carries the ticket controls. Only the
old controls are removed, not message content; old Views are disposed. Use
`/robot controls` to bring the toolbar down or `/robot model` for the paged
provider/model picker. Discovery uses the registered provider's model-list API,
not arbitrary URLs. No PC credentials or provider keys reach Discord/Python.
Access changes still require the existing checks and full-access confirmation.
Stopping cancels a run; it is not pause/resume.

- Only administrators or allow_ai members of the locally registered Discord server are accepted.
  Live server membership, allow_ai roles and Administrator roles are checked on every request;
  application ownership alone and Manage Guild do not grant access. DMs fail closed.
- No public listener, router port or tunnel. Standalone reserves the old bot's
  loopback-only single-instance port (47823); it closes incoming probes without
  reading or executing data. An occupied port fails closed, even for an unrelated
  local program. Message Content Intent is needed for plain chat.
- Slash replies are ephemeral; plain-chat replies stay inside the private thread. All replies disable mentions. Discord
  still processes this content: do not send credentials or sensitive documents.
- A fresh execution device credential stays in the Node host, never in Python
  argv, bridge files, Discord, source or installer. Revocation cancels its runs.
- PC administrator settings cannot be changed through Discord. The PC's global
  read-only emergency lock remains authoritative even for an explicitly chosen full run.
- Discord runs have no app token cutoff. Provider quotas/charges still apply.
  Long results can be retrieved with `/robot result`; `/robot approval` retrieves
  an unexpired approval prompt. These are isolated per requesting administrator.
- One active request, up to 64 scoped conversations, no generic chat RPC deadline,
  bounded pipe/results, and automatic cancellation on connection loss.
- In standalone mode, disabling/stopping stops only the independent AI client;
  existing bot files/configuration are untouched. In compatibility mode, stopping
  also stops the managed security bot; hot-detaching AI while that GUI keeps
  running is not implemented. Launch the original separately after stopping if
  you want news/KTX alone.
- An OS account lease prevents duplicate plugin clients across config folders
  and is released when the process exits/crashes. The original bot's loopback
  lock also prevents known legacy/standalone duplicates on this PC. This cannot
  detect the same token running on another PC or an unrelated Discord client.
- Runtime config, bot tokens, IDs, logs, databases and local absolute paths are
  intentionally not distributed. This generic adapter is the only bundled source.

Use is subject to Discord and model-provider terms. Python and discord.py remain
external dependencies. The Windows installer bundles all generic plugin modules
and requirements, but no credentials or original security bot source. Existing
admin checks, ticket ownership and Mr.Robot execution/approval controls apply in
both modes.

### Ticket issuance: allow_ai

Server administrators must manually create the exact role `allow_ai` and assign
it to ticket requesters. The role is checked live before opening the form,
creating a private thread, and registering it with the PC host. Missing, renamed
or removed roles deny new tickets, including for server owners/administrators.
The plugin never creates or grants this role automatically. Existing tickets are
not deleted when the role is removed. Ordinary members with this role can use
isolated tickets; it does not grant PC access or permission-policy management.

### Separated user authority (0.4.15)

- `/robot user-access user:@member mode:isolated`: default for ordinary members.
- `mode:search`: public internet tools only, no artifact read/write or execution.
- `mode:blocked`: deny all AI use. `mode:default` removes the per-user override.
- `mode:full confirm_full:True`: explicitly delegate the PC's full agent authority.
  This is a **trusted operator grant**, not sandboxed access. Grant only to people
  trusted with the PC and its data. Administrator defaults to full. An explicit
  per-user restriction overrides the default, including an administrator's.
- All policy commands require live Administrator permission in Python and the
  host. `model-limit` continues to apply per user across all server tickets.
- Existing full-access conversation histories and cached replies are never
  reused in isolated mode. No PC default workspace, long-term memory, native CLI tools,
  Computer API, generic plugins, MCP, screen or host shell is supplied to it.
- Since 0.4.16, isolated users share the owner's registered providers and default
  model, including Codex/Claude subscriptions. Existing per-user model ceilings
  still apply. Provider access and computer authority are separate policies.
  Codex uses app-server with `environments: []` at both thread and turn boundaries,
  no discovered instructions and no native tools. Claude uses safe mode, no native
  tools and an empty strict MCP configuration in a fresh scratch directory.
  Only structured requests to the separate capability broker are executed.
  Unsupported CLI versions or missing owner login fail closed; there is no
  fallback to native PC execution or billable API-key authentication.
- Public HTTP(S) text only: DNS address pinning, private/reserved IP rejection,
  redirect revalidation, no cookies/authentication, standard ports and byte limits.
- Results are newly created files beneath a separate hashed ticket directory.
  Transfers cannot request arbitrary PC files or another ticket's results. The
  general limit is 1 MiB per artifact, 24 files/8 MiB per ticket. Output is not
  executed on the host. Downloads are **Discord-hosted attachments, not E2EE**.
- Optional Python standard-library computation requires Docker and the owner-
  installed `python:3.12-slim` image. No image pull is triggered by a user request.
  A fixed non-root, read-only, offline container has no host mounts/socket/secrets,
  drops all capabilities, prevents privilege gain and limits CPU/RAM/PIDs/time.
  Docker unavailable means denial, never fallback to host shell execution.
  Containers are defense in depth, not a guarantee against every kernel exploit.
- The ticket panel grants channel visibility to the existing exact allow_ai role
  during `/robot bind` or PC workspace setup. It never assigns roles to users.

Docker security reference: https://docs.docker.com/engine/security/

### Incoming attachments (0.4.17)

Post files with a message in your own ticket, post files alone for a summary, or
use the optional `file` argument of `/robot ask`. All extensions are accepted;
intake is not a promise that every proprietary/binary format can be decoded.
Limits: 25 MiB/file, 50 MiB/request, 10 files/request, 48,000 extracted characters.
PDF (up to 100 pages), DOCX, XLSX, PPTX, HWP/HWPX, ODF, XLS, RTF, encoded text and
ZIP contents have data-only readers. Images use local Windows OCR; scanned PDFs
attempt OCR on up to three pages. OCR may misread text and is not visual reasoning.
Legacy/proprietary binaries, audio/video, encrypted or malformed input fall back
to explicit unreadable/partial metadata, never a fabricated content summary.

Downloads are pinned to the Discord attachment CDN and the current channel/file
identity; redirects and arbitrary URLs are rejected. Parsing uses a fresh temp
directory, a credential-stripped subprocess, memory/CPU/wall-time bounds and no
macro execution, shell commands from documents or archive extraction to paths.
Temporary originals are deleted after extraction. Only bounded excerpts and
integrity metadata enter this owner's existing conversation/model. The original
file is not persisted for later binary editing. Large/truncated documents should
be split or relevant pages reattached. These are resource-limited parsers, not an
OS security sandbox or an E2EE guarantee; Discord retains its own attachments.

Install the pinned optional parsers with the plugin's Python runtime:
`python -m pip install -r integrations/discordbot/requirements.txt`.
Dependencies are upstream packages, not copied parser implementations: pypdf
(BSD-3-Clause), Pillow (MIT-CMU), xlrd (BSD), striprtf (BSD), olefile (BSD).
Windows OCR uses the installed Windows language capabilities and no paid API.

### Scheduling and recovery (0.4.18)

Normal ticket messages queue without interrupting an active job. Use **지시 추가**
or `/robot steer message:...` to amend it at the next safe step, and **작업 중지**
to cancel that ticket's current and queued work. Independent isolated users get
up to two concurrent slots; a user cannot monopolize both. Direct full-PC jobs
run alone relative to other Discord jobs. Existing allow_ai/admin and per-user
model/access policies remain authoritative and are rechecked during execution.

Gateway resume restores readiness. Pending messages wait for reconnection;
already-running jobs are not replayed automatically. Progress is edited in the
receipt and replaced by the final answer. Long replies include a full TXT after
up to four preview messages. These controls do not require ephemeral response
tokens that expire during a long job.

Legacy parsing cache: process-local excerpts, scoped to guild/user/ticket and SHA-256,
maximum five minutes / 32 entries / 4 MiB serialized data. Version 0.4.19 uses the
retained-original path below instead of deleting inputs. Discord is not an E2EE transport. Restricted
Codex workers reuse verified conversation prefixes for up to 20 turns / 120 seconds
idle, with native environments disabled on every turn and no copied credentials.

### Direct subscription execution and warm sandboxes

Restricted, single-model Codex tickets using the `audit-only` token policy now
use one app-server agent turn. Codex manages its own tool loop; Mr.Robot registers
only the ticket's public-web/artifact/Python capabilities and validates each call.
There is no extra verifier model, JSON-answer wrapper, or host-driven model call
after each tool. Selected model and reasoning effort are preserved. Whole-turn
usage is accounted once; finite/adaptive budgets retain per-model-call metering.
Claude restricted tickets retain the existing text-worker path. Fully authorized
Codex/Claude tickets already use native CLI execution; their public answer text
is now forwarded before process exit. Private reasoning is never forwarded.

The current Codex protocol exposes registered tools through a V8 code-mode
adapter. This is **not Node or a PC shell**. Environment access is empty on both
thread and turn; host skills are explicitly disabled and excluded from the
adapter. Unknown tools, approval requests, native execution events, mismatched
thread/turn IDs, and duplicate calls terminate the worker. Account authentication
stays in the owner's CLI, never in a user sandbox or Discord payload.

`isolated_python` lazily prepares the fixed `python:3.12-slim` base image once,
then runs by immutable local image ID. Each ticket gets its own disposable
container and `/work` tmpfs. Files survive successive calls; Python globals do
not. No host directories, Docker socket, credentials, external network, elevated
capabilities or model-controlled Docker options are supplied. Public internet
requests still go through the SSRF-checked host broker. Only standard-library
Python is included; arbitrary dependencies are not installed by model requests.

Limits: four slots per pool (basic/document); one code execution per ticket per pool; 512 MiB RAM / one CPU /
32 processes; 30-second execution; 128 KiB output; two-minute idle expiry. A
different non-root UID runs a 15-minute daemon-side watchdog, so user code cannot
disable expiry when the app crashes. Cancellation/error/app shutdown removes the
container; exported ticket artifacts remain available. Image preparation needs a
working Docker **Linux** engine. Engine failures do not fall back to host execution.

Verification: `npm run test:discord-fast` runs deterministic policy/lifecycle
fixtures. `npm run test:codex-installed` uses the installed CLI with a **synthetic
localhost model endpoint**, not the account or paid API, to check real tool
dispatch, early answer streaming, private-skill exclusion, inaccessible host
tools/network/Node globals, reuse, and aggregate usage. Docker-engine integration
can be run explicitly with `npx tsx packages/agent/test/discord-sandbox-installed.test.ts`.

### Retained originals (0.4.19)

The authenticated bridge validates Discord attachment/channel identity and sends
source metadata privately. The host downloads **once**, with public-IP DNS
pinning, an exact Discord CDN allowlist, no redirects, and declared-size checks.
Signed CDN URLs never enter prompts, history, logs, release assets or Git.
No untrusted document parser runs on the host in this intake path.

Original bytes and filenames are AES-256-GCM encrypted at rest. The random key
is protected by Windows CurrentUser DPAPI with an attachment-specific purpose.
Ticket identity and content hash are authenticated as associated data; another
user/ticket cannot reopen the original by guessing its ID. Originals remain for
seven days across app/container restarts; expired blobs are cleaned on the next
store operation. Capacity is 512 MiB globally, 25 MiB/file, 50 MiB/request and
10 files/request; a full store preserves existing files rather than evicting them
silently. This is storage encryption, **not end-to-end encryption of Discord**.

The document image is prepared once from a stdin-only Dockerfile (no host build
context) with pinned Python dependencies and Debian Poppler/Tesseract packages.
It runs by immutable local image ID, without mounts, network, secrets or root
user code. Originals are restored under `/work/attachments/<hash>.<extension>`.
PDFs use full-page text extraction and Korean/English OCR of blank pages, not
just the first embedded image. Read in batches of 1-10 pages; OCR is bounded to
three pages per call and is not visual diagram interpretation. Parsing timeout
can be retried one page at a time without resending the file.

Restricted tickets get `attachment_list` / `attachment_read`, including
search-only users reading their own uploads. `isolated_python(attachment_id=...)`
opens the original with document libraries while maintaining PC isolation.
Fully authorized native-CLI tickets receive the initial extracted preview and
retention metadata; these restricted broker tools are not injected into their
native CLI. Do not claim full-document analysis from a partial preview.

Local administrators may select an existing WSL Docker engine through the
Discord plugin config field `sandboxWslDistribution` (distribution name only).
Empty/default uses Docker Desktop. The WSL launcher invokes the local Docker
daemon as root, but document/user processes remain UID 65534 in the constrained
container. This never changes distro users/groups, mounts host files, or repairs
Docker Desktop by deleting data. Engine selection is not exposed to Discord users.

Run `npm run test:discord-documents-installed` explicitly for live PDF/OCR tests.
`MR_ROBOT_TEST_WSL` selects an existing local WSL engine for the test;
`MR_ROBOT_TEST_PDF` optionally supplies a local regression PDF (contents are not
printed or committed). Synthetic tests require no model tokens.

Licenses: this repository's integration code is original. The optional image
locally installs [Poppler](https://poppler.freedesktop.org/) (GPL) and
[Tesseract](https://github.com/tesseract-ocr/tesseract) (Apache-2.0) as separate
executables, plus Python dependencies from `requirements.txt`; upstream notices
remain in their packages and `/usr/share/doc`. The Docker image and user PDFs
are not bundled in the installer or published to this repository.
