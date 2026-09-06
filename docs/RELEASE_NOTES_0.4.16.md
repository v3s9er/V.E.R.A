# 0.4.16 — Shared providers, separate Discord capabilities

Ordinary allow_ai members now follow the owner's registered providers and default
model, including subscription-backed Codex and Claude. The API-only limitation
in 0.4.15 is removed. Per-user model ceilings and administrator-only access-policy
management remain enforced.

Isolated subscriptions produce structured text and broker requests. They cannot
use native PC tools: Codex disables environments at both thread and turn start,
and Claude uses safe mode, no native tools, an empty strict MCP configuration and
a fresh scratch directory. Only the existing public-web/generated-artifact broker
handles requests. No full-access execution fallback or automatic API-key billing
is permitted. Missing owner login and unsupported CLI versions fail closed.

Verification covers the real installed Codex request boundary using a local mock
provider (zero native tools), subscription broker dispatch, generated artifact
export, forbidden tool requests, cross-ticket access, provider/default inheritance,
model ceilings and role-based policy changes. Discord Python authorization and
interaction regression tests pass. Live Codex subscription response was checked;
Claude live inference requires the owner's subscription login on this PC.

General-purpose Python computation still requires an owner-provisioned Docker
runtime/image and never runs on the host as a fallback. Discord attachments are
not E2EE. These controls do not constitute a guarantee against all vulnerabilities.
