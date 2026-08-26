import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import {
  CliProvider,
  CURRENT_CLAUDE_MODELS,
  CURRENT_CODEX_MODELS,
  cliSubscriptionEnvironment,
  extractCliModels,
  resolveCliInvocation,
} from '../dist/ai/cli.js';

const claudeEnv = cliSubscriptionEnvironment('claude-cli', { ANTHROPIC_API_KEY: 'must-not-leak', KEEP_ME: 'yes' });
if (claudeEnv.ANTHROPIC_API_KEY || claudeEnv.KEEP_ME !== 'yes') throw new Error('Claude subscription environment was not isolated');
const codexEnv = cliSubscriptionEnvironment('codex-cli', { OPENAI_API_KEY: 'must-not-leak', KEEP_ME: 'yes' });
if (codexEnv.OPENAI_API_KEY || codexEnv.KEEP_ME !== 'yes') throw new Error('Codex subscription environment was not isolated');
if (codexEnv.RUST_LOG !== 'error') throw new Error('Codex native runs must suppress non-actionable Windows warnings');
const cliSource = readFileSync(new URL('../src/ai/cli.ts', import.meta.url), 'utf8');
if (!/child\.stdin\.end\(this\.type === 'codex-cli' \? req\.prompt/.test(cliSource)) throw new Error('Codex native prompt must be closed through stdin instead of waiting for additional input');
if (!cliSource.includes('cliFailure(this.label, code, stdout, stderr)')) throw new Error('native CLI errors must include structured stdout diagnostics');

for (const expected of ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']) {
  if (!CURRENT_CODEX_MODELS.includes(expected)) throw new Error(`missing Codex model: ${expected}`);
}
for (const expected of ['fable', 'opus', 'sonnet', 'haiku', 'claude-fable-5', 'claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5']) {
  if (!CURRENT_CLAUDE_MODELS.includes(expected)) throw new Error(`missing Claude model: ${expected}`);
}
const parsedClaude = extractCliModels('claude-cli', "aliases 'fable', 'opus', or 'sonnet'; full name 'claude-fable-5'");
for (const expected of ['fable', 'opus', 'sonnet', 'claude-fable-5']) {
  if (!parsedClaude.includes(expected)) throw new Error(`Claude help parser missed: ${expected}`);
}

if (process.platform === 'win32') {
  const invocation = resolveCliInvocation('codex-cli', 'codex');
  if (invocation.command.toLowerCase() === 'codex') throw new Error('Codex npm shim was not resolved');
  const result = await new Promise((resolve, reject) => {
    const child = spawn(invocation.command, [...invocation.prefixArgs, '--version'], { shell: false, windowsHide: true });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, output }));
  });
  if (result.code !== 0 || !/codex-cli/i.test(result.output)) throw new Error(`resolved Codex CLI failed: ${JSON.stringify(result)}`);
}

const claudeProvider = new CliProvider('test-claude', 'Claude', 'claude-cli', '', 'sonnet', 'claude');
const claudeModels = await claudeProvider.models();
for (const expected of ['fable', 'opus', 'sonnet', 'haiku']) {
  if (!claudeModels.includes(expected)) throw new Error(`Claude discovery missed: ${expected}`);
}

console.log('WINDOWS CLI RESOLUTION TEST PASSED');
