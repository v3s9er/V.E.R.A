# V.E.R.A managed sandbox

The built-in `managed-sandbox` development plugin manages small, temporary Linux
Docker workspaces. Loading or enabling it does not start Docker, install WSL,
download an image, or create a container. The existing Docker CTF and Discord
sandbox plugins remain separate.

## Requirements and limits

An administrator must already have a working local Docker Linux engine and the
`python:3.12-slim` image. The plugin checks the saved Docker context, accepts only
a local named pipe or Unix socket, and pins that endpoint for the container's
lifetime. Remote TCP/SSH contexts are rejected. Image names and engine options
cannot be supplied by a model; the existing image is resolved to its immutable
image ID and images declaring volumes are rejected.

Docker Desktop's WSL 2 backend can provide the Docker engine. Plain WSL command
execution is **not** a sandbox and is never used as a fallback. No distribution,
daemon, privileged setting, or operating-system feature is installed or enabled.

Each host-authorized conversation/subagent and selected workspace gets a separate
container. The selected host workspace identifies the authorization scope only:
none of its files are mounted or copied. The only writable workspace is `/work`
inside the container. There is currently no host-file import/export API; code can
create small files from its input and return bounded text output.

| Resource | Fixed bound |
| --- | --- |
| Live/reserved workspaces | 4 per service; same-installation leftovers also checked |
| CPU / memory+swap / PIDs | 1 CPU / 512 MiB total / 64 |
| Writable `/work` / `/tmp` / shared memory / private watchdog | 128 / 32 / 8 / 1 MiB |
| Command / captured stdout+stderr | 16 KiB UTF-8 / 128 KiB raw bytes |
| Execution timeout | 1–120 seconds; default 30 |
| Container lifetime | 15 minutes from container start |

The image root is read-only; writable areas use bounded tmpfs. Container logs are
disabled. Network access, host mounts, Docker-socket mounts, device mounts,
additional capabilities, and privilege escalation are disabled. The daemon must
report memory/swap, CPU, PID and seccomp support. Default Docker seccomp remains
enabled. The container's fixed Python PID1 watchdog runs as UID 65533, while commands run as
UID 65534 with a fresh minimal environment. Code cannot signal the differently
owned watchdog using the dropped capabilities. A private `/guard` tmpfs owned by
UID 65533 holds a per-command deadline; it is armed before code can start. PID1
exits at the deadline even when the app or Docker CLI is no longer reachable,
ending all processes in this dedicated container. The host also enforces its
timeout and attempts exact-ID cleanup. The deadline is disarmed only after no
UID 65534 processes remain. If a command leaves background processes, the result
reports `backgroundProcesses:true`, the deadline remains armed, and a subsequent
command cannot extend their time. The absolute 15-minute lifetime always applies.

These controls are containment, not a separate-VM guarantee or a claim that
arbitrary malware is safe. Docker shares its engine kernel. Keep Docker and its
host updated, and do not put host credentials into sandbox commands. tmpfs data
is ephemeral, but the operating system can page memory; it is not a promise of
forensic erasure. The bounds cover sandbox writable data and output, not the
administrator's existing Docker image cache or Docker's own metadata.

## Commands and approval

The standard plugin RPC is `plugins.call` with the following registered command
names. AI tools use the same handlers and normal tool permission/confirmation
gate; native-provider transport may represent dots as underscores.

| Command | Parameters | Behavior |
| --- | --- | --- |
| `sandbox.status` | `{}` | Read-only CLI, local context, daemon, Linux/resource-limit and image readiness; scoped lifecycle state when a scope exists |
| `sandbox.prepare` | `{}` | Approved creation, or reuse of this scope's already verified running container |
| `sandbox.exec` | `{ "command": "python -c 'print(1 + 1)'", "timeoutSec": 30 }` | Approved execution in `/work`; no host flags, paths, image or network options |
| `sandbox.stop` | `{}` | Stop/remove this scope's container and discard its temporary files |
| `sandbox.remove` | `{}` | Same disposal semantics; repeated removal is harmless |

Mutations require a host-created `PluginExecutionContext` with `scopeKey`, an
absolute registered `workspaceRoot`, a non-read-only permission mode, and
`destructiveApproved`. These cannot be forged using command parameters. Disposal
requires a per-call prompt approval or an approved full/admin policy; a generic
workspace run capability alone is insufficient. Direct RPC scope identity must
be derived by the server from the authenticated caller and registered workspace,
never a caller-provided container ID. Status can report engine readiness without
a selected workspace.

`stop` and `remove` both discard files because tmpfs is lost when stopped. A
timeout, cancellation, output overflow, or broken execution transport also
attempts to remove the whole dedicated container, terminating that scope's
remaining processes. It never stops a shared or unrelated container. Ordinary
nonzero command exit is returned as `ok:false` without discarding the workspace.

All resources have a random name and installation/scope/nonce labels. Before
execution or removal the service checks the exact container ID and labels;
before execution it checks the effective isolation settings again. Cleanup never
uses arbitrary model-selected IDs, host paths, broad prune, or name-only deletion.
Concurrent execution in one scope is rejected; slot reservation precedes daemon
requests. The service does not adopt old containers merely because they match a
name or label. It counts its installation's old resources against the cap instead
of deleting them without a live ownership record.

When cleanup cannot be verified, results explicitly say `cleanup-pending` and
the slot is retained. A timed-out/aborted create keeps a quarantined reservation
for the maximum lifetime plus 30 seconds, preventing repeated uncertain creates.
A failed create is never followed by `start`. Container creation that completes
late may require an administrator's review; the plugin never claims cleanup that
it did not verify. Restarting V.E.R.A does not adopt such orphaned resources.

## Integration and verification

Server registration uses `createManagedSandboxPlugin()` from
`packages/agent/src/plugins/managed-sandbox.ts` and the normal built-in loader.
No new persistent user configuration or public protocol is required; only the
installation's random ownership label is stored in existing plugin storage.

Run deterministic tests without Docker or inference:

```powershell
node --import tsx --test packages/agent/test/managed-sandbox.test.ts
npx tsc --noEmit -p packages/agent/tsconfig.json
```

Tests cover constrained creation, idempotence, scope separation, malformed and
forged parameters, missing/remote engines, unsupported bounds, image volumes,
context changes, ownership/policy tampering, output/timeout/cancel cleanup,
concurrent slot admission and execution, cancellation during creation, orphan
capacity, plugin permission metadata, bounded transport capture, native-provider
tool bridging through the real permission executor, and watchdog arming. When
Python is available, a deterministic fake-clock/process-table fixture executes
the watchdog's actual Python source; it does not execute user code or access
real process tables. `VERA_TEST_PYTHON` may point to an existing Python executable;
an unavailable Python or Windows Store alias explicitly skips that one fixture.

The initial 0.7.1 validation used fake transport because the local Docker engine
was unavailable; those tests alone did not establish actual kernel enforcement.
For 0.7.2, an explicitly prepared Docker Linux engine 29.7.2 passed the live
acceptance test below, including independently verified container cleanup. The
official `python:3.12-slim` image was downloaded during approved operator setup,
not by the plugin (digest
`sha256:02108f5d322dd89f1c9e552442c25acb0543dfdbc455693a5599624f20d9155d`).
This result covers the real plugin handlers and Docker execution path; it is not
a claim of arbitrary-code safety or successful tests on every host/backend.

An opt-in installed-engine acceptance test is now provided:

```powershell
$env:VERA_TEST_MANAGED_SANDBOX_LIVE = '1'
try {
  node --import tsx --test packages/agent/test/managed-sandbox-installed.test.ts
} finally {
  Remove-Item Env:VERA_TEST_MANAGED_SANDBOX_LIVE
}
```

Without that opt-in the test skips before contacting Docker or creating any
fixture. With it, the existing engine and image are mandatory; missing readiness
is a failure, not a silently skipped success. The test uses the real plugin
command handlers and actual Docker transport, with a fresh temporary host scope
directory (never mounted), random ownership label, and two isolated conversations.
It checks retained workspace state, cross-conversation separation, UID/capabilities,
seccomp, read-only root, tmpfs, effective cgroup quotas, denied external networking,
timeout, output overflow, cancellation and the independent background watchdog.
Finally it disposes only its tracked containers and independently verifies that
none with its fresh owner label remain. It never starts or repairs Docker, pulls
images, modifies existing containers, or prunes the daemon. A failing host startup
must be resolved separately; fixture code must not weaken the sandbox to bypass it.

## Primary references

- [Docker container resource and privilege controls](https://docs.docker.com/engine/containers/run/)
- [Docker tmpfs limits and lifecycle](https://docs.docker.com/engine/storage/tmpfs/)
- [Docker Engine security model](https://docs.docker.com/engine/security/)
- [Docker Desktop WSL 2 backend and security](https://docs.docker.com/desktop/features/wsl/)
- [Docker Engine API field definitions](https://docs.docker.com/reference/api/engine/version/v1.51/)
