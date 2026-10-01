import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { createEvidenceTools, evidencePython, parsePythonOnly, needsSourceEvidence, namedPngSources } from '../src/ai/evidence.js';
import { evidenceImageInputs } from '../src/ai/cli-isolated.js';
import { NativeToolEvents } from '../src/ai/native-tool-events.js';
import type { NativeToolEvent } from '../src/ai/provider.js';

const signal = () => new AbortController().signal;
test('native lifecycle counts once, handles missing start, rejects raw reasoning and never exposes payloads', () => {
  let now = 10;
  const events: NativeToolEvent[] = [];
  const tracker = new NativeToolEvents(e => events.push(e), () => now);
  tracker.accept('item/started', { id: 'a', type: 'commandExecution', command: 'PRIVATE_SECRET' });
  tracker.accept('item/started', { id: 'a', type: 'commandExecution' });
  now = 30;
  tracker.accept('item/completed', { id: 'a', type: 'commandExecution', exitCode: 1, output: 'PRIVATE_SECRET' });
  tracker.accept('item/completed', { id: 'a', type: 'commandExecution' });
  tracker.accept('item/completed', { id: 'b', type: 'imageView', path: 'PRIVATE_SECRET' });
  tracker.accept('item/started', { id: 'r', type: 'reasoning', text: 'PRIVATE_SECRET' });
  tracker.accept('item/started', { id: 'p', type: 'constructor' });
  tracker.accept('item/started', { id: 'c', type: 'dynamicToolCall', arguments: 'PRIVATE_SECRET' });
  tracker.finish(); tracker.finish();
  assert.deepEqual(events.map(e => e.status), ['start', 'error', 'start', 'done', 'start', 'error']);
  assert.equal(events[1].elapsedMs, 20);
  assert.ok(!JSON.stringify(events).includes('PRIVATE_SECRET'));
  const disconnected = new NativeToolEvents(() => { throw new Error('disconnected'); });
  assert.doesNotThrow(() => { disconnected.accept('item/started', { id: 'x', type: 'imageView' }); disconnected.finish(); });
});

test('workspace evidence is identity-bound, pixel-exact, bounded and read-only', async () => {
  const root = mkdtempSync(join(tmpdir(), 'mrrobot-evidence-'));
  try {
    const png = new PNG({ width: 8, height: 4 });
    for (let i = 0; i < png.data.length; i++) png.data[i] = i % 256;
    writeFileSync(join(root, 'a.png'), PNG.sync.write(png));
    writeFileSync(join(root, 'b.png'), PNG.sync.write(png));
    const interlaced = PNG.sync.write(png); interlaced[28] = 1;
    writeFileSync(join(root, 'interlaced.png'), interlaced);
    assert.deepEqual(namedPngSources(root, 'a.png와 "b.png"를 비교. https://example.com/a.png ../private.png'), ['a.png', 'b.png']);
    const scoped = createEvidenceTools(root, ['a.png']);
    await assert.rejects(scoped.execute('evidence_image', { path: 'b.png' }, signal()), /assigned/);
    const tool = createEvidenceTools(root);
    await assert.rejects(tool.execute('evidence_image', { path: 'interlaced.png' }, signal()), /Interlaced PNG/);
    const oldPython = process.env.MR_ROBOT_PYTHON;
    try {
      const fake = join(root, 'python.exe'); writeFileSync(fake, 'not executable');
      process.env.MR_ROBOT_PYTHON = fake;
      assert.notEqual(evidencePython(root), fake, 'model-writable interpreter must never run on host');
    } finally { if (oldPython === undefined) delete process.env.MR_ROBOT_PYTHON; else process.env.MR_ROBOT_PYTHON = oldPython; }
    const result = await tool.execute('evidence_image', { path: 'a.png', crop: { x: 2, y: 1, width: 3, height: 2 } }, signal());
    const meta = JSON.parse((result.contentItems[0] as any).text);
    assert.equal(meta.source, 'a.png'); assert.equal(meta.width, 8); assert.equal(meta.height, 4);
    assert.match(meta.sha256, /^[a-f0-9]{64}$/);
    const decoded = PNG.sync.read(Buffer.from((result.contentItems[1] as any).imageUrl.split(',')[1], 'base64'));
    for (let y = 0; y < 2; y++) assert.deepEqual(decoded.data.subarray(y * 12, (y + 1) * 12), png.data.subarray(((y + 1) * 8 + 2) * 4, ((y + 1) * 8 + 5) * 4));
    await assert.rejects(tool.execute('evidence_image', { path: 'a.png', expectedSha256: '0'.repeat(64) }, signal()), /hash changed/);
    await assert.rejects(tool.execute('evidence_image', { path: 'a.png', crop: { x: 0, y: 0, width: 9, height: 4 } }, signal()), /Crop/);
    await assert.rejects(tool.execute('evidence_image', { path: '../outside.png' }, signal()), /밖/);
    await assert.rejects(tool.execute('shell_exec', { path: 'a.png' }, signal()), /Unknown/);
    writeFileSync(join(root, 'big.txt'), 'x'.repeat(32769));
    await assert.rejects(tool.execute('evidence_text', { path: 'big.txt' }, signal()), /too large/);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(tool.execute('evidence_image', { path: 'a.png' }, controller.signal));
    assert.equal(tool.authorize!('evidence_image', 'ask'), false);
    assert.equal(tool.authorize!('evidence_image', 'read-only'), true);
    const nested = join(root, 'link');
    symlinkSync(tmpdir(), nested, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(tool.execute('evidence_text', { path: 'link/secret' }, signal()), /junction|심볼릭/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('python checker compiles DATA only; refuses malformed input without executing side effects', async t => {
  const executable = evidencePython();
  if (!executable) { t.skip('CPython not installed'); return; }
  const root = mkdtempSync(join(tmpdir(), 'mrrobot-syntax-'));
  try {
    const marker = join(root, 'must-not-exist');
    const tool = createEvidenceTools(root);
    const good = await tool.execute('evidence_python_syntax', { source: `open(${JSON.stringify(marker)}, 'w').write('danger')\n` }, signal());
    const parsed = JSON.parse((good.contentItems[0] as any).text);
    assert.equal(parsed.syntaxValid, true); assert.equal(parsed.executed, false);
    assert.equal(existsSync(marker), false);
    const bad = await parsePythonOnly(Buffer.from('open;;open'), executable, signal()) as any;
    assert.equal(bad.syntaxValid, false); assert.equal(bad.line, 1);
    const valid = await parsePythonOnly(Buffer.from('open;open;8**8\n8//8'), executable, signal()) as any;
    assert.equal(valid.syntaxValid, true);
    const missing = await parsePythonOnly(Buffer.from('x'), undefined, signal()) as any;
    assert.equal(missing.available, false); assert.equal(missing.syntaxValid, undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('visual transport rejects URLs, overflow, and preserves source labels', () => {
  const req = { turns: [], evidenceImages: [{ label: 'a.png hash', dataUrl: 'data:image/png;base64,YWJj' }] };
  assert.equal(evidenceImageInputs(req)[1].type, 'image');
  assert.throws(() => evidenceImageInputs({ ...req, evidenceImages: [{ label: 'a', dataUrl: 'https://example.com/private' }] }));
  assert.throws(() => evidenceImageInputs({ ...req, evidenceImages: Array(5).fill(req.evidenceImages[0]) }));
  assert.equal(needsSourceEvidence('read tablet.png'), true);
  assert.equal(needsSourceEvidence('hello'), false);
});
