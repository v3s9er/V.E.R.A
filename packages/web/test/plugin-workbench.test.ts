import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [view, workbench, styles, runtime, runtimeStyles] = await Promise.all([
  readFile(new URL('../src/views/PluginsView.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/components/PluginWorkbench.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/components/PluginWorkbench.css', import.meta.url), 'utf8'),
  readFile(new URL('../src/components/RuntimeHookPanel.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/components/RuntimeHookPanel.css', import.meta.url), 'utf8'),
]);

assert.match(view, /<PluginWorkbench/);
assert.match(view, /plugin-workbench-trigger-/);
assert.match(view, /onClose=\{closeWorkbench\}/);
assert.match(workbench, /id === 'resource-archiver'/);
assert.match(workbench, /id === 'sslscan-auditor'/);
assert.match(workbench, /id === 'webcrypto-observer'/);
assert.match(workbench, /webcrypto-observer\.\$\{action\}/);
assert.doesNotMatch(workbench, /webcrypto-observer\.event/);
assert.match(workbench, /<RuntimeHookPanel/);
assert.match(workbench, /'har-only' \| 'direct-bounded'/);
assert.match(workbench, /maxCipherTests: mode === 'quick' \? 0 : 12/);
assert.match(workbench, /retries: 0/);
assert.match(workbench, /workspaceId,/);
assert.match(workbench, /authorizationConfirmed: true/);
assert.match(workbench, /HAR_UI_MAX_BYTES = 6 \* 1024 \* 1024/);
assert.match(workbench, /new Blob\(\[harText\]\)\.size > HAR_UI_MAX_BYTES/);
assert.doesNotMatch(workbench, /16 \* 1024 \* 1024/);
assert.match(workbench, /maxNetworkRequests: networkBudget/);
assert.match(workbench, /maxNetworkRequests: 0/);
assert.match(workbench, /<option value=\{20\}>20회/);
assert.match(workbench, /<option value=\{40\}>40회/);
assert.match(workbench, /<option value=\{80\}>80회/);
assert.match(workbench, /overallTimeoutMs: ARCHIVE_OVERALL_TIMEOUT_MS/);
assert.match(workbench, /ARCHIVE_OVERALL_TIMEOUT_MS = 60_000/);
assert.match(workbench, /formRevisionRef/);
assert.match(workbench, /authorizationRef/);
assert.match(workbench, /workspaceIdRef/);
assert.match(workbench, /operationActiveRef/);
assert.match(workbench, /formRevisionRef\.current === prepared\.revision/);
assert.match(workbench, /workspaceIdRef\.current === prepared\.workspaceId/);
assert.match(workbench, /if \(!isPreparedCurrent\(prepared\)\)/);
assert.match(workbench, /params: prepared\.request, workspaceId: prepared\.workspaceId/);
assert.match(workbench, /disabled=\{formLocked\}/);
assert.match(workbench, /pending\.request\.pageUrl/);
assert.match(workbench, /pending\.workspaceName/);
assert.match(workbench, /pending\.workspacePath/);
assert.match(workbench, /pending\.request\.limits\.maxNetworkRequests/);
assert.match(workbench, /pending\.request\.allowedCrossOriginHosts\.join/);
assert.match(workbench, /pending\.request\.fetchMissing/);
assert.match(workbench, /pending\.request\.outputPath/);
assert.match(workbench, /root\.networkRequestLimit/);
assert.match(workbench, /trafficProfile\?\.requestsUsed/);
assert.doesNotMatch(workbench, /root\.estimatedNetworkRequests/);
assert.match(workbench, /resource-archiver\.progress/);
assert.match(workbench, /sslscan-auditor\.progress/);
assert.match(workbench, /const off = client\.on/);
assert.match(workbench, /return \(\) => \{ off\(\)/);
assert.match(workbench, /operationActiveRef\.current/);
assert.match(workbench, /disabled=\{busy\}/);
assert.match(workbench, /event\.target\.closest\('input, textarea, select/);
assert.match(workbench, /BUILTIN_READ_COMMANDS/);
assert.match(workbench, /plugin\.builtin/);
assert.doesNotMatch(workbench, /filter\(\(command\) => \/\(\?:\^\|\\\.\)\(\?:status/);
assert.match(styles, /\.plugin-workbench-layout/);
assert.match(runtimeStyles, /\.runtime-safe-recommendations/);
assert.match(runtimeStyles, /@media \(max-width: 520px\)/);
assert.match(styles, /@media \(max-width: 520px\)/);

assert.match(runtime, /SOURCE_MAX_BYTES = 256 \* 1024/);
assert.match(runtime, /EVENT_RING_SIZE = 64/);
assert.match(runtime, /MUTATION_LITERAL_MAX_BYTES = 64/);
assert.match(runtime, /url\.protocol !== 'https:' /);
assert.match(runtime, /url\.port !== ''/);
assert.match(runtime, /durationMs: 10_000/);
assert.match(runtime, /maxRequests: 20/);
assert.match(runtime, /maxResponseBytes: 4 \* 1024 \* 1024/);
assert.match(runtime, /maxConcurrentRequests: 4/);
assert.match(runtime, /maxRingEvents: 64/);
assert.match(runtime, /maxRequestBodyBytes: 64 \* 1024/);
assert.match(runtime, /maxUploadBytes: 128 \* 1024/);
assert.match(runtime, /authorizationConfirmed: true, sourceText/);
assert.match(runtime, /allowStateChangingRequests: stateChangingEnabled/);
assert.match(runtime, /stateChangingRequestsConfirmed: stateChangingEnabled && stateChangingConfirmed/);
assert.match(runtime, /DELETE는 항상 차단/);
assert.match(runtime, /'events'/);
assert.match(runtime, /'limit-reached'/);
assert.match(runtime, /'failed'/);
assert.doesNotMatch(runtime, /setInterval/);
assert.match(runtime, /'stop'/);
assert.match(runtime, /'mutation\.set'/);
assert.match(runtime, /matchLiteral: selectedEvent\.preview/);
assert.match(runtime, /mutationConfirmed: true/);
assert.match(runtime, /mutationSourceBlocked/);
assert.match(runtime, /다음 literal 일치 1회/);
assert.match(runtime, /event\.elapsedMs/);
assert.match(runtime, /event\.byteLength/);
assert.match(runtime, /event\.mutationApplied/);
assert.match(runtime, /crypto\.subtle\.encrypt/);
assert.match(runtime, /crypto\.subtle\.decrypt/);
assert.match(runtime, /TextEncoder \/ TextDecoder/);
assert.match(runtime, /임의 라이브러리, DOM, 키보드 훅/);

console.log('PLUGIN WORKBENCH TEST PASSED · embedded panels, traffic budgets, approval, progress and fail-closed generic actions verified');
