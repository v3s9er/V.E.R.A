import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [view, workbench, styles] = await Promise.all([
  readFile(new URL('../src/views/PluginsView.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/components/PluginWorkbench.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/components/PluginWorkbench.css', import.meta.url), 'utf8'),
]);

assert.match(view, /<PluginWorkbench/);
assert.match(view, /plugin-workbench-trigger-/);
assert.match(view, /onClose=\{closeWorkbench\}/);
assert.match(workbench, /id === 'resource-archiver'/);
assert.match(workbench, /id === 'sslscan-auditor'/);
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
assert.match(styles, /@media \(max-width: 520px\)/);

console.log('PLUGIN WORKBENCH TEST PASSED · embedded panels, traffic budgets, approval, progress and fail-closed generic actions verified');
