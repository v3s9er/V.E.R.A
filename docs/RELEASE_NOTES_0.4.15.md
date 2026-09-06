# 0.4.15 — Discord ticket authority separation

allow_ai authorizes ticket use, not PC administration. Default members get a
capability-limited public-web/artifact broker, not a native PC agent. Administrators
can set each user's policy with `/robot user-access` and keep existing model caps.
Default administrators retain full access; explicit user restrictions override it.

The isolated broker has no host files, native CLIs, private memories, desktop,
generic plugins or MCP. Only artifacts generated in that ticket are downloadable.
Full and isolated conversations/results use separate namespaces, including after
role changes. Live role checks reject policy forgery, and changed roles suppress
final delivery and cancel running work on the next bounded permission check.

Public fetch reuses the project's DNS-pinned SSRF protections. Python execution
is optional, offline, unprivileged Docker with no host mounts; it never falls back
to host execution. Docker and its fixed Python image must be owner-provisioned.
Isolated members need an API provider; a CLI-only installation fails closed and
explains that requirement. This intentionally does not install paid API access.

Tests cover non-admin allow_ai admission, policy management rejection, cross-user
policies, restricted host routing, unknown tool invocation, local/private URL
denial, ticket artifact boundaries and native CLI denial. Mock Discord delivery
and authorization suites pass; no real user file was sent to a Discord channel.
Real Docker execution and live member-role interaction require deployment checks.
Containers cannot guarantee immunity to all host/kernel vulnerabilities. Discord
attachments are not end-to-end encrypted.
