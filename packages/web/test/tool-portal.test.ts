import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [entry, app, portal, client, contract, settings, settingsView, styles, runtime, runtimeStyles] = await Promise.all([
  readFile(new URL('../src/main.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/App.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/ToolPortal.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/tool-portal-client.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/tool-portal-contract.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/components/ToolPortalSettings.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/views/SettingsView.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/ToolPortal.css', import.meta.url), 'utf8'),
  readFile(new URL('../src/components/RuntimeHookPanel.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../src/components/RuntimeHookPanel.css', import.meta.url), 'utf8'),
]);

assert.match(entry, /parseToolPortalPath\(window\.location\.pathname\)/);
assert.match(entry, /await import\('\.\/ToolPortal'\)/);
assert.match(entry, /await import\('\.\/App'\)/);
assert.doesNotMatch(entry, /import \{ App \} from '\.\/App'/);
assert.doesNotMatch(app, /ToolPortal|tool-portal-client/);
assert.match(contract, /resource-archiver\|sslscan\|runtime-hook/);
assert.match(contract, /webcrypto-observer/);
assert.match(contract, /'mutation\.set'/);
assert.ok(contract.includes('/^\\/tools\\/(resource-archiver|sslscan|runtime-hook)\\/?$/'));

assert.match(client, /credentials: 'same-origin'/);
assert.match(client, /mode: 'same-origin'/);
assert.match(client, /cache: 'no-store'/);
assert.match(client, /redirect: 'error'/);
assert.match(client, /referrerPolicy: 'no-referrer'/);
assert.match(client, /MAX_PORTAL_RESPONSE_BYTES = 1024 \* 1024/);
assert.match(client, /ALLOWED_ACTIONS/);
assert.match(client, /new Set\(\['validate', 'preview', 'archive'\]\)/);
assert.match(client, /new Set\(\['status', 'analyze', 'observe', 'events', 'mutation\.set', 'stop'\]\)/);
assert.match(client, /downloadArtifact/);
assert.match(client, /\/api\/tool-portal\/artifacts\/\$\{encodeURIComponent\(artifactToken\)\}/);
assert.match(client, /contentType !== 'application\/zip'/);
assert.match(client, /cache-control/);
assert.match(client, /MAX_PORTAL_ARTIFACT_BYTES/);
assert.match(client, /received > MAX_PORTAL_ARTIFACT_BYTES/);
assert.match(client, /504b0304/);
assert.match(client, /504b0506/);
assert.match(client, /class ToolPortalHttpError extends Error/);
assert.match(client, /response\.status === 401/);
assert.match(client, /this\.onUnauthorized\?\.\(\)/);
assert.match(client, /AbortSignal\.timeout/);
assert.match(client, /AbortSignal\.any/);
assert.match(client, /abortAll\(/);
assert.match(client, /background\?: boolean/);
assert.match(client, /foregroundRequests/);
assert.doesNotMatch(client, /localStorage|WebSocket|x-mr-robot-token/i);
assert.match(client, /window\.sessionStorage/);
assert.match(client, /TOOL_PORTAL_REQUEST_PROOF_HEADER/);
assert.match(client, /forgetSessionProof/);

assert.match(portal, /PORTAL_HAR_MAX_BYTES = 512 \* 1024/);
assert.match(portal, /maxNetworkRequests: networkRequestLimit/);
assert.match(portal, /requestParams\(0\)/);
assert.match(portal, /requestParams\(20\)/);
assert.match(portal, /api\.call<unknown>\('resource-archiver', 'archive'/);
assert.match(portal, /api\.downloadArtifact\(artifact\.artifactToken, \{ timeoutMs: 30_000 \}\)/);
assert.match(portal, /URL\.revokeObjectURL\(objectUrl\), 60_000/);
assert.match(portal, /mutationGloballyEnabled=\{session\.hookMutationEnabled === true\}/);
assert.match(portal, /setArtifact\(null\)/);
assert.match(portal, /status: 'ready-for-download'/);
assert.match(portal, /key !== 'artifactToken' && key !== 'outputPath'/);
assert.doesNotMatch(portal, /localStorage|sessionStorage|WebSocket/);
assert.match(portal, /autoComplete="off"/);
assert.match(portal, /window\.history\.replaceState/);
assert.match(portal, /setAuthorized\(false\); setArchiveConfirmed\(false\)/);
assert.match(portal, /setAuthorized\(false\); setPending\(false\)/);
assert.match(portal, /invalidateScopeApproval/);
assert.match(portal, /activeRequests > 0/);
assert.match(portal, /runtimeRunning/);
assert.match(portal, /api\.abortAll/);
assert.match(portal, /session\.expiresAt - Date\.now\(\)/);
assert.match(portal, /포털 세션이 만료되었습니다/);
assert.match(portal, /session === null/);
assert.match(portal, /도구 포털을 확인하지 못했습니다/);
assert.match(portal, /timeoutMs\?: number/);

assert.match(settings, /toolPortal\.status|TOOL_PORTAL_RPC\.status/);
assert.match(settings, /TOOL_PORTAL_RPC\.configure/);
assert.match(settings, /TOOL_PORTAL_RPC\.disable/);
assert.match(settings, /allowedDomains/);
assert.match(settings, /workspaceId/);
assert.match(settings, /hookMutationEnabled/);
assert.match(settings, /상태 변경 요청과 일회성 런타임 literal 변경 허용/);
assert.match(settings, /POST·PUT·PATCH/);
assert.match(settings, /loadState/);
assert.match(settings, /loadState !== 'ready'/);
assert.match(settings, /설정 다시 불러오기/);
assert.match(settings, /setPassword\(''\); setPasswordConfirm\(''\)/);
assert.match(settings, /generationRef/);
assert.match(settings, /generation !== generationRef\.current/);
assert.match(settings, /autoComplete="off"/);
assert.match(settings, /new TextEncoder\(\)\.encode\(value\)\.byteLength/);
assert.match(settings, /passwordBytes >= 12 && passwordBytes <= 256/);
assert.match(settings, /UTF-8 \{passwordBytes\}\/256B/);
assert.match(settings, /!passwordReady/);
assert.doesNotMatch(settings, /maxLength=\{256\}/);
assert.match(settingsView, /Boolean\(window\.mrRobotDesktop\)/);
assert.match(settingsView, /nativePortalAdmin && section === 'portal'/);
assert.match(styles, /@media \(max-width: 900px\)/);
assert.match(styles, /@media \(max-width: 620px\)/);

assert.match(runtime, /scrubPlaintextState/);
assert.match(runtime, /delete event\.preview|preview: _preview/);
assert.match(runtime, /activeSessionIdRef/);
assert.match(runtime, /transport\.call\('stop'/);
assert.match(runtime, /setAuthorized\(false\); setPlaintextConfirmed\(false\); setStateChangingConfirmed\(false\)/);
assert.match(runtime, /setMutationConfirmed\(false\); setReplacementLiteral\(''\)/);
assert.match(runtime, /runtime-plaintext-preview/);
assert.match(runtime, /spellCheck=\{false\} autoComplete="off" autoCapitalize="none" autoCorrect="off"/);
assert.match(runtime, /typeof target\.url === 'string'/);
assert.match(runtime, /typeof active\.eventCount === 'number'/);
assert.match(runtime, /payload\.truncated === true/);
assert.match(runtime, /reasonCode/);
assert.match(runtime, /안전 한도에 도달해 관찰 세션을 종료했습니다/);
assert.match(runtime, /if \(!mountedRef\.current\) \{/);
assert.match(runtime, /new TextEncoder\(\)\.encode\(value\)\.byteLength/);
assert.match(runtime, /replacementBytes >= 1 && replacementBytes <= MUTATION_LITERAL_MAX_BYTES/);
assert.match(runtime, /UTF-8 \{replacementBytes\}\/64B/);
assert.match(runtime, /setMutationPhase\(event\.phase === 'decrypt-output'/);
assert.match(runtime, /mutationSourceBlocked \|\| !replacementValid/);
assert.doesNotMatch(runtime, /setReplacementLiteral\(event\.target\.value\.slice/);
assert.doesNotMatch(runtime, /selectedCandidateId|setSelectedCandidateId/);
assert.match(runtime, /오프라인 탐지 후보/);
assert.match(runtime, /실행 계측은 후보 선택과 무관하게 WebCrypto 고정 범위/);
assert.match(runtime, /<article key=.*role="listitem"/);
assert.match(runtimeStyles, /\.runtime-candidates article/);
assert.doesNotMatch(runtimeStyles, /\.runtime-candidates button/);

console.log('TOOL PORTAL TEST PASSED · direct routes, cookie + origin-scoped request-proof client, bounded archive download, native admin settings and responsive UI verified');
