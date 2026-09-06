import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readDiscordFile } from '../src/server/discord-files.js';

const root = mkdtempSync(join(tmpdir(), 'discord-file-test-'));
try {
  const path = join(root, '[자료] test.pdf');
  writeFileSync(path, 'fixture content');
  const part = readDiscordFile(root, path, 0, 100);
  assert.equal(Buffer.from(part.data, 'base64').toString(), 'fixture content');
  assert.equal(part.name, '[자료] test.pdf');
  assert.equal(readDiscordFile(root, path, part.size, 100, part.version).done, true);
  assert.throws(() => readDiscordFile(root, path, 0, 2), /한도/);
  assert.throws(() => readDiscordFile(root, path, -1, 100));
  assert.throws(() => readDiscordFile(root, join(root, '../outside.pdf'), 0, 100));
  writeFileSync(path, 'changed content!');
  assert.throws(() => readDiscordFile(root, path, 0, 100, part.version), /변경/);
  console.log('Discord files passed: real bytes, Unicode filename, bounded read, traversal/size/version rejection');
} finally { rmSync(root, { recursive: true, force: true }); }
