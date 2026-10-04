import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createPackage } from '@electron/asar';
import { parseOptions, sanitizeToolEvent, summarizeTools, evaluateCase, sha256, allowedScratchChanges, scratchSnapshot, bounded, launchSpec } from './app-native-observation.smoke.mjs';
import { createBrowserFixture, browserSmokeToolAllowed } from './app-browser-fixture.mjs';

const args = ['--app-path', 'fixture-stage', '--model', 'gpt-6-sol'];
const pair = (name = 'native_custom_tool', callId = 'call-1') => [{ atMs: 1, name, callId, status: 'start' }, { atMs: 2, name, callId, status: 'done', elapsedMs: 1 }];
const facts = () => ({ productCompleted: true, exactModelAndEffort: true, nativeTransport: true,
  savedAndStreamedFinalMatch: true, expectedAnswer: true, inputUnchanged: true, artifactHashCorrect: true,
  toolEvents: pair(), effectivePermission: 'read-only', helperCount: 0, completedHelpers: 0, telemetryToolCalls: 1, allowedScratchChangesOnly: true });

test('default is plan only, explicit exact model required, and invalid consent never enables inference', () => {
  assert.equal(parseOptions(args).allow, false);
  assert.equal(parseOptions([...args, '--allow-account-usage', 'no']).allow, false);
  assert.throws(() => parseOptions(['--app-path', 'fixture']), /exact_model/);
  assert.throws(() => parseOptions(['--app-path', 'fixture', '--model', 'gpt-6-astra']), /exact_model/);
  assert.throws(() => parseOptions([...args, '--allow-account-usage', 'true']), /invalid_account/);
  assert.throws(() => parseOptions([...args, '--allow-account-usage', 'yes']), /fresh_output/);
  assert.equal(parseOptions([...args, '--allow-account-usage', 'yes', '--out-dir', 'new-evidence']).allow, true);
});

test('argument whitelist, duplicates and bounded deadlines fail closed', () => {
  assert.throws(() => parseOptions([...args, '--force', 'yes']), /invalid_arguments/);
  assert.throws(() => parseOptions([...args, '--model', 'gpt-6-sol']), /invalid_arguments/);
  for (const duration of ['0', 'NaN', '300001', '900000', '1.5']) assert.throws(() => parseOptions([...args, '--deadline-ms', duration]), /invalid_deadline/);
  assert.equal(parseOptions([...args, '--deadline-ms', '300000']).deadlineMs, 300000);
});

test('browser case is opt-in, cannot grant account consent, and requires independent browser effects', () => {
  assert.equal(parseOptions(args).browserCase, false);
  const enabled = parseOptions([...args, '--browser-case', 'yes']);
  assert.equal(enabled.browserCase, true); assert.equal(enabled.allow, false);
  assert.throws(() => parseOptions([...args, '--browser-case', 'true']), /invalid_browser/);
  const events = ['browser_open', 'browser_observe', 'browser_type', 'browser_click', 'browser_close'].flatMap((name, i) => pair(name, `browser-${i}`));
  const complete = { ...facts(), effectivePermission: 'full', fixtureSubmissionVerified: true, toolEvents: events, telemetryToolCalls: 5 };
  assert.equal(evaluateCase('owned-browser', complete).passed, true);
  for (const patch of [{ fixtureSubmissionVerified: false }, { expectedAnswer: false }, { helperCount: 1 }, { effectivePermission: 'workspace' }, { nativeTransport: false }, { telemetryToolCalls: 4 }]) {
    assert.equal(evaluateCase('owned-browser', { ...complete, ...patch }).passed, false);
  }
  assert.equal(evaluateCase('owned-browser', { ...complete, toolEvents: events.filter(e => e.name !== 'browser_close'), telemetryToolCalls: 4 }).passed, false);
  assert.equal(evaluateCase('owned-browser', { ...complete, toolEvents: [...events, ...pair('native_command', 'unexpected')], telemetryToolCalls: 6 }).passed, false);
  assert.equal(browserSmokeToolAllowed('native_custom_tool'), true, 'native code-mode carrier may call registered browser tools');
  assert.equal(browserSmokeToolAllowed('shell_exec'), false);
});

test('owned loopback fixture withholds its random receipt until one correct bounded submission', async () => {
  const fixture = await createBrowserFixture();
  try {
    assert.equal(new URL(fixture.url).hostname, '127.0.0.1');
    const html = await (await fetch(fixture.url)).text();
    assert.equal(html.includes(fixture.expected.slice('BROWSER_OK='.length)), false);
    assert.equal(fixture.verified(), false);
    const response = await fetch(fixture.url + '/submit', { method: 'POST', body: fixture.value });
    assert.equal(response.status, 200);
    assert.equal(`BROWSER_OK=${(await response.json()).receipt}`, fixture.expected);
    assert.equal(fixture.verified(), true);
    assert.equal((await fetch(fixture.url + '/submit', { method: 'POST', body: fixture.value })).status, 400);
    assert.equal(fixture.verified(), false, 'duplicate submission cannot pass');
  } finally { await fixture.close(); }
});

test('installed code and staged code both use development Electron, never the packaged OS-integrated executable', () => {
  assert.deepEqual(launchSpec({ kind: 'installed', entry: 'installed/resources/app.asar' }, 'development/electron.exe', 'fresh-profile'),
    { executablePath: 'development/electron.exe', args: ['installed/resources/app.asar', '--user-data-dir=fresh-profile'] });
  assert.deepEqual(launchSpec({ kind: 'stage', entry: 'fixture-stage' }, 'development/electron.exe', 'fresh-profile'),
    { executablePath: 'development/electron.exe', args: ['fixture-stage', '--user-data-dir=fresh-profile'] });
});

test('tool sanitizer retains only safe lifecycle metadata, never payload or private output', () => {
  const value = sanitizeToolEvent({ name: 'native_custom_tool', callId: 'call_123', status: 'done', elapsedMs: 20,
    input: { secret: 'DO_NOT_RETAIN' }, detail: 'PRIVATE_REASONING', output: 'PRIVATE_OUTPUT', code: 'RAW_CODE' }, 30.2);
  assert.deepEqual(value, { name: 'native_custom_tool', callId: 'call_123', status: 'done', elapsedMs: 20, atMs: 30 });
  assert.doesNotMatch(JSON.stringify(value), /PRIVATE|RETAIN|RAW_CODE/);
  assert.equal(sanitizeToolEvent({ name: 'native_custom_tool', callId: 'raw\ncode', status: 'done' }, 1), null);
  assert.equal(sanitizeToolEvent({ name: 'native_custom_tool', callId: 'x', status: 'unknown' }, 1), null);
});

test('native case cannot pass on correct artifact alone or only nested command observations', () => {
  assert.equal(evaluateCase('native-exec', facts()).passed, true);
  assert.equal(evaluateCase('native-exec', { ...facts(), toolEvents: [] }).passed, false);
  const nestedOnly = evaluateCase('native-exec', { ...facts(), toolEvents: pair('native_command') });
  assert.equal(nestedOnly.checks.customExecObservation, false);
  assert.equal(nestedOnly.passed, false);
});

test('returned custom exec is not semantic success without objectively correct artifact', () => {
  assert.equal(evaluateCase('native-exec', { ...facts(), artifactHashCorrect: false }).passed, false);
  assert.equal(evaluateCase('native-exec', { ...facts(), expectedAnswer: false }).passed, false);
  assert.equal(evaluateCase('native-exec', { ...facts(), inputUnchanged: false }).passed, false);
  assert.equal(evaluateCase('native-exec', { ...facts(), helperCount: 1, completedHelpers: 1 }).passed, false);
  assert.equal(evaluateCase('native-exec', { ...facts(), allowedScratchChangesOnly: false }).passed, false);
});

test('duplicate, orphan, out-of-order, and error lifecycle events fail observation checks', () => {
  const success = pair();
  assert.equal(summarizeTools([...success, success[1]]).duplicateLifecycleEvents, 1);
  for (const events of [[success[1]], [...success].reverse(), [...success, success[1]], [success[0], { ...success[1], status: 'error' }]]) {
    assert.equal(evaluateCase('native-exec', { ...facts(), toolEvents: events }).passed, false);
  }
});

test('distinct outer exec and nested command calls are retained, not incorrectly deduplicated', () => {
  const events = [...pair(), ...pair('native_command', 'child-1')];
  assert.equal(summarizeTools(events).calls, 2);
  assert.equal(evaluateCase('native-exec', { ...facts(), toolEvents: events, telemetryToolCalls: 2 }).passed, true);
  assert.equal(evaluateCase('native-exec', { ...facts(), toolEvents: events, telemetryToolCalls: 1 }).passed, false);
});

test('a queued or running helper is never completion evidence; exactly one completed read-only child is required', () => {
  const helperFacts = { ...facts(), helperCount: 1, completedHelpers: 1 };
  assert.equal(evaluateCase('read-only-helper', helperFacts).passed, true);
  for (const patch of [{ completedHelpers: 0 }, { helperCount: 0 }, { helperCount: 2 }, { effectivePermission: 'workspace' }, { expectedAnswer: false }, { allowedScratchChangesOnly: false }]) {
    assert.equal(evaluateCase('read-only-helper', { ...helperFacts, ...patch }).passed, false);
  }
});

test('native execution permits only its new artifact; read-only helper must preserve the entire scratch tree', () => {
  const original = { 'random-input.txt': sha256('input') }, artifact = { ...original, 'native-result.sha256': sha256('result') };
  assert.equal(allowedScratchChanges('native-exec', original, artifact), true);
  assert.equal(allowedScratchChanges('native-exec', original, { ...artifact, 'extra.txt': sha256('extra') }), false);
  assert.equal(allowedScratchChanges('native-exec', original, { ...artifact, 'random-input.txt': sha256('changed') }), false);
  assert.equal(allowedScratchChanges('read-only-helper', artifact, artifact), true);
  assert.equal(allowedScratchChanges('read-only-helper', artifact, original), false);
  assert.equal(allowedScratchChanges('read-only-helper', original, artifact), false);
  assert.equal(allowedScratchChanges('read-only-helper', artifact, { ...artifact, 'native-result.sha256': sha256('changed') }), false);
});

test('controller deadline expires even when the renderer-side RPC never settles', async () => {
  await assert.rejects(bounded(new Promise(() => {}), 20, 'controller_rpc_timeout'), /controller_rpc_timeout/);
  assert.equal(await bounded(Promise.resolve('ok'), 1000, 'unexpected'), 'ok');
});

test('scratch inventory cannot hide a file with an inherited-object property name', () => {
  const directory = mkdtempSync(join(tmpdir(), 'vera-native-plan-test-'));
  try {
    const before = scratchSnapshot(directory);
    writeFileSync(join(directory, '__proto__'), 'not allowed');
    const after = scratchSnapshot(directory);
    assert.equal(Object.hasOwn(after, '__proto__'), true);
    assert.equal(after.__proto__, sha256('not allowed'));
    assert.equal(allowedScratchChanges('read-only-helper', before, after), false);
  } finally {
    const target = resolve(directory), parent = resolve(tmpdir()) + sep;
    assert.ok(target.startsWith(parent) && target.slice(parent.length).startsWith('vera-native-plan-test-'));
    rmSync(target, { recursive: true, force: true });
  }
});

test('route, persistence, and actual native transport are independently required', () => {
  for (const field of ['productCompleted', 'exactModelAndEffort', 'nativeTransport', 'savedAndStreamedFinalMatch']) {
    assert.equal(evaluateCase('native-exec', { ...facts(), [field]: false }).passed, false);
  }
});

test('plan-only CLI reads a staged fixture without creating profile/evidence or loading Electron', () => {
  const directory = mkdtempSync(join(tmpdir(), 'vera-native-plan-test-'));
  try {
    const app = join(directory, 'stage'), evidence = join(directory, 'must-not-exist');
    mkdirSync(join(app, 'web'), { recursive: true });
    for (const name of ['main.mjs', 'branding.mjs', 'agent.mjs', 'preload.cjs', 'web/index.html']) writeFileSync(join(app, name), 'fixture-not-an-executable');
    writeFileSync(join(app, 'package.json'), JSON.stringify({ name: 'mr-robot-desktop', version: '0.7.0' }));
    const run = spawnSync(process.execPath, [fileURLToPath(new URL('./app-native-observation.smoke.mjs', import.meta.url)), '--app-path', app, '--model', 'gpt-6-sol', '--out-dir', evidence], { encoding: 'utf8', timeout: 15000, windowsHide: true });
    assert.equal(run.status, 0, run.stderr);
    const plan = JSON.parse(run.stdout.trim());
    assert.equal(plan.inference, false); assert.equal(plan.qualityBenchmark, false);
    assert.equal(Object.values(plan.appHashes).every(hash => /^[a-f0-9]{64}$/.test(hash)), true);
    assert.equal(existsSync(evidence), false);
    assert.equal(sha256('non-secret fixture').length, 64);
  } finally {
    const target = resolve(directory), parent = resolve(tmpdir()) + sep;
    assert.ok(target.startsWith(parent) && target.slice(parent.length).startsWith('vera-native-plan-test-'));
    rmSync(target, { recursive: true, force: true });
  }
});

test('installed preflight rejects old or mismatched startup archives before any launch, even with inference consent', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'vera-native-plan-test-'));
  try {
    for (const variant of ['old-version', 'wrong-package', 'wrong-entry', 'missing-entry', 'mismatched-main', 'mismatched-branding', 'reviewed', 'reviewed-renamed']) {
      const app = join(directory, variant), source = join(app, 'archive-source'), evidence = join(app, 'must-not-exist');
      mkdirSync(source, { recursive: true }); mkdirSync(join(app, 'resources'));
      const reviewedVariant = variant === 'reviewed' || variant === 'reviewed-renamed';
      const executable = join(app, variant === 'reviewed-renamed' ? 'V.E.R.A.exe' : 'Mr.Robot.exe');
      // Not executable: a successful negative test proves prelaunch rejection.
      writeFileSync(executable, 'fixture-not-an-executable');
      writeFileSync(join(source, 'package.json'), JSON.stringify({ name: variant === 'wrong-package' ? 'other-app' : 'mr-robot-desktop', version: variant === 'old-version' ? '0.6.17' : '0.7.0', main: variant === 'missing-entry' ? undefined : variant === 'wrong-entry' ? 'other.mjs' : 'main.mjs' }));
      for (const name of ['main.mjs', 'branding.mjs']) {
        const reviewed = readFileSync(new URL(`../../packages/desktop/${name}`, import.meta.url));
        writeFileSync(join(source, name), variant === `mismatched-${name.split('.')[0]}` ? 'unreviewed startup' : reviewed);
      }
      await createPackage(source, join(app, 'resources', 'app.asar'));
      const argv = [fileURLToPath(new URL('./app-native-observation.smoke.mjs', import.meta.url)), '--app-path', executable, '--model', 'gpt-6-sol', '--out-dir', evidence];
      if (!reviewedVariant) argv.push('--allow-account-usage', 'yes');
      const run = spawnSync(process.execPath, argv, { encoding: 'utf8', timeout: 15000, windowsHide: true });
      assert.equal(run.status, reviewedVariant ? 0 : 1, run.stderr);
      if (!reviewedVariant) assert.match(run.stderr, /unsupported_installed_version|unreviewed_installed_startup|unreviewed_installed_entrypoint/);
      else assert.equal(JSON.parse(run.stdout.trim()).inference, false);
      assert.equal(existsSync(evidence), false, 'preflight must happen before output/profile creation');
    }
  } finally {
    const target = resolve(directory), parent = resolve(tmpdir()) + sep;
    assert.ok(target.startsWith(parent) && target.slice(parent.length).startsWith('vera-native-plan-test-'));
    rmSync(target, { recursive: true, force: true });
  }
});
