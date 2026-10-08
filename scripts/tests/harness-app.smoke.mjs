// Real Electron main + preload + renderer RPC + AgentServer integration.
// A deterministic loopback SSE fixture replaces the model. This is NOT an AI
// quality benchmark and must never load an account-backed provider/profile.
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(import.meta.dirname, '../..');
const MODEL = 'fixture-harness-no-inference', PROVIDER = 'harness-smoke-fixture';
const DOC = '@fixture/api owner team-a\n', DOC_HASH = hash(DOC);
const VERIFIER = { id: 'artifact-check', name: 'Fixture artifact', kind: 'json-artifact', path: 'result.json',
  schema: { type: 'object', properties: { ok: { type: 'boolean', const: true } }, required: ['ok'], additionalProperties: false } };
const delay = ms => new Promise(done => setTimeout(done, ms));
function hash(value) { return createHash('sha256').update(value).digest('hex'); }
function check(condition, code) { if (!condition) throw new Error(code); }
function bounded(promise, ms, code) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Error(code)), ms); })]).finally(() => clearTimeout(timer));
}
function options(argv) {
  const values = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.slice(2);
    check(argv[i]?.startsWith('--') && ['app-path', 'expected-version', 'out-dir', 'run'].includes(key)
      && !Object.hasOwn(values, key) && typeof argv[i + 1] === 'string' && !argv[i + 1].startsWith('--'), 'invalid_arguments');
    values[key] = argv[i + 1];
  }
  check(values['app-path'] && ['yes', 'no', undefined].includes(values.run), 'stage_required');
  return { stage: resolve(values['app-path']), version: values['expected-version'] ?? '0.8.0',
    output: values['out-dir'] ? resolve(values['out-dir']) : undefined, run: values.run === 'yes' };
}
function stageEvidence(stage, version) {
  check(lstatSync(stage).isDirectory() && !lstatSync(stage).isSymbolicLink(), 'stage_not_regular_directory');
  const pkg = JSON.parse(readFileSync(join(stage, 'package.json'), 'utf8'));
  check(pkg.name === 'mr-robot-desktop' && pkg.version === version && pkg.main === 'main.mjs', 'stage_identity_mismatch');
  const files = ['package.json', 'main.mjs', 'branding.mjs', 'agent.mjs', 'preload.cjs', 'web/index.html'];
  for (const name of ['main.mjs', 'branding.mjs']) check(hash(readFileSync(join(stage, name))) === hash(readFileSync(join(ROOT, 'packages/desktop', name))), 'stage_startup_unreviewed');
  return Object.fromEntries(files.map(name => { const path = join(stage, name); check(lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink(), 'stage_file_invalid'); return [name, hash(readFileSync(path))]; }));
}
function childEnvironment(home) {
  const allowed = new Set(['systemroot', 'windir', 'systemdrive', 'comspec', 'path', 'pathext', 'temp', 'tmp', 'userprofile', 'home', 'appdata', 'localappdata', 'programfiles', 'programfiles(x86)', 'commonprogramfiles', 'processor_architecture', 'number_of_processors', 'lang', 'lc_all']);
  return { ...Object.fromEntries(Object.entries(process.env).filter(([key, value]) => allowed.has(key.toLowerCase()) && value !== undefined)), MR_ROBOT_HOME: home };
}
function createFixture() {
  const state = { phase: 'idle', step: 0, calls: 0, failure: null, candidateId: null, receipts: [], events: [] };
  const server = createServer((request, response) => {
    if (request.url === '/v1/models' && request.method === 'GET') { response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: MODEL }] })); return; }
    if (request.url !== '/v1/chat/completions' || request.method !== 'POST') { state.failure = 'unexpected_fixture_endpoint'; response.writeHead(404).end(); return; }
    const chunks = []; let bytes = 0;
    request.on('data', chunk => { bytes += chunk.length; if (bytes > 1_048_576) { state.failure = 'fixture_request_limit'; request.destroy(); } else chunks.push(chunk); });
    request.on('end', () => {
      try {
        check(++state.calls <= 16, 'fixture_call_limit');
        const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        check(input.model === MODEL && input.reasoning_effort === 'high', 'fixture_model_or_effort_changed');
        const names = input.tools?.map(tool => tool.function?.name) ?? [];
        check(['harness_recall', 'harness_propose', 'harness_verify'].every(name => names.includes(name)), 'harness_tools_missing');
        check(!names.includes('harness_approve') && !names.some(name => /^(?:agent_|spawn_agent|Agent$|Task$)/.test(name)), 'unauthorized_model_tool_exposed');
        const last = input.messages.at(-1), result = last?.role === 'tool' ? JSON.parse(last.content) : undefined;
        const step = state.step++;
        let toolCall, text;
        if (state.phase === 'candidate') {
          if (step === 0) toolCall = ['harness_recall', { query: '@fixture/api' }];
          else if (step === 1) {
            check(result.documents.matches[0]?.sha256 === DOC_HASH && result.claims.length === 0, 'recall_did_not_read_fixture');
            toolCall = ['harness_propose', { claim: { subject: '@fixture/api', predicate: 'owner', object: 'team-a' }, evidence: [{ path: 'guide.md', sha256: DOC_HASH, quote: DOC.trim() }] }];
          } else if (step === 2) {
            check(result.status === 'candidate' && typeof result.id === 'string', 'proposal_not_pending'); state.candidateId = result.id;
            toolCall = ['harness_verify', { verifierId: VERIFIER.id }];
          } else if (step === 3) {
            check(result.status === 'passed' && result.execution === 'none' && result.exitCode === null, 'schema_verification_not_observed');
            state.receipts.push({ id: result.id, status: result.status, execution: result.execution });
            // Deliberately return an unregistered function, proving the real loop
            // rejects model approval even when it sees a valid verification.
            toolCall = ['harness_approve', { candidateId: state.candidateId, confirmation: 'user-confirmed' }];
          } else if (step === 4) { check(typeof result.error === 'string', 'model_promoted_candidate'); text = 'SYNTHETIC_CANDIDATE_ONLY'; }
          else throw Error('unexpected_candidate_step');
        } else if (state.phase === 'approved' || state.phase === 'retracted') {
          if (step === 0) toolCall = ['harness_recall', { query: '@fixture/api' }];
          else if (step === 1) { check(result.claims.length === (state.phase === 'approved' ? 1 : 0), 'knowledge_reuse_state_wrong'); text = `SYNTHETIC_${state.phase.toUpperCase()}_RECALL`; }
          else throw Error('unexpected_recall_step');
        } else if (state.phase === 'command') {
          if (step === 0) toolCall = ['harness_verify', { verifierId: 'node-check' }];
          else if (step === 1) {
            check(result.status === 'passed' && result.execution === 'local-full-not-isolated' && result.exitCode === 0
              && result.stdout === 'SYNTHETIC_COMMAND_OK' && result.sourceRevision === result.afterRevision, 'command_receipt_not_observed');
            state.receipts.push({ id: result.id, status: result.status, execution: result.execution }); text = 'SYNTHETIC_COMMAND_VERIFIED';
          } else throw Error('unexpected_command_step');
        } else throw Error('unplanned_model_call');
        state.events.push({ phase: state.phase, step, kind: toolCall ? 'tool' : 'final', ...(toolCall ? { tool: toolCall[0] } : {}) });
        response.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
        const send = data => response.write(`data: ${JSON.stringify(data)}\n\n`);
        send({ choices: [{ delta: toolCall ? { tool_calls: [{ index: 0, id: `fixture-${state.phase}-${step}`, type: 'function', function: { name: toolCall[0], arguments: JSON.stringify(toolCall[1]) } }] } : { role: 'assistant', content: text }, finish_reason: toolCall ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 1 } });
        response.end('data: [DONE]\n\n');
      } catch (error) { state.failure = /^[a-z_]+$/.test(error.message) ? error.message : 'fixture_protocol_assertion'; response.writeHead(500).end('fixture assertion failed'); }
    });
  });
  server.requestTimeout = 10_000;
  return { server, state };
}
async function closeApp(app) {
  if (!app) return;
  const processHandle = app.process(), pid = processHandle.pid;
  try { await bounded(app.close(), 15_000, 'app_close_timeout'); }
  catch {
    check(Number.isSafeInteger(pid) && pid > 0 && processHandle.exitCode === null, 'app_cleanup_unconfirmed');
    if (process.platform === 'win32') await bounded(new Promise((done, reject) => execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, error => error ? reject(error) : done())), 8000, 'owned_process_cleanup_timeout');
    else processHandle.kill('SIGKILL');
    await bounded(new Promise(done => { if (processHandle.exitCode !== null) done(); else processHandle.once('close', done); }), 5000, 'owned_process_exit_unconfirmed');
  }
}

export async function main(argv) {
  if (argv[0] === '--help') { console.log('Synthetic actual-app harness smoke, zero paid inference. --app-path STAGE [--expected-version 0.8.0] [--out-dir NEW_DIRECTORY] [--run yes]. Without --run yes: plan only.'); return; }
  const opts = options(argv), evidence = stageEvidence(opts.stage, opts.version);
  if (!opts.run) { console.log(JSON.stringify({ planOnly: true, paidInference: false, version: opts.version, appHashes: evidence, cases: ['candidate-only', 'explicit-approval', 'command-verifier', 'restart-reuse', 'retraction'] })); return; }
  if (opts.output) { check(!existsSync(opts.output), 'output_exists'); mkdirSync(opts.output, { recursive: true }); }
  const output = opts.output ?? mkdtempSync(join(tmpdir(), 'vera-harness-smoke-report-'));
  const owned = mkdtempSync(join(tmpdir(), 'vera-harness-app-')), home = join(owned, 'agent'), profile = join(owned, 'desktop'), workspace = join(owned, 'workspace');
  mkdirSync(workspace); writeFileSync(join(workspace, 'guide.md'), DOC, { flag: 'wx' }); writeFileSync(join(workspace, 'result.json'), '{"ok":true}', { flag: 'wx' });
  const report = { syntheticIntegration: true, qualityBenchmark: false, paidInference: false, appHashes: evidence, checks: {}, failure: null, phase: 'setup', passed: false };
  const fixture = createFixture(); let app, page, call, active;
  const runtime = createRequire(import.meta.url)('electron');
  try {
    await bounded(new Promise((done, reject) => { fixture.server.once('error', reject); fixture.server.listen(0, '127.0.0.1', done); }), 5000, 'fixture_listen_timeout');
    const { ConfigStore } = await import(pathToFileURL(join(ROOT, 'packages/agent/dist/config.js')).href);
    const config = new ConfigStore(home);
    config.updateSettings({ network: { ...config.settings.network, host: '127.0.0.1', port: 0, externalAccess: false },
      setup: { ...config.settings.setup, dependencyWizardVersion: 5 }, safety: { ...config.settings.safety, mode: 'workspace', allowedRoots: [workspace] } });
    config.upsertProvider({ id: PROVIDER, label: 'Synthetic local fixture (no model)', type: 'openai-compatible', model: MODEL,
      baseUrl: `http://127.0.0.1:${fixture.server.address().port}/v1`, apiKey: '', isDefault: true, source: 'free', costTier: 0 });
    const launch = async () => {
      check(JSON.stringify(stageEvidence(opts.stage, opts.version)) === JSON.stringify(evidence), 'stage_changed');
      const { _electron } = await import('@playwright/test');
      app = await _electron.launch({ executablePath: runtime, args: [opts.stage, `--user-data-dir=${profile}`], env: childEnvironment(home), timeout: 45_000 });
      const actual = await bounded(app.evaluate(({ app }) => ({ home: process.env.MR_ROBOT_HOME, profile: app.getPath('userData'), packaged: app.isPackaged })), 10_000, 'isolation_check_timeout');
      check(!actual.packaged && resolve(actual.home) === resolve(home) && resolve(actual.profile) === resolve(profile), 'profile_isolation_failed');
      page = await bounded(app.firstWindow(), 30_000, 'renderer_window_timeout');
      await page.waitForFunction(() => typeof window.mrRobotDesktop?.callLocalRpc === 'function', undefined, { timeout: 30_000 });
      await page.locator('textarea').first().waitFor({ state: 'attached', timeout: 30_000 });
      call = (method, params = {}, timeoutMs = 20_000) => bounded(page.evaluate(({ method, params, timeoutMs }) => window.mrRobotDesktop.callLocalRpc(method, params, timeoutMs), { method, params, timeoutMs }), timeoutMs + 1000, 'renderer_rpc_timeout');
      check((await call('status')).version === opts.version, 'running_version_wrong');
      const providers = await call('providers.list'); check(providers.length === 1 && providers[0].id === PROVIDER && providers[0].type === 'openai-compatible', 'account_provider_leaked');
      report.checks.actualRendererRpc = true; report.checks.isolatedAppProfile = true;
    };
    report.phase = 'launch'; await launch();
    check((await call('projects.list')).length === 0 && (await call('chat.runs')).length === 0, 'profile_not_empty');
    const project = await call('projects.create', { name: 'Synthetic harness smoke', path: workspace });
    const update = await call('harness.update', { workspaceId: project.id, documents: ['guide.md'], verifiers: [VERIFIER] });
    check(update.documents.length === 1 && update.verifiers[0].id === VERIFIER.id, 'harness_update_failed');
    const execution = { workspaceId: project.id, providerId: PROVIDER, providerModel: MODEL, routingPresetId: null, reasoningEffort: 'high', permissionMode: 'workspace', tokenPolicy: 'adaptive' };
    // Create accepts an optional string, not the null reset sentinel supported
    // by chat/update. Exercise the declared create contract on persistence.
    const { routingPresetId: _resetPreset, ...creation } = execution;
    const conversation = await call('conversations.create', { title: 'Synthetic harness integration', ...creation });
    const chat = async (phase, expected, mode = 'workspace') => {
      report.phase = phase; fixture.state.phase = phase; fixture.state.step = 0; active = conversation.id;
      const response = await call('chat.start', { conversationId: active, text: `Inspect project evidence for the synthetic ${phase} fixture`, ...execution, permissionMode: mode }, 30_000);
      check(!fixture.state.failure, fixture.state.failure ?? 'fixture_failure');
      check(response.ok === true && response.text === expected && response.route?.model === MODEL, 'chat_result_mismatch');
      const saved = await call('conversations.get', { id: active, limit: 30 }); check(saved.messages.some(message => message.role === 'assistant' && message.content === expected), 'answer_not_saved');
      check((await call('chat.runs')).length === 0, 'chat_still_running'); active = undefined; fixture.state.phase = 'idle';
    };
    await chat('candidate', 'SYNTHETIC_CANDIDATE_ONLY');
    const proposed = await call('harness.candidates', { workspaceId: project.id });
    check(proposed.length === 1 && proposed[0].id === fixture.state.candidateId && proposed[0].status === 'candidate', 'model_promoted_without_user');
    report.checks.modelCannotPromote = true; report.checks.realSchemaReceipt = true; report.checks.actualChatTools = true;
    // Exercise the actual human-facing approval flow; its renderer uses the
    // ordinary preload/RPC bridge, never a direct service function call.
    report.phase = 'approve-settings-navigation';
    await page.getByTitle('설정', { exact: true }).click({ timeout: 10_000 });
    report.phase = 'approve-harness-navigation';
    await page.locator('.settings-nav-item').filter({ hasText: '프로젝트 하네스' }).click({ timeout: 10_000 });
    report.phase = 'approve-workspace-select';
    await page.getByLabel('하네스 작업영역').selectOption(project.id, { timeout: 10_000 });
    const candidate = page.locator('.harness-candidate').filter({ hasText: 'team-a' });
    report.phase = 'approve-evidence-open';
    await candidate.locator('summary').click({ timeout: 10_000 });
    report.phase = 'approve-candidate-action';
    await candidate.getByRole('button', { name: '근거 확인 후 승인' }).click({ timeout: 10_000 });
    report.phase = 'approve-human-confirmation';
    await page.getByRole('dialog').getByRole('button', { name: '확인하고 진행' }).click({ timeout: 10_000 });
    await page.getByText('지식 재사용을 승인했습니다.', { exact: true }).waitFor({ timeout: 10_000 });
    const approved = await call('harness.candidates', { workspaceId: project.id });
    check(approved[0]?.status === 'promoted', 'explicit_approval_failed'); report.checks.explicitUiApproval = true;
    await chat('approved', 'SYNTHETIC_APPROVED_RECALL'); report.checks.approvedKnowledgeReusable = true;
    const settings = await call('settings.get');
    await call('settings.set', { safety: { ...settings.safety, mode: 'full', allowedRoots: [workspace] } });
    const command = { id: 'node-check', name: 'Synthetic Node verifier', kind: 'command', command: { executable: process.execPath, args: ['-e', 'process.stdout.write("SYNTHETIC_COMMAND_OK")'] }, sourcePaths: ['guide.md'], timeoutMs: 3000, allowFullHostExecution: true };
    await call('harness.update', { workspaceId: project.id, verifiers: [VERIFIER, command] });
    await chat('command', 'SYNTHETIC_COMMAND_VERIFIED', 'full'); report.checks.actualApprovedCommand = true;
    report.phase = 'restart'; await closeApp(app); app = undefined; await launch();
    const restored = await call('harness.candidates', { workspaceId: project.id });
    check(restored.length === 1 && restored[0].status === 'promoted' && restored[0].id === fixture.state.candidateId, 'private_state_not_restored');
    await chat('approved', 'SYNTHETIC_APPROVED_RECALL', 'full'); report.checks.restartPersistence = true;
    await call('harness.retract', { workspaceId: project.id, candidateId: fixture.state.candidateId, reason: 'user-correction' });
    await chat('retracted', 'SYNTHETIC_RETRACTED_RECALL', 'full'); report.checks.retractionAffectsRecall = true;
    check(readFileSync(join(workspace, 'guide.md'), 'utf8') === DOC, 'source_modified');
    check(JSON.stringify(stageEvidence(opts.stage, opts.version)) === JSON.stringify(evidence), 'stage_changed');
    report.checks.sourceAndStageUnchanged = true; report.checks.onlyLoopbackFixtureProvider = true;
    report.passed = Object.values(report.checks).every(value => value === true);
  } catch (error) {
    report.failure = fixture.state.failure ?? (/^[a-z_]+$/.test(error.message ?? '') ? error.message : 'app_or_rpc_assertion');
    // Only this fresh synthetic profile is in scope. Retain the first error
    // line for diagnosis, removing filesystem paths and long opaque values.
    report.failureDetail = String(error.message ?? '').split('\n')[0]
      .replace(/[A-Za-z]:[\\/][^\s"'<>]*/g, '[path]')
      .replace(/(?:Bearer\s+|(?:token|secret|password)[=:]\s*)\S+/gi, '[redacted]')
      .replace(/[A-Za-z0-9_-]{48,}/g, '[redacted-long-value]').slice(0, 500);
  } finally {
    if (active && call) await call('chat.cancel', { conversationId: active }, 5000).catch(() => { report.checks.cancelConfirmed = false; });
    try { await closeApp(app); report.checks.appProcessClosed = true; } catch { report.checks.appProcessClosed = false; }
    fixture.server.closeAllConnections(); await bounded(new Promise(done => fixture.server.close(done)), 5000, 'fixture_close_timeout').catch(() => { report.checks.fixtureClosed = false; });
    report.fixtureCalls = fixture.state.calls; report.fixtureToolSequence = fixture.state.events; report.receipts = fixture.state.receipts;
    report.passed &&= Object.values(report.checks).every(value => value === true) && report.failure === null;
    // Remove only the fresh owned fixture tree, and only after confirmed app exit.
    if (report.checks.appProcessClosed) {
      const rel = relative(resolve(tmpdir()), owned);
      if (!isAbsolute(rel) && !rel.startsWith('..') && rel.startsWith('vera-harness-app-') && !lstatSync(owned).isSymbolicLink()) {
        for (let attempt = 0; attempt < 5; attempt++) {
          try { rmSync(owned, { recursive: true, force: true }); report.checks.fixtureProfileRemoved = true; break; }
          catch { await delay(200); }
        }
      }
    }
    if (!report.checks.fixtureProfileRemoved) { report.passed = false; report.failure ??= 'owned_fixture_cleanup_unconfirmed'; }
    writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o600 });
  }
  console.log(JSON.stringify({ syntheticIntegration: true, paidInference: false, passed: report.passed, phase: report.phase, failure: report.failure, report: join(output, 'report.json') }));
  if (!report.passed) process.exitCode = 1;
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2)).catch(error => { console.error(JSON.stringify({ passed: false, failure: /^[a-z_]+$/.test(error.message ?? '') ? error.message : 'smoke_setup_failed' })); process.exitCode = 1; });
