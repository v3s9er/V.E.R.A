/** Real application benchmark. No direct AgentLoop/provider inference path. */
import { _electron, type ElectronApplication } from '@playwright/test';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { ConfigStore } from '../packages/agent/src/config.js';
import { assertFreshOutputs, assertWorkspacePermission, canonicalJson, datasetProvenance, gradeTask, hashFiles, loadTasks, parseOptions, publicTask, schedule, sha256, usageCounts, validateAppPath, type Arm } from './app-benchmark-protocol.js';

// Reviewed against App.tsx's wizardVersion < 5 gate, DependencySetup.tsx's
// auto-install guard and server.ts dependencies.complete. This affects only the
// fresh benchmark home: it does not assert that missing dependencies are installed.
export const BENCHMARK_DEPENDENCY_WIZARD_VERSION = 5;

const SOURCE_FILES = ['scripts/app-benchmark.ts', 'scripts/app-benchmark-protocol.ts', 'scripts/benchmark-aime-data.ts', 'scripts/benchmark-arc-data.ts', 'package-lock.json',
  'packages/agent/src/config.ts', 'packages/agent/src/secrets.ts', 'packages/agent/src/evaluation/performance-metrics.ts'];
const REFERENCE_FILES = ['packages/agent/src/server/server.ts', 'packages/agent/src/ai/loop.ts', 'packages/agent/src/ai/coordination-tools.ts',
  'packages/agent/src/ai/subagents.ts', 'packages/agent/src/ai/cli.ts', 'packages/agent/src/ai/cli-session-events.ts', 'packages/agent/src/ontology.ts'];

export async function main(argv: string[]): Promise<void> {
  if (argv.length === 1 && argv[0] === '--help') {
    console.log('Actual V.E.R.A application benchmark (private local regression, not an official score).\nRequired: --app-path STAGE_OR_EXE --expected-version VERSION --model EXACT_ID --effort high --out-prefix NEW_PREFIX\nAIME: --suite aime --cache FILE --year 2022 [--ids ID,ID]; relations: --suite relations [--seed NAME]\nARC: --suite arc2 --cache FILE --arc-selection locally-unused|development [--ids ID,ID for development]\nOptional: --arms single,adaptive --repetitions 2 --timeout-ms 300000 (ARC default 600000) --token-policy audit-only --cli codex\nPlanning: --plan-only yes (no launch or inference). Preflight: --preflight-only yes (app launch/catalog, no inference). Execution: --allow-account-usage yes [--plan-hash SHA256]. A new output prefix is required for each invocation.');
    return;
  }
  const options = parseOptions(argv), appInput = validateAppPath(options.appPath), tasks = loadTasks(options);
  if (appInput.version && appInput.version !== options.expectedVersion) throw new Error('Staged version differs from --expected-version');
  assertFreshOutputs(options.prefix);
  const electronRuntime = createRequire(import.meta.url)('electron') as string;
  const sourceHashes = hashFiles(SOURCE_FILES), appHashes = hashFiles([...appInput.files, electronRuntime]);
  const checkoutReferenceHashes = hashFiles(REFERENCE_FILES);
  const graph = { nodes: [
    { id: 'research', kind: 'model', role: 'reasoning', label: 'Independent analysis', x: 0, y: 0 },
    { id: 'review', kind: 'model', role: 'critic', label: 'Counterexample review', x: 0, y: 160 },
    { id: 'master', kind: 'model', role: 'general', label: 'Execute and verify', x: 240, y: 80 },
  ].map(node => ({ ...node, providerId: 'app-benchmark-codex', providerModel: options.model })), edges: [{ id: 'research-master', from: 'research', to: 'master' }, { id: 'review-master', from: 'review', to: 'master' }] };
  const plan = { schemaVersion: 1, suite: options.suite, dataset: datasetProvenance(options), model: options.model, effort: options.effort,
    appKind: appInput.kind, expectedVersion: options.expectedVersion, appHashes, sourceHashes, graph,
    arms: options.arms, repetitions: options.repetitions, deadlineMs: options.deadlineMs, tokenPolicy: options.tokenPolicy,
    tasks: tasks.map(publicTask), schedule: schedule(tasks, options.arms, options.repetitions), tools: 'normal-native-product-tools',
    permissionMode: 'workspace', daybreakEnabled: false, concurrency: 1, retries: 0, officialScore: false,
    dependencyWizardVersion: BENCHMARK_DEPENDENCY_WIZARD_VERSION, dependencyInstallation: 'disabled-by-isolated-first-run-state',
    shell: 'Local development Electron loads the frozen stage or installed app.asar with a fresh user-data-dir; the installed executable is not opened.',
    ontology: options.suite === 'relations' ? 'Same given facts in every prompt; extra scoped fact retrieval only in ontology-adaptive.' : 'not-applicable',
    limits: ['Fresh isolated app home and workspace per sample; no answer keys in model requests or workspace.', 'Native tools use normal product permissions, not an OS sandbox; external retrieval is forbidden by task instructions.', 'AB/BA order reverses per repetition; three arms rotate and reverse. Caches/provider load are not completely controlled.', 'Same model, effort, token policy and wall deadline; adaptive can spend more total tokens. Not equal compute or a claim of held-out generalization.'] };
  const planHash = sha256(canonicalJson(plan));
  if (options.planHash && options.planHash !== planHash) throw new Error('Frozen plan hash mismatch');
  mkdirSync(dirname(options.prefix), { recursive: true });
  writeFileSync(`${options.prefix}.plan.json`, `${JSON.stringify({ planHash, plan }, null, 2)}\n`, { flag: 'wx' });
  console.log(JSON.stringify({ event: 'plan', planHash, cases: plan.schedule.length, model: options.model, inference: !options.planOnly && !options.preflightOnly }));
  if (options.planOnly) return;

  const root = mkdtempSync(join(tmpdir(), 'mrrobot-app-benchmark-')), home = join(root, 'agent'), scratchBase = join(root, 'workspaces');
  mkdirSync(scratchBase);
  const config = new ConfigStore(home);
  // Fresh ConfigStore defaults to ask. Without this isolated-only cap, the server
  // downgrades requested workspace permission and waits 120 seconds for approval.
  config.updateSettings({ network: { ...config.settings.network, host: '127.0.0.1', port: 0, externalAccess: false },
    safety: { ...config.settings.safety, mode: 'workspace', allowedRoots: [scratchBase] },
    setup: { ...config.settings.setup, dependencyWizardVersion: BENCHMARK_DEPENDENCY_WIZARD_VERSION } });
  // No user configuration, provider secret, login token, memory or history is copied.
  // Codex performs its normal authentication from its own existing account store.
  config.upsertProvider({ id: 'app-benchmark-codex', label: 'Benchmark Codex', type: 'codex-cli', model: options.model,
    command: options.cli, baseUrl: '', apiKey: '', isDefault: true, source: 'subscription', costTier: 0 });
  const presets: Partial<Record<Arm, string>> = {};
  for (const mode of ['single', 'adaptive'] as const) {
    config.updateRouting({ mode: 'quality', executionMode: mode, roles: {}, escalationEnabled: false, maxPremiumCalls: 6,
      graph: (mode === 'single' ? { nodes: [graph.nodes[2]], edges: [] } : graph) as any });
    presets[mode] = config.saveRoutingPreset(`Benchmark ${mode}`).id;
  }
  presets['ontology-adaptive'] = presets.adaptive;
  config.updateRouting({ executionMode: 'single' });
  const report: any = { planHash, startedAt: new Date().toISOString(), preflight: { inference: false }, checkoutReferenceHashes,
    checkoutReferenceNote: 'Informational checkout snapshot; these source files are not executed by the measured frozen bundle and are not asserted to be its build inputs.', samples: [], complete: false, stopped: null };
  let app: ElectronApplication | undefined, page: any, active: string | undefined, activeSample: any, eventError: string | undefined;
  let call: ((method: string, params?: any, timeoutMs?: number) => Promise<any>) | undefined;
  let started = 0, streamed = '', doneUsage: any, agentSignatures = new Map<string, string>();
  const invariant = () => {
    if (canonicalJson(hashFiles([...appInput.files, electronRuntime])) !== canonicalJson(appHashes) || canonicalJson(hashFiles(SOURCE_FILES)) !== canonicalJson(sourceHashes)) throw new Error('provenance_changed');
  };
  const cancelAndSettle = async (conversationId: string) => {
    if (!call) return;
    await call('chat.cancel', { conversationId }).catch(() => {});
    const until = Date.now() + 45_000;
    while (Date.now() < until) {
      if (!(await call('chat.runs')).some((run: any) => run.conversationId === conversationId && run.running !== false)) return;
      await new Promise(resolveWait => setTimeout(resolveWait, 200));
    }
    throw new Error('cancellation_not_settled');
  };
  try {
    report.preflightStage = 'launch';
    // Loading the real installed archive with development Electron avoids the
    // packaged shell's fixed userData path/single-instance lock. No app code is mocked.
    const entry = appInput.kind === 'stage' ? appInput.path : join(dirname(appInput.path), 'resources', 'app.asar');
    app = await _electron.launch({ executablePath: electronRuntime, args: [entry, `--user-data-dir=${join(root, 'desktop')}`],
      env: { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !['ELECTRON_RUN_AS_NODE', 'MR_ROBOT_HOME'].includes(key))), MR_ROBOT_HOME: home }, timeout: 60_000 });
    page = await app.firstWindow();
    report.preflightStage = 'renderer_ready';
    await page.waitForFunction(() => typeof (globalThis as any).mrRobotDesktop?.callLocalRpc === 'function', undefined, { timeout: 60_000 });
    await page.locator('textarea').first().waitFor({ state: 'attached', timeout: 60_000 });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(window => window.hide()));
    report.preflightStage = 'profile_check';
    const actualProfile = await app.evaluate(({ app }) => app.getPath('userData'));
    if (resolve(actualProfile).toLowerCase() !== resolve(root, 'desktop').toLowerCase()) throw new Error('desktop_profile_isolation_mismatch');
    report.preflightStage = 'event_bridge';
    await page.exposeFunction('__appBenchmarkEvent', (event: any) => {
      if (!activeSample || event?.data?.conversationId !== active) return;
      const data = event.data, elapsedMs = performance.now() - started;
      if (event.event === 'chat.delta' && typeof data.text === 'string') { streamed += data.text; if (data.text.trim()) activeSample.firstTextMs ??= elapsedMs; }
      if (event.event === 'chat.done') doneUsage = data.usage;
      if (event.event === 'chat.confirm') {
        eventError = 'approval_required';
        // The benchmark has no human approval loop. Cancel only this owned run;
        // do not wait for an approval timeout or broaden its permissions.
        void call?.('chat.cancel', { conversationId: active }).catch(() => {});
      }
      if (event.event === 'chat.tool') {
        activeSample.toolEvents.push({ atMs: elapsedMs, name: typeof data.name === 'string' ? data.name.slice(0, 120) : 'unknown', status: ['start', 'done', 'error'].includes(data.status) ? data.status : 'unknown', elapsedMs: Number.isFinite(data.elapsedMs) ? data.elapsedMs : undefined });
      }
      if (event.event === 'chat.progress' && Array.isArray(data.agents)) for (const agent of data.agents) {
        if (agent.model && agent.model !== options.model) eventError = 'worker_model_mismatch';
        const summary = { agentId: String(agent.agentId ?? '').slice(0, 128), model: agent.model, state: agent.state, sequence: agent.sequence, turns: agent.turns, usage: usageCounts(agent.usage) };
        const signature = canonicalJson(summary);
        if (agentSignatures.get(summary.agentId) !== signature) { activeSample.agentEvents.push({ atMs: elapsedMs, ...summary }); agentSignatures.set(summary.agentId, signature); }
      }
      if (activeSample.toolEvents.length + activeSample.agentEvents.length > 20_000) eventError = 'event_limit';
    });
    await page.evaluate(() => {
      const state = globalThis as any;
      state.__appBenchmarkPending = Promise.resolve();
      state.mrRobotDesktop.onLocalRpcEvent((event: any) => { state.__appBenchmarkPending = state.__appBenchmarkPending.then(() => state.__appBenchmarkEvent(event)); });
    });
    call = (method, params = {}, timeoutMs = 30_000) => page.evaluate(({ method, params, timeoutMs }: any) => (globalThis as any).mrRobotDesktop.callLocalRpc(method, params, timeoutMs), { method, params, timeoutMs });
    report.preflightStage = 'status';
    const status = await call('status');
    if (status.version !== options.expectedVersion) throw new Error('app_version_mismatch');
    report.preflightStage = 'isolated_state';
    if ((await call('chat.runs')).length || (await call('memory.list')).length || (await call('projects.list')).length) throw new Error('isolated_home_not_empty');
    const effectiveSettings = await call('settings.get');
    assertWorkspacePermission(effectiveSettings.safety?.mode);
    if (!Array.isArray(effectiveSettings.safety?.allowedRoots) || effectiveSettings.safety.allowedRoots.length !== 1
      || resolve(effectiveSettings.safety.allowedRoots[0]).toLowerCase() !== resolve(scratchBase).toLowerCase()) throw new Error('scratch_roots_mismatch');
    report.preflightStage = 'dependency_wizard';
    if (effectiveSettings.setup?.dependencyWizardVersion !== BENCHMARK_DEPENDENCY_WIZARD_VERSION) throw new Error('dependency_setup_mismatch');
    const dependencies = await call('dependencies.status', {}, 60_000);
    if (dependencies.wizardVersion !== BENCHMARK_DEPENDENCY_WIZARD_VERSION || await page.locator('.dependency-modal').count()) throw new Error('dependency_wizard_not_suppressed');
    const providers = await call('providers.list');
    if (providers.length !== 1 || providers[0].id !== 'app-benchmark-codex' || providers[0].model !== options.model) throw new Error('provider_isolation_mismatch');
    report.preflightStage = 'model_catalog';
    const catalog = await call('providers.catalog', { id: 'app-benchmark-codex', refresh: true }, 60_000);
    if (!catalog.models?.includes(options.model)) throw new Error('model_unavailable');
    report.preflightStage = 'preset_check';
    const actualPresets = await call('routing.presets.list');
    for (const [arm, id] of Object.entries(presets)) {
      const preset = actualPresets.find((item: any) => item.id === id);
      if (!preset || preset.executionMode !== (arm === 'single' ? 'single' : 'adaptive') || preset.graph.nodes.some((node: any) => node.providerModel !== options.model || node.providerId !== 'app-benchmark-codex')) throw new Error('preset_model_mismatch');
    }
    report.preflightStage = 'effective_permission';
    const permissionProbePath = mkdtempSync(join(scratchBase, 'permission-probe-'));
    const permissionProject = await call('projects.create', { name: 'Benchmark permission preflight', path: permissionProbePath });
    const permissionConversation = await call('conversations.create', { title: 'No-inference permission preflight', workspaceId: permissionProject.id,
      providerId: 'app-benchmark-codex', providerModel: options.model, routingPresetId: presets.single, permissionMode: 'workspace', tokenPolicy: options.tokenPolicy });
    try { assertWorkspacePermission((await call('conversations.get', { id: permissionConversation.id })).permissionMode); }
    finally { await call('conversations.update', { id: permissionConversation.id, status: 'archived' }); }
    report.preflight = { inference: false, appVersion: status.version, exactModelAvailable: true, isolatedHomeVerified: true, sameModelPresetsVerified: true, effectivePermissionMode: 'workspace', scratchRootsScoped: true,
      dependencyWizardVersion: dependencies.wizardVersion, dependencyWizardSuppressed: true };
    report.preflightStage = 'passed';
    writeFileSync(`${options.prefix}.manifest.json`, `${JSON.stringify({ planHash, startedAt: report.startedAt, preflight: report.preflight, entrypoint: 'actual Electron renderer -> authenticated native local RPC -> chat.start', node: process.version, platform: process.platform }, null, 2)}\n`, { flag: 'wx' });
    writeFileSync(`${options.prefix}.progress.jsonl`, '', { flag: 'wx' });
    if (options.preflightOnly) { report.complete = true; report.preflightOnly = true; report.provenanceValid = true; invariant(); return; }
    for (const item of plan.schedule) {
      invariant();
      if (await page.locator('.dependency-modal').count()) throw new Error('dependency_wizard_not_suppressed');
      if ((await call('chat.runs')).length) throw new Error('unexpected_active_run');
      const task = tasks.find(candidate => candidate.id === item.taskId)!;
      const workspace = mkdtempSync(join(scratchBase, 'case-'));
      const project = await call('projects.create', { name: `Evaluation ${item.taskId} ${item.arm}`, path: workspace,
        instructions: 'Independent benchmark. Only the current supplied evidence and this fresh scratch workspace are authorized. Local computation is allowed. No network, account/private files, other projects/conversations or answer keys. Do not persist guesses. Follow the requested final output format.' });
      const settings = { workspaceId: project.id, providerId: 'app-benchmark-codex', providerModel: options.model,
        routingPresetId: presets[item.arm], reasoningEffort: options.effort, daybreakEnabled: false, permissionMode: 'workspace', tokenPolicy: options.tokenPolicy };
      const conversation = await call('conversations.create', { title: `Evaluation ${item.taskId} ${item.arm} ${item.repetition + 1}`, ...settings });
      active = conversation.id;
      assertWorkspacePermission((await call('conversations.get', { id: active })).permissionMode);
      if (item.arm === 'ontology-adaptive') for (const relation of task.relations) await call('memory.add', { workspaceId: project.id, conversationId: active, relationMode: 'fact', relation, source: 'Same supplied synthetic benchmark facts; no reference answer' });
      activeSample = { ...item, conversationId: active, projectId: project.id, firstTextMs: null, durationMs: 0, completed: false, passed: false, failure: null, toolEvents: [], agentEvents: [] };
      report.samples.push(activeSample); streamed = ''; doneUsage = undefined; eventError = undefined; agentSignatures = new Map();
      started = performance.now();
      let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; void call!('chat.cancel', { conversationId: active }).catch(() => {}); }, options.deadlineMs);
      console.log(JSON.stringify({ event: 'start', ...item }));
      try {
        const response = await call('chat.start', { conversationId: active, text: task.prompt, ...settings }, options.deadlineMs + 45_000);
        // Read-back is part of application correctness and ensures completion events were delivered.
        const saved = await call('conversations.get', { id: active, limit: 10 });
        await page.evaluate(() => (globalThis as any).__appBenchmarkPending);
        const telemetry = (await call('telemetry.list', { limit: 50 })).find((row: any) => row.conversationId === active);
        activeSample.durationMs = performance.now() - started;
        activeSample.usage = usageCounts(doneUsage);
        activeSample.toolCalls = telemetry?.toolCalls ?? null;
        activeSample.transport = telemetry?.transport ?? [];
        activeSample.nativeRouteObserved = activeSample.transport.some((timing: any) => timing.transport === 'codex-native');
        activeSample.knowledge = telemetry?.knowledge ?? null;
        activeSample.route = response.route && { model: response.route.model, effort: response.route.effort };
        activeSample.answerSha256 = typeof response.text === 'string' ? sha256(response.text) : null;
        activeSample.savedFinalMatches = saved.messages?.some((message: any) => message.role === 'assistant' && message.content === response.text) === true;
        activeSample.streamMatches = streamed === response.text;
        if (eventError) throw new Error(eventError);
        if (timedOut) activeSample.failure = 'deadline';
        else if (!response.ok) activeSample.failure = 'product_run_failed';
        else if (response.route?.model !== options.model || response.route?.effort !== options.effort || telemetry?.model !== options.model || telemetry?.agents?.some((agent: any) => agent.model !== options.model)) throw new Error('model_or_effort_mismatch');
        else if (!activeSample.savedFinalMatches || !activeSample.streamMatches) throw new Error('stream_or_persistence_mismatch');
        else if (!activeSample.nativeRouteObserved) throw new Error('native_route_not_observed');
        else if (item.arm === 'ontology-adaptive' && !(telemetry?.knowledge?.asserted > 0 && telemetry?.knowledge?.inferred > 0)) throw new Error('ontology_not_observed');
        else { activeSample.completed = true; Object.assign(activeSample, gradeTask(task, response.text)); }
      } catch (error) {
        const message = error instanceof Error ? error.message : '';
        activeSample.failure = timedOut ? 'deadline' : ['approval_required', 'worker_model_mismatch', 'model_or_effort_mismatch', 'stream_or_persistence_mismatch', 'native_route_not_observed', 'ontology_not_observed', 'event_limit'].includes(message) ? message : 'transport_or_execution';
        if (!timedOut) report.stopped = activeSample.failure;
      } finally {
        clearTimeout(timer);
        activeSample.durationMs ||= performance.now() - started;
        activeSample.usage ??= usageCounts(doneUsage);
        if ((await call('chat.runs')).some((run: any) => run.conversationId === active && run.running !== false)) await cancelAndSettle(active!);
        // This fresh home contains only our generated records. Archive this owned conversation only.
        await call('conversations.update', { id: active, status: 'archived' });
        appendFileSync(`${options.prefix}.progress.jsonl`, `${JSON.stringify(activeSample)}\n`);
        console.log(JSON.stringify({ event: 'finish', ...item, passed: activeSample.passed, failure: activeSample.failure, durationMs: Math.round(activeSample.durationMs), tokens: activeSample.usage.totalTokens }));
        active = undefined; activeSample = undefined;
      }
      if (report.stopped) break;
    }
    invariant();
    report.complete = report.samples.length === plan.schedule.length && !report.stopped;
    report.activeRunsAfter = (await call('chat.runs')).length;
    report.provenanceValid = true;
  } catch (error) {
    const reason = error instanceof Error ? error.message : '';
    report.stopped = /^[a-z_]+$/.test(reason) ? reason : 'harness_preflight_or_runtime';
    report.errorType = error instanceof Error ? error.name : 'unknown';
    report.complete = false;
  } finally {
    if (active && call) await cancelAndSettle(active).catch(() => { report.cancellationUnconfirmed = true; });
    if (app) await app.close().catch(() => { report.closeUnconfirmed = true; });
    report.finishedAt = new Date().toISOString();
    report.summary = options.arms.map(arm => {
      const rows = report.samples.filter((sample: any) => sample.arm === arm), passed = rows.filter((sample: any) => sample.passed).length;
      const distribution = (values: number[]) => { const sorted = values.filter(Number.isFinite).sort((a, b) => a - b); return { count: sorted.length, p50: sorted.length ? sorted[Math.ceil(sorted.length * .5) - 1] : null, p95: sorted.length ? sorted[Math.ceil(sorted.length * .95) - 1] : null }; };
      const expected = plan.schedule.filter(item => item.arm === arm).length, usageComplete = rows.length === expected && rows.every((row: any) => row.usage.totalTokens !== null);
      return { arm, expected, attempted: rows.length, passed, missing: expected - rows.length, completionMs: distribution(rows.map((row: any) => row.durationMs)), firstTextMs: distribution(rows.filter((row: any) => row.firstTextMs !== null).map((row: any) => row.firstTextMs)), tokensPerSuccess: usageComplete && passed ? rows.reduce((sum: number, row: any) => sum + row.usage.totalTokens, 0) / passed : null, usageComplete };
    });
    writeFileSync(`${options.prefix}.report.json`, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
    console.log(JSON.stringify({ event: 'complete', complete: report.complete, stopped: report.stopped, summary: report.summary }));
    if (!report.complete) process.exitCode = 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main(process.argv.slice(2)).catch(() => { console.error('Benchmark input/plan validation failed; no inference was started. Use --help and verify paths and immutable output prefix.'); process.exitCode = 1; });
