import assert from 'node:assert/strict';
import { test } from 'node:test';
import { probePython, pythonCandidates } from '../test-local-training.mjs';

test('explicit Python path is exact and never interpreted as a shell command', () => {
  assert.deepEqual(pythonCandidates({ MR_ROBOT_PYTHON: 'C:\\Python312\\python.exe' }, 'win32', () => true), [{ command: 'C:\\Python312\\python.exe', prefix: [] }]);
  for (const path of ['python -3', 'C:\\Python312\\python.exe --extra', 'C:\\Python312\\python.cmd', '"C:\\Python312\\python.exe"']) assert.throws(() => pythonCandidates({ MR_ROBOT_PYTHON: path }, 'win32', () => true), /절대 경로/);
});
test('PATH discovery skips Store aliases and gives py the fixed -3 argument', () => {
  const available = new Set(['C:\\Real\\python.exe', 'C:\\Launcher\\py.exe']);
  const candidates = pythonCandidates({ PATH: 'C:\\Users\\Example\\AppData\\Local\\Microsoft\\WindowsApps;C:\\Real;C:\\Launcher' }, 'win32', file => available.has(file));
  assert.deepEqual(candidates, [{ command: 'C:\\Real\\python.exe', prefix: [] }, { command: 'C:\\Launcher\\py.exe', prefix: ['-3'] }]);
});
test('probe is bounded, shell-free and rejects aliases, old Python and malformed output', () => {
  const candidate = { command: 'C:\\Python312\\python.exe', prefix: [] };
  let options;
  const result = probePython(candidate, (_command, args, opts) => { options = opts; assert.equal(args[0], '-I'); return { status: 0, stdout: JSON.stringify({ version: [3, 12, 1], executable: candidate.command }) }; });
  assert.deepEqual(result.version, [3, 12, 1]);
  assert.equal(options.shell, false); assert.equal(options.windowsHide, true); assert.equal(options.timeout, 3000);
  assert.equal(probePython(candidate, () => ({ error: { code: 'ENOENT' }, status: null })), undefined);
  assert.equal(probePython(candidate, () => ({ status: 0, stdout: '{"version":[3,9,9],"executable":"python"}' })), undefined);
  assert.equal(probePython(candidate, () => ({ status: 0, stdout: 'Store alias unavailable' })), undefined);
});
