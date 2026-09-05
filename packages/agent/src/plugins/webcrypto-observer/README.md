# Authorized WebCrypto Observer

`webcrypto-observer` is a clean-room Mr.Robot built-in for a narrow, authorized diagnostic workflow. It recommends where plaintext may cross the WebCrypto boundary without reading keys, DOM fields, keyboard input, cookies, browser storage, or response bodies.

## Host integration contract

Active observation is fail-closed unless the native host constructs the plugin with a policy provider. Command parameters cannot supply or widen this policy.

```ts
createWebCryptoObserverPlugin({
  policyProvider: {
    getPolicy: () => ({
      enabled: true,
      allowedDomains: ['app.example.com'], // exact names; no wildcard/suffix matching
      browserExecutable: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', // optional
    }),
  },
});
```

`WebCryptoObserverHostPolicyProvider.getPolicy()` may be asynchronous. Missing, disabled, empty, wildcard, URL-shaped, or invalid allowlists deny `observe`. The target must be one `https:` URL on default port 443 whose normalized DNS name exactly equals an allowlist entry. Every A/AAAA answer is validated as public; one validated address is pinned into Chromium with `--host-resolver-rules`, followed by `MAP * ~NOTFOUND` so Chromium cannot re-resolve or contact another host.

The optional `browserExecutable` is also native-host policy. A command request can never choose a process path or browser profile.

## Commands

- `webcrypto-observer.status({ sessionId? })` returns `{ ok, engine, policy, activeSessions, limits, privacy, session? }`; policy and session values are sanitized and never expose the allowlist entries, pinned IP, or unredacted query values.
- `webcrypto-observer.analyze({ authorizationConfirmed: true, sourceText })` statically scans at most 256 KiB. It never calls `eval`, `Function`, dynamic import, a parser plugin, or the network. The result contains only `{ truncated, candidates }`; each candidate has an operation, API name, line/column, and confidence—not source fragments, hashes, or plaintext.
- `webcrypto-observer.observe({ ... })` starts one bounded session and returns immediately after the isolated page begins navigation:

  ```ts
  {
    authorizationConfirmed: true,
    sessionEnabled: true,
    targetUrl: 'https://app.example.com/path',
    plaintextPreview?: { enabled: true, previewConfirmed: true, maxBytes?: 64 },
    allowStateChangingRequests?: true,
    stateChangingRequestsConfirmed?: true,
    limits?: {
      durationMs?: 10000,
      maxRequests?: 20,
      maxResponseBytes?: 4194304,
      maxConcurrentRequests?: 4,
      maxRingEvents?: 64,
      maxRequestBodyBytes?: 65536,
      maxUploadBytes?: 131072,
    },
  }
  ```

  Response: `{ sessionId, status: 'running', startedAt, expiresAt, target, metadataOnly, limits }`. Target query values are redacted.
- `webcrypto-observer.events({ sessionId, afterSequence? })` polls the bounded ring buffer and returns `{ sessionId, status, afterSequence, nextSequence, truncated, events, traffic, mutation, reasonCode? }`. Each event is `{ sequence, elapsedMs, operation, phase, algorithm, byteLength, mutationApplied, recommendation, preview?, previewTruncated? }`.
- `webcrypto-observer.mutation.set({ sessionId, phase, matchLiteral, replacementLiteral, mutationConfirmed: true })` arms one exact UTF-8 literal replacement for the next matching `encrypt-input` or `decrypt-output` and returns `{ sessionId, armed: true, phase }`. The session must have plaintext preview enabled, and `matchLiteral` must exactly equal a non-truncated preview actually observed in that same session and phase. Match and replacement are each 1–64 UTF-8 bytes, and regex or arbitrary JavaScript is not accepted. Only one rule can ever be armed in a session.
- `webcrypto-observer.stop({ sessionId })` is idempotent, returns `{ sessionId, stopped, status }`, closes the page/browser, and removes the temporary profile.

Active commands require a host-created local-admin execution context or the exact host-only `portalCapability: 'webcrypto-observer'`; params cannot forge that capability. They also retain the normal read-only and destructive-approval gates. No workspace is required because no user file is created.

## Runtime safety boundary

- Metadata-only is the default: operation, boundary phase, algorithm name, byte length, elapsed time, and mutation-applied boolean.
- Plaintext preview requires two per-session booleans, is capped at 128 source bytes, stays only in the in-memory ring buffer, is never emitted on the event bus/logger/storage, and is scrubbed when the session ends.
- Mutation cannot be derived from pasted source or an arbitrary caller value. It is accepted only when the exact phase/literal pair already exists as an untruncated plaintext-preview event in the active session, and it is consumed after the next byte match.
- A fresh OS temporary `--user-data-dir` is used. The normal Chrome profile and its cookies are never opened or imported. The profile is removed after stop/failure/timeout.
- Navigation is issued over loopback CDP after instrumentation and policy interception are installed. The raw target URL is not placed on the process command line.
- Only the exact target origin is reachable. Cross-origin requests, source maps, downloads, non-HTTPS traffic, and `DELETE` are blocked.
- Default methods are `GET`, `HEAD`, and `OPTIONS`. `POST`, `PUT`, and `PATCH` require both `allowStateChangingRequests` and `stateChangingRequestsConfirmed`; their bodies are never logged/stored and remain under per-request and aggregate byte caps.
- The shared request counter includes same-origin redirects before they are continued. Concurrent Content-Length reservations are checked before response continuation when present; the conservative maximum of streamed decoded/encoded bytes is observed and the page/session is stopped at the byte cap.
- Dedicated/shared workers, worklets, popups, service workers, WebSocket, EventSource, WebTransport, `sendBeacon`, and WebRTC are disabled. CDP auto-attach pauses and closes auxiliary targets before they can run.
- There is no recursive crawl, source-map loading, DevTools Debugger use, keyboard/mouse automation, password-field access, response-body retrieval, screenshot, or key extraction.
- Only one session runs at once. The low-traffic defaults are 10 seconds, 20 physical requests, concurrency 4, a 4 MiB response budget, and 64 ring events. Independently, all inbound CDP traffic fails closed at 4,096 frames or 8 MiB per session, each frame remains capped at 256 KiB, and `Runtime.bindingCalled` is capped at 513 attempts (one mandatory safety-ready control plus at most 512 runtime events). Duration, request count, response/upload bytes, concurrent requests, binding payload, and ring events also have hard maximums.

## Deliberate limitations

The injected blockers, mutation channel, and WebCrypto wrappers are locked non-configurable in the disposable page realm; if that lock cannot be established, startup fails closed. The observer cannot cover crypto performed in blocked workers or native modules and may change timing-sensitive applications. It observes only `SubtleCrypto.encrypt` input and successful `SubtleCrypto.decrypt` output in the isolated page. Negative results do not prove plaintext is absent. The tool is for owned or explicitly authorized targets only.
