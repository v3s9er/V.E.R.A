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
`/robot stop`. The ask command optionally accepts provider ID, model and effort.
Changes requiring approval show owner-bound, expiring approval/deny buttons.
If approval delivery fails, the normal PC approval timeout denies the operation.

## Security and limits

- Only the Discord application owner (team owner for team apps) is accepted.
  Server admins and other members do not inherit PC authority.
- No public listener, router port, tunnel or message-content privileged intent.
- Replies and approval messages are ephemeral and disable mentions. Discord
  still processes this content: do not send credentials or sensitive documents.
- A fresh `ask`-capped device credential stays in the Node host, never in Python
  argv, bridge files, Discord, source or installer. Revocation cancels its runs.
- PC administrator settings cannot be changed through Discord. Adaptive budgets,
  existing provider authorization and normal approval policy remain active.
- One active request, up to 64 channel conversations, 10-minute execution wait,
  bounded pipe/results, and automatic cancellation on connection loss.
- Disabling/stopping the plugin also stops the managed existing bot. Launch the
  original bot separately if you want news/KTX without the agent integration.
- Runtime config, bot tokens, IDs, logs, databases and local absolute paths are
  intentionally not distributed. This generic adapter is the only bundled source.

Use is subject to Discord and model-provider terms. Python and the existing bot
are external local dependencies, not embedded in the Windows installer.
