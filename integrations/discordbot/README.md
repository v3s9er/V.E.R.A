# Discord Agent plugin

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
The existing administrator-only bot usage policy is unchanged. Administrators
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

- Only administrators of the locally registered Discord server are accepted.
  Live server membership and Administrator roles are checked on every request;
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
not deleted when the role is removed. Existing Administrator-only bot usage and
PC access/model-policy management remain unchanged: `allow_ai` is an additional
ticket condition, not permission to control a PC or a bypass for ordinary members.
