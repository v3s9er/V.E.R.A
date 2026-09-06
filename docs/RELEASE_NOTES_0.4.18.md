# 0.4.18 — Ticket recovery, fair execution and bounded reuse

## Fixes and behavior

- Gateway RESUME restores readiness in both standalone and legacy modes. A
  transient disconnect no longer permanently produces an administrator/DM error.
  Reconnection, guild registration and role denial have distinct messages.
- Fair per-user queue: at most two isolated Discord jobs run concurrently, one
  job per guild/user. Full-PC jobs run exclusively against other Discord jobs.
  Each execution has its own authenticated RPC socket/session, cancellation,
  approvals and progress. New ordinary messages queue; **지시 추가** or
  `/robot steer` explicitly adds instructions at the next safe boundary.
- Queued work survives gateway reconnect. In-flight work is cancelled, never
  automatically replayed because it may already have produced side effects.
- Public status/tool progress replaces the receipt while running; the final
  reply replaces that same message. No raw private reasoning is exposed. Late
  progress cannot overwrite the finished reply.
- Replies split on paragraph/newline boundaries with a UTF-16-safe size. Up to
  four preview messages plus the complete UTF-8 TXT for long answers. The host
  transport has a 384,000-character safety bound, with an explicit notice if hit.
- Steering arriving during the final non-tool model response is now consumed
  instead of silently discarded. This shared loop applies to desktop/mobile too.

## Efficiency and isolation

- Codex restricted workers reuse an ephemeral app-server process/thread only
  when conversation, provider, model, system/tool policy and complete history
  prefix match. Only new records are sent. Edits or policy changes rebuild the
  thread. Usage records the latest turn, not the cumulative thread total.
- Maximum four resident workers, 120-second idle expiry and 20 turns per worker;
  cancellation closes the affected process. Server shutdown closes all workers.
  Stored prefix fingerprints avoid retaining a second full history in the pool.
- Both thread/start and turn/start explicitly disable native environments. Loaded
  instruction sources must be empty; native tool items/server requests fail closed.
  Broker tools still enforce user capabilities. Subscription credentials stay local.
- Parsed excerpts cache by guild/user/ticket, content SHA-256 and filename/parser
  version, not across users. Maximum 4 MiB serialized entries, 32 entries, five-minute
  expiry with an active sweep. Originals are still temporary and each download,
  cancellation and authority check remains in place. This saves parsing/OCR work,
  not automatically the model's cost of consuming new document text.
- Claude subscription-login preflight may be reused for 30 seconds; actual model
  authentication still occurs on every call. No automatic paid-API fallback.

## Validation and limits

Synthetic tests exercise two-user overlap, full-PC exclusivity, same-user ordering,
reconnect queue preservation, targeted cancellation and model/permission isolation.
Mock app-server tests verify incremental input, per-turn token accounting, policy
invalidation, native-tool rejection and cancellation without spending model tokens.
The installed Codex executable was checked against a local mock provider and
advertised zero native tools in the no-environment configuration.
The production pooled transport also completed two successive turns through the
real installed CLI against a synthetic local Responses provider, with zero native
tools and latest-turn metering. No account/model tokens were spent by this test.

Validation completed: full npm regression suite (including desktop/mobile UI and
privacy contracts), TypeScript checks, Discord/isolated worker tests, 65 Python
tests, remote encrypted-file/model-policy tests and public-source hygiene scan.
Repeated plugin/connection/stream memory tests found no sustained leak in the
tested workload (600 plugin operations, 80 connections, 20 stream cycles).

Desktop 0.4.18 was installed and restarted locally. Installed ASAR and eight Python
sidecars were hash-compared with the build/source; local status reported 0.4.18 and
Discord readiness true. Android version metadata is aligned to 0.4.18 (code 23).
Release APK built successfully with the existing signing certificate verified;
the copied APK and original build output hashes match. APK UI changes are not
claimed in this release: this aligns packaging with the shared execution fixes.

This does not promise a fixed speedup or lower billed tokens on every request.
Provider latency and limits still apply. Reuse is currently for restricted Codex
workers, not full-PC native CLI sessions. Formats that cannot be decoded still
report partial/unreadable rather than inventing contents. Discord attachments
remain subject to Discord storage/size limits and are not end-to-end encrypted.

Protocol reference: https://learn.chatgpt.com/docs/app-server
