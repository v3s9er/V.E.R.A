import { DependencyManager } from '../dist/dependencies.js';

const manager = new DependencyManager();
const status = await manager.status();
const expected = ['node', 'git', 'speech-ko', 'codex', 'claude', 'orca', 'ollama', 'cloudflared', 'tailscale', 'docker'];

if (status.map((item) => item.id).join(',') !== expected.join(',')) {
  throw new Error(`unexpected dependency inventory: ${status.map((item) => item.id).join(',')}`);
}
if (!status.every((item) => typeof item.installed === 'boolean' && typeof item.canInstall === 'boolean')) {
  throw new Error('dependency status fields are malformed');
}
if (!manager.has('git') || manager.has('not-a-real-dependency')) {
  throw new Error('dependency allowlist validation failed');
}

console.log('DEPENDENCY CHECK TEST PASSED');
