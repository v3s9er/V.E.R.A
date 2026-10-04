// Real-app functional smoke, NOT a benchmark or model-quality score.
// Default: print a plan only. No app launch or inference without explicit consent.
import { createHash, randomBytes, randomInt } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { extractFile } from '@electron/asar';

const ROOT = resolve(import.meta.dirname, '../..');
const PROVIDER = 'functional-smoke-codex';
export const EXACT_MODEL = 'gpt-6-sol';
export const sha256 = value => createHash('sha256').update(value).digest('hex');
class SmokeFailure extends Error { constructor(code) { super(code); this.code = code; } }
const requireCheck = (ok, code) => { if (!ok) throw new SmokeFailure(code); };
const pause = ms => new Promise(resolveWait => setTimeout(resolveWait, ms));

export function parseOptions(argv) {
  const values = {};
  const known = new Set(['app-path', 'model', 'expected-version', 'effort', 'out-dir', 'allow-account-usage', 'deadline-ms', 'same-conversation']);
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, '');
    requireCheck(argv[i]?.startsWith('--') && known.has(key) && !Object.hasOwn(values, key) && typeof argv[i + 1] === 'string' && !argv[i + 1].startsWith('--'), 'invalid_arguments');
    values[key] = argv[i + 1];
  }
  requireCheck(values.model === EXACT_MODEL && !!values['app-path'], 'exact_model_and_app_required');
  requireCheck(values['allow-account-usage'] === undefined || ['yes', 'no'].includes(values['allow-account-usage']), 'invalid_account_usage_flag');
  requireCheck(values['same-conversation'] === undefined || ['yes', 'no'].includes(values['same-conversation']), 'invalid_continuity_flag');
  const deadlineMs = Number(values['deadline-ms'] ?? 180_000);
  requireCheck(Number.isInteger(deadlineMs) && deadlineMs >= 30_000 && deadlineMs <= 300_000, 'invalid_deadline');
  const effort = values.effort ?? 'high';
  requireCheck(['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(effort), 'invalid_effort');
  const allow = values['allow-account-usage'] === 'yes';
  requireCheck(!allow || !!values['out-dir'], 'fresh_output_directory_required');
  return { appPath: resolve(values['app-path']), model: EXACT_MODEL, expectedVersion: values['expected-version'] ?? '0.7.0', effort,
    allow, deadlineMs, sameConversation: values['same-conversation'] === 'yes', outDir: values['out-dir'] ? resolve(values['out-dir']) : undefined };
}

export function inspectApp(appPath, expectedVersion = '0.7.0') {
  requireCheck(existsSync(appPath) && !lstatSync(appPath).isSymbolicLink(), 'app_path_unavailable');
  if (lstatSync(appPath).isDirectory()) {
    const pkgPath = join(appPath, 'package.json');
    requireCheck(existsSync(pkgPath) && existsSync(join(appPath, 'main.mjs')) && existsSync(join(appPath, 'agent.mjs')), 'not_a_staged_app');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    requireCheck(pkg.name === 'mr-robot-desktop', 'unexpected_app_package');
    return { kind: 'stage', entry: appPath, version: pkg.version, files: ['package.json', 'main.mjs', 'branding.mjs', 'agent.mjs', 'preload.cjs', 'web/index.html'].map(name => join(appPath, name)) };
  }
  requireCheck(basename(appPath).toLowerCase() === 'mr.robot.exe', 'not_an_installed_app');
  const archive = join(dirname(appPath), 'resources', 'app.asar');
  requireCheck(existsSync(archive) && lstatSync(archive).isFile() && !lstatSync(archive).isSymbolicLink(), 'installed_archive_missing');
  // Do not start an older/unknown binary and only then discover that it ignored
  // --user-data-dir. These reviewed startup modules apply isolation before the
  // instance lock, server startup, or any access to the normal app profile.
  const pkg = JSON.parse(extractFile(archive, 'package.json').toString('utf8'));
  requireCheck(pkg.name === 'mr-robot-desktop' && pkg.version === expectedVersion, 'unsupported_installed_version');
  requireCheck(pkg.main === 'main.mjs', 'unreviewed_installed_entrypoint');
  for (const name of ['branding.mjs', 'main.mjs']) {
    requireCheck(sha256(extractFile(archive, name)) === sha256(readFileSync(join(ROOT, 'packages', 'desktop', name))), 'unreviewed_installed_startup');
  }
  return { kind: 'installed', entry: archive, version: pkg.version, files: [appPath, archive] };
}

export function launchSpec(input, developmentRuntime, profile) {
  // Packaged startup can change OS login-item state independent of userData.
  // Load verified installed app code in the development shell, never the EXE.
  return { executablePath: developmentRuntime, args: [input.entry, `--user-data-dir=${profile}`] };
}

export function sanitizeToolEvent(data, atMs) {
  if (!data || !['start', 'done', 'error'].includes(data.status)
    || !/^[A-Za-z][A-Za-z0-9_.:-]{0,79}$/.test(data.name ?? '')
    || typeof data.callId !== 'string' || !/^[A-Za-z0-9_.:/-]{1,200}$/.test(data.callId)) return null;
  return { atMs: Math.max(0, Math.round(atMs)), callId: data.callId, name: data.name, status: data.status,
    ...(Number.isFinite(data.elapsedMs) && data.elapsedMs >= 0 ? { elapsedMs: data.elapsedMs } : {}) };
}

export function summarizeTools(events) {
  const calls = new Map(); let duplicates = 0, outOfOrder = 0;
  for (const event of events) {
    const key = `${event.name}:${event.callId}`;
    const counts = calls.get(key) ?? { start: 0, done: 0, error: 0, name: event.name };
    if (event.status !== 'start' && counts.start !== 1 || event.status === 'start' && counts.done + counts.error > 0) outOfOrder++;
    counts[event.status]++; if (counts[event.status] > 1) duplicates++;
    calls.set(key, counts);
  }
  const rows = [...calls.values()];
  return { calls: rows.length, nativeCalls: rows.filter(row => row.name.startsWith('native_')).length,
    duplicateLifecycleEvents: duplicates, outOfOrderLifecycleEvents: outOfOrder, errors: rows.reduce((sum, row) => sum + row.error, 0),
    everyCallPaired: rows.length > 0 && outOfOrder === 0 && rows.every(row => row.start === 1 && row.done + row.error === 1) };
}

export function evaluateCase(kind, facts) {
  const tools = summarizeTools(facts.toolEvents);
  const checks = { productCompleted: facts.productCompleted, exactModelAndEffort: facts.exactModelAndEffort,
    nativeTransport: facts.nativeTransport, savedAndStreamedFinalMatch: facts.savedAndStreamedFinalMatch,
    expectedAnswer: facts.expectedAnswer, inputUnchanged: facts.inputUnchanged, allowedScratchChangesOnly: facts.allowedScratchChangesOnly,
    nativeObservation: tools.nativeCalls > 0, pairedToolLifecycle: tools.everyCallPaired,
    noDuplicateLifecycle: tools.duplicateLifecycleEvents === 0, noToolErrors: tools.errors === 0,
    telemetryToolCountMatches: facts.telemetryToolCalls === tools.calls };
  if (kind === 'native-exec') {
    checks.artifactHashCorrect = facts.artifactHashCorrect;
    checks.noUnrequestedHelpers = facts.helperCount === 0;
    // A nested native_command alone would miss the regression under test.
    checks.customExecObservation = facts.toolEvents.some(event => event.name === 'native_custom_tool' && event.status === 'start'
      && facts.toolEvents.some(done => done.name === event.name && done.callId === event.callId && done.status === 'done'));
  }
  else { checks.exactlyOneHelper = facts.helperCount === 1; checks.helperCompleted = facts.completedHelpers === 1; checks.helperReadOnly = facts.effectivePermission === 'read-only'; }
  return { passed: Object.values(checks).every(value => value === true), checks, tools };
}

function saveJson(path, value) { writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 }); }
function fileHashes(paths) { return Object.fromEntries(paths.map(path => [path, sha256(readFileSync(path))])); }
function scratchHash(path) {
  const stat = lstatSync(path);
  requireCheck(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 4096, 'scratch_input_replaced');
  return sha256(readFileSync(path));
}
/** Bounded owned-tree inventory; never follow links or read anything outside scratch. */
export function scratchSnapshot(root) {
  const files = Object.create(null), pending = ['']; let count = 0, bytes = 0;
  while (pending.length) {
    const directory = pending.shift();
    const stat = lstatSync(join(root, directory));
    requireCheck(stat.isDirectory() && !stat.isSymbolicLink(), 'scratch_directory_replaced');
    for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
      const relative = directory ? `${directory}/${entry.name}` : entry.name;
      requireCheck(++count <= 64, 'scratch_inventory_limit');
      const stat = lstatSync(join(root, relative));
      requireCheck(!stat.isSymbolicLink() && (stat.isFile() || stat.isDirectory()), 'scratch_unsafe_entry');
      if (stat.isDirectory()) { files[relative] = 'directory'; pending.push(relative); }
      else {
        bytes += stat.size;
        requireCheck(bytes <= 1_048_576, 'scratch_inventory_limit');
        files[relative] = sha256(readFileSync(join(root, relative)));
      }
    }
  }
  return files;
}
export function allowedScratchChanges(kind, before, after) {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...keys].every(key => before[key] === after[key]
    || (kind === 'native-exec' && key === 'native-result.sha256' && !Object.hasOwn(before, key) && /^[a-f0-9]{64}$/.test(after[key] ?? '')));
}
export function bounded(promise, ms, code) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new SmokeFailure(code)), ms); })]).finally(() => clearTimeout(timer));
}

export async function main(argv) {
  if (argv.length === 1 && argv[0] === '--help') {
    console.log('Functional native-observation smoke (not a quality benchmark).\nPlan only by default: --app-path STAGE_OR_INSTALLED_EXE --model gpt-6-sol\nExecute only after approval: add --allow-account-usage yes --out-dir NEW_DIRECTORY\nOptional: --expected-version 0.7.0 --effort high --deadline-ms 180000 --same-conversation yes');
    return;
  }
  const options = parseOptions(argv), input = inspectApp(options.appPath, options.expectedVersion);
  requireCheck(!input.version || input.version === options.expectedVersion, 'staged_version_mismatch');
  const plan = { functionalSmoke: true, qualityBenchmark: false, inference: options.allow, cases: ['native-exec', 'read-only-helper'],
    exactModel: options.model, effort: options.effort, expectedVersion: options.expectedVersion, appKind: input.kind,
    shellMode: input.kind === 'installed' ? 'verified-installed-asar-in-development-electron' : 'stage-in-development-electron',
    appHashes: fileHashes(input.files), deadlinePerCaseMs: options.deadlineMs, sameConversation: options.sameConversation,
    limits: ['Fresh app home/profile/scratch only; no copied user config or tokens.', 'Development Electron loads verified stage/installed ASAR code; never executes installed EXE or tests packaged-shell login-item/update behavior.', 'Normal desktop local RPC -> chat.start; no direct provider shortcut or UI clicking.',
      'One run per case; no retries or model fallback. Native sandbox is not a guarantee against every possible external action.',
      'Retain only safe observations and output hashes, never raw code, reasoning, tool input/output or account secrets.'] };
  console.log(JSON.stringify({ event: 'plan', ...plan }));
  if (!options.allow) return plan;
  requireCheck(!existsSync(options.outDir), 'output_directory_exists');
  mkdirSync(options.outDir, { recursive: true });
  saveJson(join(options.outDir, 'plan.json'), plan);
  const { _electron } = await import('@playwright/test');
  const { ConfigStore } = await import(pathToFileURL(join(ROOT, 'packages/agent/dist/config.js')).href);
  const runtime = createRequire(import.meta.url)('electron');
  const ownedRoot = mkdtempSync(join(tmpdir(), 'vera-native-functional-'));
  const home = join(ownedRoot, 'agent'), profile = join(ownedRoot, 'desktop'), scratch = join(ownedRoot, 'scratch');
  mkdirSync(scratch);
  const config = new ConfigStore(home);
  config.updateSettings({ network: { ...config.settings.network, host: '127.0.0.1', port: 0, externalAccess: false },
    setup: { ...config.settings.setup, dependencyWizardVersion: 5 },
    safety: { ...config.settings.safety, mode: 'workspace', allowedRoots: [scratch] } });
  config.upsertProvider({ id: PROVIDER, label: 'Functional smoke Codex', type: 'codex-cli', model: options.model,
    command: 'codex', baseUrl: '', apiKey: '', isDefault: true, source: 'subscription', costTier: 0 });
  config.updateRouting({ mode: 'quality', executionMode: 'single', roles: {}, escalationEnabled: false, maxPremiumCalls: 4,
    graph: { nodes: [{ id: 'master', kind: 'model', role: 'general', label: 'Functional smoke', x: 0, y: 0, providerId: PROVIDER, providerModel: options.model }], edges: [] } });
  const guardedPaths = [...input.files, runtime, fileURLToPath(import.meta.url)], beforeHashes = fileHashes(guardedPaths);
  const report = { functionalSmoke: true, qualityBenchmark: false, shellMode: plan.shellMode, startedAt: new Date().toISOString(), model: options.model, effort: options.effort,
    ownedRoot, evidenceHashes: beforeHashes, preflight: {}, cases: [], complete: false, failure: null, activeRunsAfter: null };
  let app, page, call, active, current, conversationId;
  let streamed = '', eventFailure, startTime = 0, pendingEvents = Promise.resolve();
  const cancelOwned = async () => {
    if (!active || !call) return;
    const id = active;
    await call('chat.cancel', { conversationId: id }, 5000).catch(() => {});
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (!(await call('chat.runs', {}, 5000)).some(run => run.conversationId === id && run.running !== false)) { active = undefined; return; }
      await pause(250);
    }
    throw new SmokeFailure('owned_cancellation_unconfirmed');
  };
  try {
    app = await _electron.launch({ ...launchSpec(input, runtime, profile),
      env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !['ELECTRON_RUN_AS_NODE', 'MR_ROBOT_HOME'].includes(key))), MR_ROBOT_HOME: home }, timeout: 60_000 });
    const actualPaths = await bounded(app.evaluate(({ app }) => ({ profile: app.getPath('userData'), home: process.env.MR_ROBOT_HOME, packaged: app.isPackaged })), 10_000, 'app_path_read_timeout');
    requireCheck(actualPaths.packaged === false, 'packaged_shell_not_allowed');
    requireCheck(resolve(actualPaths.profile).toLowerCase() === resolve(profile).toLowerCase() && resolve(actualPaths.home).toLowerCase() === resolve(home).toLowerCase(), 'profile_isolation_failed');
    page = await bounded(app.firstWindow(), 60_000, 'app_window_timeout');
    await page.waitForFunction(() => typeof window.mrRobotDesktop?.callLocalRpc === 'function', undefined, { timeout: 60_000 });
    await page.locator('textarea').first().waitFor({ state: 'attached', timeout: 60_000 });
    call = (method, params = {}, timeoutMs = 30_000) => bounded(page.evaluate(({ method, params, timeoutMs }) => window.mrRobotDesktop.callLocalRpc(method, params, timeoutMs), { method, params, timeoutMs }), timeoutMs + 1000, 'controller_rpc_timeout');
    const status = await call('status');
    requireCheck(status.version === options.expectedVersion, 'app_version_mismatch');
    const settings = await call('settings.get');
    requireCheck(settings.setup?.dependencyWizardVersion === 5 && settings.safety?.mode === 'workspace'
      && settings.safety.allowedRoots?.length === 1 && resolve(settings.safety.allowedRoots[0]) === resolve(scratch), 'fresh_settings_mismatch');
    requireCheck((await call('chat.runs')).length === 0 && (await call('memory.list')).length === 0 && (await call('projects.list')).length === 0, 'app_home_not_empty');
    const providers = await call('providers.list');
    requireCheck(providers.length === 1 && providers[0].id === PROVIDER && providers[0].model === options.model, 'provider_isolation_failed');
    const catalog = await call('providers.catalog', { id: PROVIDER, refresh: true }, 60_000);
    requireCheck(catalog.models?.includes(options.model) && catalog.modelCapabilities?.[options.model]?.supportedReasoningEfforts?.includes(options.effort), 'exact_model_capability_unavailable');
    report.preflight = { appVersion: status.version, developmentShell: true, isolatedProfile: true, isolatedWorkspacePermission: true, wizardVersion: 5, exactModelCapabilityVerified: true };
    await bounded(page.exposeFunction('__nativeFunctionalEvent', event => {
      pendingEvents = pendingEvents.then(() => {
        if (!current || event?.data?.conversationId !== active) return;
        const data = event.data, atMs = performance.now() - startTime;
        if (event.event === 'chat.delta' && typeof data.text === 'string') { if (streamed.length + data.text.length > 256_000) eventFailure = 'public_output_limit'; else streamed += data.text; }
        if (event.event === 'chat.confirm') eventFailure = 'unexpected_approval';
        if (event.event === 'chat.tool') {
          const safe = sanitizeToolEvent(data, atMs);
          if (!safe) eventFailure = 'invalid_tool_event';
          else if (current.toolEvents.length + current.agentEvents.length < 4000) current.toolEvents.push(safe);
          else eventFailure = 'event_limit';
        }
        if (event.event === 'chat.progress' && Array.isArray(data.agents)) for (const agent of data.agents) {
          if (agent.model !== options.model) eventFailure = 'helper_model_mismatch';
          if (typeof agent.agentId !== 'string' || !/^[A-Za-z0-9_.:/-]{1,200}$/.test(agent.agentId)
            || !['queued', 'running', 'completed', 'failed', 'cancelled'].includes(agent.state)
            || !Number.isSafeInteger(agent.sequence) || agent.sequence < 0 || !Number.isSafeInteger(agent.turns) || agent.turns < 0 || agent.turns > 4) { eventFailure = 'invalid_helper_event'; continue; }
          const safe = { atMs: Math.round(atMs), agentId: agent.agentId, state: agent.state, sequence: agent.sequence, turns: agent.turns };
          const previous = current.agentEvents.filter(row => row.agentId === safe.agentId).at(-1);
          if (!previous || previous.sequence !== safe.sequence || previous.state !== safe.state) {
            if (current.toolEvents.length + current.agentEvents.length < 4000) current.agentEvents.push(safe);
            else eventFailure = 'event_limit';
          }
        }
        if (eventFailure && !current.cancelRequested) { current.cancelRequested = true; void call('chat.cancel', { conversationId: active }, 5000).catch(() => {}); }
      });
      return pendingEvents;
    }), 10_000, 'event_bridge_timeout');
    await bounded(page.evaluate(() => {
      window.__nativeFunctionalPending = Promise.resolve();
      window.mrRobotDesktop.onLocalRpcEvent(event => { window.__nativeFunctionalPending = window.__nativeFunctionalPending.then(() => window.__nativeFunctionalEvent(event)); });
    }), 10_000, 'event_subscribe_timeout');
    const project = await call('projects.create', { name: 'Native functional smoke', path: scratch,
      instructions: 'Functional tool-observation test. Use only named files in this fresh workspace. No internet, external directories, credentials, other conversations or processes. Only the explicitly requested artifact may be written. No quality benchmark claims.' });
    for (const kind of ['native-exec', 'read-only-helper']) {
      requireCheck(JSON.stringify(fileHashes(guardedPaths)) === JSON.stringify(beforeHashes), 'app_provenance_changed');
      requireCheck((await call('chat.runs')).length === 0, 'unexpected_active_run');
      const permissionMode = kind === 'native-exec' ? 'workspace' : 'read-only';
      const inputFile = join(scratch, kind === 'native-exec' ? 'random-input.txt' : 'helper-input.json');
      const outputFile = join(scratch, 'native-result.sha256');
      const numbers = Array.from({ length: 7 }, () => randomInt(10, 100));
      writeFileSync(inputFile, kind === 'native-exec' ? `${randomBytes(128).toString('hex')}\n` : JSON.stringify({ numbers }), { flag: 'wx', mode: 0o600 });
      const inputHash = sha256(readFileSync(inputFile));
      const scratchBefore = scratchSnapshot(scratch);
      const expected = kind === 'native-exec' ? `SHA256=${inputHash}` : `HELPER_SUM=${numbers.reduce((sum, number) => sum + number, 0)}`;
      const prompt = kind === 'native-exec'
        ? 'This functional test requires real native exec/code execution, not an explanation. Read only random-input.txt in this project. Use the native exec/code tool to compute SHA-256 of its exact raw bytes, calling a local command inside it if needed. Write the lowercase 64-hex digest, with at most a final newline, to native-result.sha256. Do not modify the input. Then reply only SHA256=<digest>. No internet, other files, installs, helpers or account access.'
        : 'This functional test explicitly requires one independent helper. Use agent_spawn exactly once for a bounded read-only helper to read only helper-input.json in this project and sum its numbers. Then use agent_wait to await and retain that helper result; do not substitute your own independent answer. Reply only HELPER_SUM=<sum>. Do not write files, run shell commands, browse, spawn extra helpers, access accounts or read other files.';
      const execution = { workspaceId: project.id, providerId: PROVIDER, providerModel: options.model, routingPresetId: null,
        reasoningEffort: options.effort, daybreakEnabled: false, permissionMode, tokenPolicy: 'audit-only' };
      if (options.sameConversation && conversationId) await call('conversations.update', { id: conversationId, ...execution });
      else conversationId = (await call('conversations.create', { title: `Functional smoke ${kind}`, ...execution })).id;
      active = conversationId;
      const before = await call('conversations.get', { id: active, limit: 20 });
      requireCheck(before.permissionMode === permissionMode && before.tokenPolicy === 'audit-only', 'effective_execution_policy_mismatch');
      const priorFinalHashes = (before.messages ?? []).filter(row => row.role === 'assistant').map(row => sha256(row.content));
      current = { kind, startedAt: new Date().toISOString(), inputSha256: inputHash, promptSha256: sha256(prompt), toolEvents: [], agentEvents: [], passed: false };
      report.cases.push(current); streamed = ''; eventFailure = undefined; startTime = performance.now();
      try {
        const response = await bounded(call('chat.start', { conversationId: active, text: prompt, ...execution }, options.deadlineMs + 15_000), options.deadlineMs, 'case_deadline');
        await bounded(page.evaluate(() => window.__nativeFunctionalPending), 10_000, 'event_flush_timeout');
        await bounded(pendingEvents, 10_000, 'controller_event_flush_timeout');
        requireCheck(!eventFailure, eventFailure ?? 'event_failure');
        const saved = await call('conversations.get', { id: active, limit: 20 });
        const telemetryRows = await call('telemetry.list', { limit: 30 });
        // The controller compares public final text in memory but never persists it.
        const allTelemetry = telemetryRows.filter(row => row.conversationId === active).sort((a, b) => (b.startedAt ?? b.at ?? 0) - (a.startedAt ?? a.at ?? 0))[0];
        const agents = new Map(); for (const event of current.agentEvents) agents.set(event.agentId, event.state);
        let artifactHashCorrect = false;
        if (kind === 'native-exec' && existsSync(outputFile) && lstatSync(outputFile).isFile() && !lstatSync(outputFile).isSymbolicLink() && lstatSync(outputFile).size <= 128) {
          const output = readFileSync(outputFile, 'utf8'); current.artifactSha256 = sha256(output);
          artifactHashCorrect = /^[a-f0-9]{64}\r?\n?$/.test(output) && output.trim() === inputHash;
        }
        const savedHashes = (saved.messages ?? []).filter(row => row.role === 'assistant').map(row => sha256(row.content));
        const continuity = priorFinalHashes.every(hash => savedHashes.includes(hash));
        const facts = { productCompleted: response.ok === true,
          exactModelAndEffort: response.route?.model === options.model && response.route?.effort === options.effort && allTelemetry?.model === options.model,
          nativeTransport: allTelemetry?.transport?.some(row => row.transport === 'codex-native') === true,
          savedAndStreamedFinalMatch: typeof response.text === 'string' && response.text === streamed && savedHashes.includes(sha256(response.text)) && continuity,
          expectedAnswer: typeof response.text === 'string' && response.text.trim() === expected,
          inputUnchanged: scratchHash(inputFile) === inputHash, allowedScratchChangesOnly: allowedScratchChanges(kind, scratchBefore, scratchSnapshot(scratch)), artifactHashCorrect, toolEvents: current.toolEvents,
          effectivePermission: saved.permissionMode, helperCount: agents.size, completedHelpers: [...agents.values()].filter(state => state === 'completed').length,
          telemetryToolCalls: allTelemetry?.toolCalls };
        Object.assign(current, evaluateCase(kind, facts), { durationMs: Math.round(performance.now() - startTime), finalOutputSha256: typeof response.text === 'string' ? sha256(response.text) : null,
          priorFinalsPreserved: continuity, helperCount: agents.size, completedHelpers: facts.completedHelpers,
          telemetryToolCalls: Number.isFinite(allTelemetry?.toolCalls) ? allTelemetry.toolCalls : null,
          tokenCounts: Object.fromEntries(['promptTokens', 'completionTokens', 'cachedPromptTokens'].map(key => [key, Number.isFinite(allTelemetry?.[key]) && allTelemetry[key] >= 0 ? allTelemetry[key] : null])),
          childTokensNotAddedAgain: true });
        requireCheck(current.passed, 'functional_assertion_failed');
      } finally {
        if ((await call('chat.runs', {}, 5000)).some(run => run.conversationId === active && run.running !== false)) await cancelOwned();
        active = undefined; current = undefined;
      }
      console.log(JSON.stringify({ event: 'case-complete', kind, passed: report.cases.at(-1).passed }));
    }
    report.activeRunsAfter = (await call('chat.runs')).length;
    requireCheck(report.activeRunsAfter === 0, 'owned_runs_remain');
    requireCheck(JSON.stringify(fileHashes(guardedPaths)) === JSON.stringify(beforeHashes), 'app_provenance_changed');
    report.provenanceUnchanged = true; report.complete = true;
  } catch (error) { report.failure = error instanceof SmokeFailure ? error.code : 'app_or_rpc_failure'; }
  finally {
    if (active) await cancelOwned().catch(() => { report.cancellationUnconfirmed = true; });
    if (app) await bounded(app.close(), 30_000, 'app_close_timeout').catch(() => { report.appCloseUnconfirmed = true; });
    report.finishedAt = new Date().toISOString();
    report.passed = report.complete && report.cases.length === 2 && report.cases.every(row => row.passed) && !report.cancellationUnconfirmed && !report.appCloseUnconfirmed;
    saveJson(join(options.outDir, 'report.json'), report);
  }
  console.log(JSON.stringify({ event: 'result', complete: report.complete, passed: report.passed,
    failure: report.failure, evidenceDirectory: options.outDir }));
  if (!report.complete || report.cancellationUnconfirmed || report.appCloseUnconfirmed) process.exitCode = 1;
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(error => { console.error(JSON.stringify({ failure: error instanceof SmokeFailure ? error.code : 'smoke_setup_failed' })); process.exitCode = 1; });
}
