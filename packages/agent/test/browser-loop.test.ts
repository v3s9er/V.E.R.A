import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import test, { type TestContext } from 'node:test';
import { AgentLoop } from '../src/ai/loop.js';
import { ToolExecutor } from '../src/ai/executor.js';
import { browserCoordinator, BROWSER_TOOLS } from '../src/computer/browser-session.js';
import type { AiProvider, NativeHostTools, ProviderResult } from '../src/ai/provider.js';

const result = (text = 'synthetic done', toolCalls: ProviderResult['toolCalls'] = []): ProviderResult => ({ text, toolCalls, usage: { promptTokens: 1, completionTokens: 1 } });
const selected = (overrides: Partial<AiProvider> = {}): AiProvider => ({ id: 'synthetic-provider', label: 'Synthetic provider', type: 'openai-compatible', model: 'synthetic-model', supportedReasoning: ['auto', 'high'], supportsTools: true,
  chat: async () => result(), ping: async () => ({ ok: true }), models: async () => ['synthetic-model'], ...overrides });
const registry = (provider: AiProvider) => ({ default: () => provider, getForModel: () => provider, toolCapable: () => provider }) as any;
const options = { workspacePath: tmpdir(), permissionMode: 'full' as const, reasoningEffort: 'high' as const, cacheKey: 'synthetic-browser-run', nativeSessionDirectory: tmpdir() };
const request = 'Open a browser to inspect the explicitly requested local web app and verify its page.';

function fakeOwnedBrowser(t: TestContext) {
  const owners: Array<{ calls: string[]; disposed: number }> = [];
  t.mock.method(browserCoordinator, 'create', (authorize: () => void): NativeHostTools => {
    const owner = { calls: [] as string[], disposed: 0 }; owners.push(owner);
    return { tools: BROWSER_TOOLS,
      execute: async name => { authorize(); owner.calls.push(name); return { success: true, contentItems: [{ type: 'inputText', text: '{"source":"synthetic owned page"}' }] }; },
      dispose: () => { owner.disposed++; } };
  });
  return owners;
}
const executor = (mode: () => string = () => 'full') => new ToolExecutor({ computer: {} as any, safety: () => ({ mode: mode() } as any) });

test('native Codex bridge exposes full-only browser tools, owns one scope across continuation, and disposes each run', { skip: process.platform !== 'win32' }, async t => {
  const owners = fakeOwnedBrowser(t); let nativeCalls = 0;
  const provider = selected({ type: 'codex-cli', supportsTools: false, chat: async () => { throw Error('must use native route'); },
    runAgent: async req => {
      nativeCalls++;
      assert.equal(req.permissionMode, 'full'); assert.equal(req.reasoningEffort, 'high');
      assert.ok(req.hostTools?.tools.some(tool => tool.name === 'browser_open'));
      assert.match(req.session!.instructions, /owned temporary Edge\/Chrome/);
      assert.equal(req.hostTools!.authorize!('browser_open', 'workspace'), false);
      assert.equal(req.hostTools!.authorize!('browser_open', 'full'), true);
      await req.hostTools!.execute('browser_open', { browser: 'edge', url: 'http://127.0.0.1:45678/' }, new AbortController().signal);
      await req.hostTools!.execute('browser_observe', {}, new AbortController().signal);
      // Disposing a per-turn bridge must not retire the parent run's browser.
      req.hostTools!.dispose(); assert.equal(owners.at(-1)!.disposed, 0);
      return result();
    } });
  const loop = new AgentLoop(registry(provider), executor());
  let steering = 0;
  await loop.run([], request, { takeSteering: () => ++steering === 1 ? ['Continue checking the same synthetic browser'] : [] }, [], options);
  assert.equal(nativeCalls, 2); assert.equal(owners.length, 1);
  assert.deepEqual(owners[0].calls, ['browser_open', 'browser_observe', 'browser_open', 'browser_observe']);
  assert.equal(owners[0].disposed, 1);
  await loop.run([], request, {}, [], options);
  assert.equal(owners.length, 2, 'another run must not reuse a prior owned browser scope');
  assert.equal(owners[1].disposed, 1);
});

test('native bridge does not expose browser to workspace/read-only/ask, non-Codex or sessionless routes', { skip: process.platform !== 'win32' }, async t => {
  const owners = fakeOwnedBrowser(t);
  for (const variant of [
    { permissionMode: 'workspace' }, { permissionMode: 'read-only' }, { permissionMode: 'ask' },
    { cacheKey: undefined }, { nativeSessionDirectory: undefined }, { type: 'claude-cli' },
  ]) {
    let calls = 0;
    const provider = selected({ type: (variant.type ?? 'codex-cli') as AiProvider['type'], supportsTools: false, runAgent: async req => {
      calls++; assert.equal(req.hostTools?.tools.some(tool => tool.name.startsWith('browser_')) ?? false, false); return result();
    } });
    await new AgentLoop(registry(provider), executor()).run([], request, {}, [], { ...options, ...variant } as any);
    assert.equal(calls, variant.permissionMode === 'ask' ? 0 : 1, `native invocation count: ${JSON.stringify(variant)}`);
  }
  assert.equal(owners.length, 0);
});

test('API browser bridge shares one owned scope, carries results, and disposes after synthesis', { skip: process.platform !== 'win32' }, async t => {
  const owners = fakeOwnedBrowser(t); let calls = 0;
  const provider = selected({ chat: async req => {
    assert.ok(req.tools?.some(tool => tool.name === 'browser_open'));
    assert.match(req.system!, /no existing user login\/cookies/);
    calls++;
    if (calls <= 2) return result('', [{ id: `synthetic-${calls}`, name: calls === 1 ? 'browser_open' : 'browser_observe', args: calls === 1 ? JSON.stringify({ browser: 'edge', url: 'http://127.0.0.1:45678/' }) : '{}' }]);
    assert.match(req.turns.at(-1)!.toolResults![0].content, /synthetic owned page/);
    return result();
  } });
  await new AgentLoop(registry(provider), executor()).run([], request, {}, [], options);
  assert.equal(calls, 3); assert.equal(owners.length, 1);
  assert.deepEqual(owners[0].calls, ['browser_open', 'browser_observe']); assert.equal(owners[0].disposed, 1);
});

test('API permission/isolation gates exclude browser and plain responses never create a context', { skip: process.platform !== 'win32' }, async t => {
  const owners = fakeOwnedBrowser(t);
  for (const patch of [{ permissionMode: 'workspace' }, { permissionMode: 'read-only' }, { permissionMode: 'ask' }, { isolation: { tools: [], execute: async () => 'synthetic denied' } }]) {
    const provider = selected({ chat: async req => { assert.equal(req.tools?.some(tool => tool.name.startsWith('browser_')) ?? false, false); return result(); } });
    await new AgentLoop(registry(provider), executor()).run([], request, {}, [], { ...options, ...patch } as any);
  }
  await new AgentLoop(registry(selected()), executor()).run([], request, {}, [], options);
  assert.equal(owners.length, 0, 'advertising tools is not permission to launch a browser before a call');
});

test('live authority revocation prevents later browser calls and failed native execution still disposes', { skip: process.platform !== 'win32' }, async t => {
  const owners = fakeOwnedBrowser(t); let mode = 'full';
  const provider = selected({ type: 'codex-cli', supportsTools: false, runAgent: async req => {
    await req.hostTools!.execute('browser_open', { browser: 'edge', url: 'http://127.0.0.1:45678/' }, new AbortController().signal);
    mode = 'read-only';
    await req.hostTools!.execute('browser_observe', {}, new AbortController().signal);
    throw Error('unreachable');
  } });
  await assert.rejects(new AgentLoop(registry(provider), executor(() => mode)).run([], request, {}, [], options), /접근/);
  assert.deepEqual(owners[0].calls, ['browser_open']); assert.equal(owners[0].disposed, 1);
});
