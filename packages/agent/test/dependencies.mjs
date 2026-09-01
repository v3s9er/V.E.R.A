import { DependencyManager } from '../dist/dependencies.js';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src/dependencies.ts', import.meta.url), 'utf8');
for (const required of [
  '@openai/codex@0.148.0', '@anthropic-ai/claude-code@2.1.237',
  'sherpa-onnx==1.13.6', 'sounddevice==0.5.6', '--only-binary=:all:',
  'SENSE_VOICE_SHA256', 'KOREAN_VOICE_SHA256', 'SILERO_VAD_SHA256',
  'downloadVerified', 'SAFE_TAR_EXTRACTION', 'links and special archive entries are not allowed',
  'dependencyEnvironment()', 'terminateProcessTree(child)',
]) {
  if (!source.includes(required)) throw new Error(`dependency supply-chain hardening is missing: ${required}`);
}
if (source.includes('@latest') || source.includes('sounddevice>=') || source.includes('env: process.env')) {
  throw new Error('dependency installation still contains an unpinned or inherited-environment path');
}

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
