# Discord Agent plugin

The optional first-party plugin connects an existing local Vesper/security bot
to the normal Mr.Robot agent. It imports the existing `bot.client` implementation
and runs its original `main.py`: news polling, duplicate storage, tray and KTX GUI
remain local and are not copied into the public repository.

## Setup

1. Install the existing bot's Python requirements (including discord.py 2.6+).
2. Close the standalone bot to avoid its single-instance lock.
3. Enable **Discord Agent** in Mr.Robot Plugins; supply the bot source directory
   and the absolute Python executable path, then choose **Save & Connect**.
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

- Only administrators of the locally registered Discord server are accepted.
  Live server membership and Administrator roles are checked on every request;
  application ownership alone and Manage Guild do not grant access. DMs fail closed.
- No public listener, router port or tunnel. Message Content Intent is needed for plain chat.
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
- Disabling/stopping the plugin also stops the managed existing bot. Launch the
  original bot separately if you want news/KTX without the agent integration.
- Runtime config, bot tokens, IDs, logs, databases and local absolute paths are
  intentionally not distributed. This generic adapter is the only bundled source.

Use is subject to Discord and model-provider terms. Python and the existing bot
are external local dependencies, not embedded in the Windows installer.
