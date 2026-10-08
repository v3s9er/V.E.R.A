# V.E.R.A 0.8.0 validation

Validation date: 2026-10-08. This is an integration/regression report, not a model leaderboard result.

| Check | Result and scope |
| --- | --- |
| Agent, web and mobile TypeScript | Passed |
| `npm test` release gate | Passed end-to-end, including build, default tests and post-test suites |
| `npm run test:harness` | 73 tests passed: one execution owner, source-bound retrieval, candidate approval/retraction, actual verification, host RPC and persistence |
| Actual Electron application | Passed with a fresh isolated profile and deterministic loopback SSE provider: 13 fixture calls, no account-backed inference |
| Application workflow | Retrieval, candidate creation, rejection of model-side approval, explicit UI approval, reuse, actual Node command/JSON receipts, restart of the same conversation and retraction |
| Harness responsive UI | Passed at 1280px and 390px |
| Existing live UI suite | Passed, including drafts, pending settings, cancellation, navigation, model picker, calendar and sidebar |
| Runtime/project regression | 38 passed, 1 skipped; the skipped platform-dependent test is not claimed as verified |
| Discord assignment and file transfer | Existing policy, assigned model/effort and encrypted transfer regression checks passed; no messages sent to a real Discord ticket |
| Optional installed MCPs | Context7 4.2.0 resolved public documentation; Serena 1.7.0 read symbols from generated Python source. Cold language-server setup was included; no private project was indexed |
| Installed Windows application | Version 0.8.0 and agent/web payload hashes matched the validated stage |
| Existing data | Conversations, providers, project and user policies preserved; expected Discord internal connection rotation was distinguished from policy changes |
| Public-source hygiene | Runtime state, protected credentials and known token-format checks passed; private reports and installed upstream tools excluded |

The retained legacy Council tests now assert that old preset graphs do not launch model members or judges. Standalone legacy utility tests remain. Two timing-sensitive test assertions were made deterministic without weakening cancellation or retry checks.

Reproduce the synthetic actual-app check after `npm run stage:desktop`:

```sh
node scripts/tests/harness-app.smoke.mjs --app-path packages/desktop/.stage --expected-version 0.8.0 --run yes
```

The script checks the stage identity, uses a fresh temporary profile and workspace, and removes only its owned temporary state after confirmed process exit. It never uses the installed user's model provider. The native CLI session/host-tool checks use protocol fixtures; they are not live Codex/Claude account measurements.

No real-model accuracy, token-price savings or superiority to standalone Codex/Claude has been established by this release validation. ARTEX is not integrated. The Windows installer is unsigned; Android UI source is updated but no new APK is included in this release.
