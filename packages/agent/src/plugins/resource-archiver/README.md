# Authorized Web Resource Archiver

This is an original Mr.Robot implementation for preserving pages that the user owns or is explicitly allowed to archive. No source code from a browser extension was consulted or copied.

## Inputs and output

`resource-archiver.archive` accepts a direct `pageUrl`, browser/CDP response bodies in `capturedResources`, HAR 1.2-shaped `log.entries`, or any combination. Captured/cache response bodies are always reused first; network retrieval is off unless `fetchMissing: true` is explicitly supplied. It writes one ZIP beneath the host-selected workspace. The ZIP contains:

- bounded HTML/CSS dependency-graph resources;
- locally rewritten HTML/CSS links when the referenced body was saved;
- SHA-256 integrity data and binary-body deduplication;
- a redacted original-URL-to-local-path manifest, graph edges, failures, and attempt counts;
- partial results when individual resources fail.

The command requires `authorizationConfirmed: true`, the normal destructive-tool approval, and a selected workspace. Existing files are never overwritten.

`resource-archiver.preview` is a side-effect-free dry run for UI integration. It reports supplied/unique/body counts, decoded bytes, discovered references, missing bodies, a known-request estimate, the independently enforced network-request hard cap, allowed hosts, effective limits, and warnings. The archive command publishes bounded `resource-archiver.progress` phase events and returns a compact `complete`/`partial` result; the full failure list remains in the ZIP manifest.

## Security boundaries

- HTTP(S) GET only for network retrieval; captured non-GET responses are never replayed.
- No caller-supplied Cookie, Authorization, Referer, proxy, or general request headers.
- URL userinfo is rejected and sensitive query values are redacted from the manifest.
- Exact cross-origin allowlist, public DNS only, all DNS answers validated, and the chosen address pinned into the socket lookup.
- Per-run validated DNS pin reuse reduces repeated lookups without permitting rebinding; redirects are checked again before using a separately pinned host.
- Every physical HTTP GET start—including redirects and retries—consumes a shared hard cap (default 40, absolute maximum 500). The result records actual usage.
- A whole-run server deadline (default 60 seconds, maximum 300 seconds) is combined with caller cancellation; per-request timeouts still apply independently.
- Every redirect is revalidated; local, link-local, private, multicast, documentation, and reserved IP ranges are rejected.
- Standard ports only, TLS verification left enabled, decoded-body streaming limits, timeouts, retry and redirect caps.
- Resource-count, recursion-depth, concurrency, per-resource, and aggregate decoded-size limits. Conservative defaults are 200 resources, depth 2, concurrency 2, 8 MiB per response, 32 MiB total, at least 150 ms between request starts, and no retry unless explicitly requested.
- Only one archive run may be active per plugin instance, preventing simultaneous UI/AI calls from multiplying network traffic.
- Archive paths sanitize traversal characters and Windows device names. Output is confined under the trusted workspace and created without overwrite.
- HAR request headers/cookies/post bodies are ignored; response headers use a small non-secret allowlist.

## Clean-room feature baseline

Only public product descriptions and official platform documentation were used to understand the problem space:

- Chrome Web Store, Save All Resources listing: <https://chromewebstore.google.com/detail/save-all-resources/abpdnfjocnmdomablahdcfnoggeeiedb>
- Chrome Extensions `devtools.network`: <https://developer.chrome.com/docs/extensions/reference/api/devtools/network>
- Chrome Extensions `debugger`: <https://developer.chrome.com/docs/extensions/reference/api/debugger>
- Chrome DevTools Protocol, Network domain: <https://chromedevtools.github.io/devtools-protocol/tot/Network/>
- Chrome DevTools Protocol, Page domain (`captureSnapshot`): <https://chromedevtools.github.io/devtools-protocol/tot/Page/>

The Web Store listing describes one-click collection into a ZIP while retaining folder structure, optional beautification, XHR/body handling, and explicitly says it is a resource collector rather than a locally runnable website downloader. This plugin uses that description only as a behavioral comparison point and adds direct URL mode, supplied browser/HAR mode, recursive HTML/CSS asset graphs, offline rewriting, content hashes, deduplication, partial-failure reporting, retries, and host-side safety controls.
