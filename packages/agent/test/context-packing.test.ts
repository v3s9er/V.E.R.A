import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, type TestContext } from 'node:test';
import { ContextBroker } from '../src/context-broker.js';

function fixture(t: TestContext, limits?: [number, number, number]) {
  const dir = mkdtempSync(join(tmpdir(), 'mr-robot-context-packing-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { dir, broker: limits ? new ContextBroker(dir, ...limits) : new ContextBroker(dir) };
}

function wellFormed(text: string): boolean {
  return [...text].every(character => {
    const point = character.codePointAt(0)!;
    return point < 0xD800 || point > 0xDFFF;
  });
}

test('role packs preserve a fitting original request and contributions from every selected handoff', (t) => {
  const { broker } = fixture(t);
  const request = 'Change only the parser; preserve the public API and verify Korean input.';
  const handoffs = [
    { label: 'analysis', text: `ANALYSIS-HEAD ${'a'.repeat(4_000)} ANALYSIS-TAIL` },
    { label: 'review', text: `REVIEW-HEAD ${'b'.repeat(4_000)} REVIEW-TAIL` },
    { label: 'test', text: 'A short useful finding.' },
  ];
  const result = broker.rolePack('implementer', request, handoffs, 1_200);
  assert.ok(result.startsWith(`Original request:\n${request}`));
  assert.match(result, /ANALYSIS-HEAD/);
  assert.match(result, /REVIEW-HEAD/);
  assert.match(result, /A short useful finding\./);
  assert.match(result, /context truncated/);
  assert.ok(result.length <= 1_200);
});

test('large original requests remain first and keep both task boundaries under the exact pack budget', (t) => {
  const { broker } = fixture(t);
  const original = `REQUEST-HEAD ${'요청😀'.repeat(4_000)} REQUEST-TAIL`;
  const handoffs = [{ label: 'evidence', text: `EVIDENCE-HEAD ${'결과'.repeat(4_000)} EVIDENCE-TAIL` }];
  const result = broker.rolePack('reviewer', original, handoffs, 1_024);
  assert.ok(result.startsWith('Original request:\nREQUEST-HEAD'));
  assert.match(result, /REQUEST-TAIL/);
  assert.match(result, /EVIDENCE-HEAD/);
  assert.match(result, /EVIDENCE-TAIL/);
  assert.match(result, /context truncated/);
  assert.ok(result.indexOf('REQUEST-HEAD') < result.indexOf('EVIDENCE-HEAD'));
  assert.ok(result.length <= 1_024);
  assert.equal(wellFormed(result), true);
});

test('a fitting task is preserved before adding more handoffs or verbose labels', (t) => {
  const { broker } = fixture(t);
  const original = `TASK ${'a'.repeat(486)} END`;
  const handoffs = Array.from({ length: 8 }, (_, index) => ({ label: `review-${index}`, text: 'evidence'.repeat(100) }));
  for (const budget of [510, 530, 600, 700, 800]) {
    const result = broker.rolePack('reviewer', original, handoffs, budget);
    assert.ok(result.includes(original), `fitting request was truncated at budget=${budget}`);
    assert.ok(result.length <= budget);
    assert.match(result, /…|omitted/);
  }
});

test('tiny and fractional budgets include all headers and omission markers without broken Unicode', (t) => {
  const { broker } = fixture(t);
  const request = `TASK ${'한😀'.repeat(200)} END`;
  for (let budget = 0; budget <= 512; budget++) {
    for (const handoffs of [[], [{ label: '검토😀', text: '증거😀'.repeat(100) }]]) {
      const result = broker.rolePack('역할😀', request, handoffs, budget + 0.75);
      assert.ok(result.length <= budget, `budget=${budget}, actual=${result.length}`);
      assert.equal(wellFormed(result), true, `budget=${budget}`);
      if (budget > 0) assert.match(result, /…|omitted/);
      if (budget >= 6) assert.ok(result.includes('TASK'), `task lost at budget=${budget}`);
    }
  }
  assert.equal(broker.rolePack('role', 'task', [], 0), '');
  assert.equal(broker.rolePack('role', 'task', [], -1), '');
  assert.equal(broker.rolePack('role', '', [], 40), '');
  assert.ok(broker.rolePack('role', 'x'.repeat(30_000), [], NaN).length <= 18_000);
});

test('a bounded number of handoffs and bounded role labels cannot crowd out the original task', (t) => {
  const { broker } = fixture(t);
  const handoffs = Array.from({ length: 10_000 }, (_, index) => ({ label: `stage-${index}`, text: `finding-${index}` }));
  const result = broker.rolePack('reviewer', 'ORIGINAL TASK', handoffs, 18_000);
  assert.ok(result.startsWith('Original request:\nORIGINAL TASK'));
  assert.equal((result.match(/\[stage-/g) ?? []).length, 24);
  assert.match(result, /\[9976 handoffs omitted\]/);
  const hugeLabel = broker.rolePack('r'.repeat(100_000), 'ORIGINAL TASK', [{ label: 'l'.repeat(100_000), text: 'useful result' }], 500);
  assert.match(hugeLabel, /ORIGINAL TASK/);
  assert.match(hugeLabel, /useful result/);
  assert.ok(hugeLabel.length <= 500);
  assert.doesNotMatch(hugeLabel, /r{49}|l{65}/);
});

test('UTF-8 reads honor byte ceilings and never invent a partial trailing character', (t) => {
  const { broker, dir } = fixture(t);
  const path = join(dir, 'korean.txt');
  writeFileSync(path, '가😀나다', 'utf8');
  for (let budget = 0; budget <= 14; budget++) {
    const result = broker.read(path, budget);
    assert.ok(Buffer.byteLength(result.content, 'utf8') <= budget);
    assert.equal(wellFormed(result.content), true);
    assert.doesNotMatch(result.content, /�/);
    assert.ok('가😀나다'.startsWith(result.content));
    assert.equal(result.truncated, result.content !== '가😀나다');
  }
  const invalid = join(dir, 'invalid-utf8.bin');
  writeFileSync(invalid, Buffer.from([0xff, 0xff, 0xff, 0xff]));
  for (let budget = 0; budget <= 4; budget++) assert.ok(Buffer.byteLength(broker.read(invalid, budget).content, 'utf8') <= budget);
});

test('Korean evidence receives the requested character allocation while reads and cache remain byte bounded', (t) => {
  const { broker, dir } = fixture(t, [4, 64, 32]);
  const paths = Array.from({ length: 3 }, (_, index) => {
    const path = join(dir, `evidence-${index}.txt`);
    writeFileSync(path, '가나다라마바사아자차', 'utf8');
    return path;
  });
  const result = broker.evidence(paths, 7);
  assert.equal(result.length, 3);
  assert.equal(result.reduce((sum, item) => sum + item.excerpt.length, 0), 7);
  assert.deepEqual(result.map(item => item.excerpt), ['가나', '가나', '가나다']);
  assert.ok(result.every(item => item.truncated && wellFormed(item.excerpt)));
  assert.ok(broker.stats().bytes <= 64);
  assert.equal(broker.evidence(paths, 0).length, 0);
  const emoji = join(dir, 'emoji.txt');
  writeFileSync(emoji, '😀😀😀', 'utf8');
  for (let budget = 1; budget < 7; budget++) {
    const [entry] = broker.evidence([emoji], budget);
    assert.ok(entry!.excerpt.length <= budget);
    assert.equal(wellFormed(entry!.excerpt), true);
    assert.doesNotMatch(entry!.excerpt, /�/);
  }
});

test('evidence bounds path count and length before resolving or reading candidates', (t) => {
  const { broker, dir } = fixture(t);
  const path = join(dir, 'real.txt');
  writeFileSync(path, 'real evidence', 'utf8');
  assert.equal(broker.evidence(['x'.repeat(10_000), path], 100).length, 1);
  assert.equal(broker.evidence([...Array.from({ length: 128 }, (_, index) => join(dir, `missing-${index}`)), path], 100).length, 0);
  const entries = broker.evidence(Array(10_000).fill(path), 100);
  assert.equal(entries.length, 1);
  assert.equal(broker.evidence([dir, path], 100).length, 1);
});

test('cache capacity, prefix reuse, invalidation and zero capacities remain bounded', (t) => {
  const { broker, dir } = fixture(t, [2, 16, 10]);
  const paths = Array.from({ length: 4 }, (_, index) => {
    const path = join(dir, `cache-${index}.txt`);
    writeFileSync(path, 'abcdef'.repeat(100), 'utf8');
    return path;
  });
  assert.equal(broker.read(paths[0]!, 8).cached, false);
  assert.equal(broker.read(paths[0]!, 4).cached, true);
  assert.equal(broker.read(paths[0]!, 10).cached, false);
  for (const path of paths) {
    assert.ok(Buffer.byteLength(broker.read(path, 1_000).content) <= 10);
    assert.ok(broker.stats().bytes <= 16);
    assert.ok(broker.stats().entries <= 2);
  }
  broker.invalidate(paths[3]);
  assert.equal(broker.read(paths[3]!, 8).cached, false);
  broker.invalidate();
  assert.equal(broker.stats().bytes, 0);
  assert.equal(broker.stats().entries, 0);
  const disabled = new ContextBroker(dir, 0, 0, 0);
  assert.equal(disabled.read(paths[0]!, 100).content, '');
  assert.equal(disabled.stats().bytes, 0);
  assert.equal(disabled.stats().entries, 0);
  assert.throws(() => new ContextBroker(dir, -1), /limits/);
});
