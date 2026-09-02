# SSL/TLS Inspector plugin

This is an independent Mr.Robot implementation. It neither embeds, invokes,
links to, nor depends on `rbsec/sslscan`; no source code was copied. The
official binary is used only outside the repository as a comparison oracle.

## Safety and operating contract

- Every call must set `authorizationConfirmed: true` and pass Mr.Robot's
  per-run approval gate.
- One host and one allowlisted TLS port are accepted per call. URLs, target
  files, ranges, and batches are rejected.
- DNS A/AAAA results are resolved once, checked, and pinned before connecting.
  If any answer is private, loopback, link-local, documentation, multicast, or
  another blocked special-use address, the request fails closed by default.
- The default `quick` mode sends only four bounded version handshakes (TLS 1.0
  through TLS 1.3) and uses them for certificate/negotiation evidence. It sends
  no individual cipher probes.
- `standard` is an explicit opt-in to 16 representative TLS 1.2 cipher probes
  (hard cap 24). `deep` is an explicit opt-in to all relevant ciphers exposed
  by the bundled Node/OpenSSL engine (hard cap 96).
- Default active-scan concurrency is 1. Cipher probes are sequential except in
  explicit `deep` mode, where at most 2 run concurrently. Per-host starts are
  rate-limited, socket/overall timeouts are bounded, and `AbortSignal` cancels
  live sockets.
- Identical pinned results are cached for five minutes by default. Progress is
  emitted as `sslscan-auditor.progress`, and `sslscan.status({ scanId })`
  returns a result-friendly progress record.
- Private-target support exists only as a trusted construction-time option for
  isolated tests; the bundled plugin does not enable it.

## Commands

- `sslscan.status` — engine, limits, cache count, and optional scan status.
- `sslscan.scan` — active, approved scan with `quick | standard | deep` modes.

Results are versioned JSON and include scan/cache metadata, pinned resolution,
protocol conclusions, negotiated TLS facts, leaf and bounded-chain certificate
summaries, accepted bounded cipher probes, findings, and explicit limitations.

## Comparison with official sslscan

Official primary references consulted for behavior only:

- <https://github.com/rbsec/sslscan>
- <https://github.com/rbsec/sslscan/blob/master/README.md>
- <https://github.com/rbsec/sslscan/blob/master/sslscan.1>
- <https://github.com/rbsec/sslscan/releases/tag/2.2.2>

The official documentation describes protocol/cipher enumeration, certificate
checks, key-exchange groups, signature algorithms, XML output, Heartbleed,
fallback SCSV, compression and renegotiation checks, plus multiple STARTTLS and
protocol preambles. Those claims are not inferred from or reproduced from its
source implementation.

### Isolated local comparison run (2026-09-02 KST)

The comparison test created an ephemeral loopback TLS server with a temporary
`CN=localhost` certificate. The server allowed only TLS 1.2/TLS 1.3 and two
TLS 1.2 suites. Private-target access was enabled only on the directly
constructed test scanner; it is not enabled on the bundled plugin.

Reference artifact (kept outside this repository): official release 2.2.2
Windows 64-bit (MinGW), OpenSSL 3.5.4, executable SHA-256
`771AC9E7966337DAE63C79B7783D6D12DF7446F394E6588D4E87A5D30A384BA9`.
The Mr.Robot run used Node v24.19.0 / OpenSSL 3.5.7.

| Evidence | Official sslscan 2.2.2 | Mr.Robot implementation | Comparison |
| --- | --- | --- | --- |
| Protocols | TLS 1.2, TLS 1.3 | TLS 1.2, TLS 1.3 | Exact match |
| Leaf subject | `/CN=localhost` | `CN=localhost` | Match |
| Hostname check | Certificate presented for SNI `localhost` | `hostnameValid: true` against SNI `localhost` | Match |
| TLS 1.2 suites | ECDHE-RSA AES-128-GCM and AES-256-GCM | Same two IANA suites | Exact match |
| TCP connections in this fixture | 80 | `quick`: 4; identical quick cache hit: 0; `deep`: 31 | Default quick used 95% fewer connections in this run |

The common IANA names were
`TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256` and
`TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384`. The test completed in under one
second on this machine. Connection counts were measured sequentially at the
local server, so each phase was attributable; they are traffic evidence for
this fixture, not a universal performance claim. A valid five-minute cache hit
uses no new TLS/TCP connection (DNS is still re-resolved and policy-checked).
The official executable, PFX, and private key remained outside the repository
and are not runtime or build dependencies.

### Honest feature boundary

Official `sslscan` remains broader for legacy SSL, exhaustive TLS 1.3 suites,
groups/signature enumeration, STARTTLS/RDP/MySQL/PostgreSQL setup, and active
Heartbleed/fallback/renegotiation/compression probes. Mr.Robot's advantages are
operational: structured JSON, normalized policy findings, explicit
inconclusive results, certificate-chain objects, host/port authorization
policy, SSRF-resistant address pinning, low-traffic modes, rate/concurrency
limits, cancellation, cache, progress events, and native plugin integration.

The optional comparison test is
`packages/agent/test/sslscan/compare-reference.test.ts`. It runs only when a
reference binary and a temporary local TLS PFX are explicitly supplied through
`SSLSCAN_REFERENCE_BINARY`, `SSLSCAN_TEST_PFX`, and
`SSLSCAN_TEST_PFX_PASSWORD`; normal builds neither download nor execute
`sslscan`.
