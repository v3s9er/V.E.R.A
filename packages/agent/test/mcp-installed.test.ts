import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { join, dirname, delimiter } from 'node:path';
import { tmpdir } from 'node:os';
import { installedMcpPresets, mcpChildEnvironment } from '../src/plugins/mcp-installed.js';

test('private venv helpers resolve without inheriting secrets or overriding explicit PATH', () => {
  const command = join(tmpdir(), 'tools', 'serena.exe');
  const base = { PATH: 'base' }, original = structuredClone(base);
  assert.equal(mcpChildEnvironment(command, base, {}).PATH, `${dirname(command)}${delimiter}base`);
  assert.deepEqual(base, original);
  assert.equal(mcpChildEnvironment(command, base, { PATH: 'explicit' }).PATH, 'explicit');
  assert.deepEqual(mcpChildEnvironment('serena', base, {}), base);
});

test('installed preset discovery is bounded, versioned and never registers tools', () => {
  const home = mkdtempSync(join(tmpdir(), 'vera-mcp-installed-'));
  try {
    assert.deepEqual(installedMcpPresets(home).map(row => row.installed), [false, false]);
    const pkg = join(home, 'tools', 'context7-4.2.0', 'node_modules', '@upstash', 'context7-mcp');
    mkdirSync(join(pkg, 'dist'), { recursive: true });
    writeFileSync(join(pkg, 'dist', 'index.js'), 'throw new Error("must not execute")');
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@upstash/context7-mcp', version: 'wrong' }));
    assert.equal(installedMcpPresets(home)[0].installed, false);
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: '@upstash/context7-mcp', version: '4.2.0' }));
    assert.deepEqual(installedMcpPresets(home)[0], { id: 'context7', version: '4.2.0', installed: true, executablePath: realpathSync(join(pkg, 'dist', 'index.js')) });
  } finally { rmSync(home, { recursive: true, force: true }); }
});
