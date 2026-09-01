import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import {
  CliProvider,
  CURRENT_CLAUDE_MODELS,
  CURRENT_CODEX_MODELS,
  cliSubscriptionEnvironment,
  extractCliModels,
  parseClaudeOutput,
  parseCodexOutput,
  resolveCliInvocation,
  safeCliExtraArgs,
} from '../dist/ai/cli.js';

const parsedClaudeUsage = parseClaudeOutput(JSON.stringify({
  result: 'claude-result',
  usage: {
    input_tokens: 120,
    output_tokens: 30,
    cache_creation_input_tokens: 20,
    cache_read_input_tokens: 40,
    output_tokens_details: { thinking_tokens: 12 },
  },
}));
if (parsedClaudeUsage.text !== 'claude-result'
  || parsedClaudeUsage.usage.promptTokens !== 180
  || parsedClaudeUsage.usage.completionTokens !== 30
  || parsedClaudeUsage.usage.cachedPromptTokens !== 40
  || parsedClaudeUsage.usage.cacheWritePromptTokens !== 20
  || parsedClaudeUsage.usage.reasoningTokens !== 12) throw new Error('Claude CLI usage was not parsed conservatively');

const parsedCodexUsage = parseCodexOutput([
  JSON.stringify({ type: 'item.completed', item: { text: 'codex-result' } }),
  JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 200, cached_input_tokens: 75, output_tokens: 50, output_tokens_details: { reasoning_tokens: 18 } } }),
].join('\n'));
if (parsedCodexUsage.text !== 'codex-result'
  || parsedCodexUsage.usage.promptTokens !== 200
  || parsedCodexUsage.usage.completionTokens !== 50
  || parsedCodexUsage.usage.cachedPromptTokens !== 75
  || parsedCodexUsage.usage.reasoningTokens !== 18) throw new Error('Codex CLI JSONL usage was not parsed');

const syntheticEnv = {
  PATH: 'C:\\safe-bin', SystemRoot: 'C:\\Windows', USERPROFILE: 'C:\\Users\\tester',
  ANTHROPIC_API_KEY: 'must-not-leak', OPENAI_API_KEY: 'must-not-leak',
  AWS_SECRET_ACCESS_KEY: 'must-not-leak', GITHUB_TOKEN: 'must-not-leak',
  CLOUDFLARE_API_TOKEN: 'must-not-leak', KEEP_ME: 'also-must-not-leak',
};
const claudeEnv = cliSubscriptionEnvironment('claude-cli', syntheticEnv);
if (claudeEnv.ANTHROPIC_API_KEY || claudeEnv.KEEP_ME || claudeEnv.AWS_SECRET_ACCESS_KEY || claudeEnv.PATH !== 'C:\\safe-bin') {
  throw new Error('Claude subscription environment was not reduced to the explicit allowlist');
}
const codexEnv = cliSubscriptionEnvironment('codex-cli', syntheticEnv);
if (codexEnv.OPENAI_API_KEY || codexEnv.GITHUB_TOKEN || codexEnv.CLOUDFLARE_API_TOKEN || codexEnv.KEEP_ME || codexEnv.SystemRoot !== 'C:\\Windows') {
  throw new Error('Codex subscription environment was not reduced to the explicit allowlist');
}
if (codexEnv.RUST_LOG !== 'error') throw new Error('Codex native runs must suppress non-actionable Windows warnings');
const safeClaudeArgs = safeCliExtraArgs('claude-cli', [
  '--dangerously-skip-permissions', '--mcp-config', 'evil.json', '--fallback-model', 'haiku', '--add-dir', 'C:\\',
]);
if (JSON.stringify(safeClaudeArgs) !== JSON.stringify(['--fallback-model', 'haiku'])) throw new Error('unsafe Claude extra arguments were not removed');
const safeCodexArgs = safeCliExtraArgs('codex-cli', ['--sandbox', 'danger-full-access', '--color', 'never', '--config', 'approval_policy="never"']);
if (JSON.stringify(safeCodexArgs) !== JSON.stringify(['--color', 'never'])) throw new Error('unsafe Codex extra arguments were not removed');
const cliSource = readFileSync(new URL('../src/ai/cli.ts', import.meta.url), 'utf8');
if (!/stdin: this\.type === 'codex-cli' \? req\.prompt/.test(cliSource)) throw new Error('Codex native prompt must be closed through stdin instead of waiting for additional input');
if (!cliSource.includes('cliFailure(options.label, code, stdout, stderr)')) throw new Error('native CLI errors must include structured stdout diagnostics');
for (const required of ['--ignore-user-config', '--ignore-rules', '--safe-mode', '--strict-mcp-config', 'CHAT_TIMEOUT_MS', 'NATIVE_AGENT_TIMEOUT_MS']) {
  if (!cliSource.includes(required)) throw new Error(`missing native CLI hardening: ${required}`);
}

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
let claudeWorkspaceRejected = false;
try {
  await claudeProvider.runAgent({ prompt: 'do not run', cwd: process.cwd(), permissionMode: 'workspace' });
} catch (error) {
  claudeWorkspaceRejected = String(error).includes('완전 접근');
}
if (!claudeWorkspaceRejected) throw new Error('Claude native tools must fail closed outside explicit full access');
const claudeModels = await claudeProvider.models();
for (const expected of ['fable', 'opus', 'sonnet', 'haiku']) {
  if (!claudeModels.includes(expected)) throw new Error(`Claude discovery missed: ${expected}`);
}

console.log('WINDOWS CLI RESOLUTION TEST PASSED');
