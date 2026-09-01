import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = fileURLToPath(new URL('.', import.meta.url));
const dist = resolve(here, '..', 'dist');
const home = mkdtempSync(join(tmpdir(), 'mr-robot-core-hardening-'));
process.env.MR_ROBOT_HOME = home;

const { ChatSession } = await import(pathToFileURL(join(dist, 'server', 'chat.js')).href);
const { cleanupDisconnectedClientState } = await import(pathToFileURL(join(dist, 'server', 'ws.js')).href);
const { ContextBroker } = await import(pathToFileURL(join(dist, 'context-broker.js')).href);
const { ToolExecutor } = await import(pathToFileURL(join(dist, 'ai', 'executor.js')).href);
const { OpenAICompatibleProvider } = await import(pathToFileURL(join(dist, 'ai', 'openai.js')).href);
const { runShell } = await import(pathToFileURL(join(dist, 'computer', 'shell.js')).href);
const { AgentServer } = await import(pathToFileURL(join(dist, 'server', 'server.js')).href);
const { serverEventAudience } = await import(pathToFileURL(join(dist, 'server', 'server.js')).href);
const { isEncryptedTailnetTransport, requiresSecureApiTransport } = await import(pathToFileURL(join(dist, 'server', 'http.js')).href);
const { ConfigStore } = await import(pathToFileURL(join(dist, 'config.js')).href);
const { ConversationStore } = await import(pathToFileURL(join(dist, 'conversations.js')).href);

let failures = 0;
function check(name, condition, detail = '') {
  if (condition) console.log(`  ok  ${name}`);
  else {
    failures++;
    console.error(`FAIL  ${name} ${detail}`);
  }
}

console.log('1. cancellation settles confirmations and steering');
{
  const session = new ChatSession();
  session.begin();
  session.steer('queued instruction');
  const pending = session.askConfirm(() => undefined, { conversationId: 'test-conversation', conversationTitle: 'test', tool: 'write_file', input: {}, summary: 'test' });
  session.cancel();
  const approved = await Promise.race([
    pending,
    new Promise((resolvePending) => setTimeout(() => resolvePending('timeout'), 250)),
  ]);
  check('pending confirmation settles false immediately', approved === false);
  check('cancel aborts run and clears steering', session.signal()?.aborted === true && session.steeringQueued === 0);
  session.end();
}

console.log('1b. API transport guard is case-variant safe');
{
  check('normal API credentials require secure transport', requiresSecureApiTransport('/api/status') === true);
  check('CGNAT source is trusted only when the local socket is on the Tailnet adapter',
    isEncryptedTailnetTransport('100.90.1.2', '100.101.2.3', new Set(['100.101.2.3'])) === true
    && isEncryptedTailnetTransport('100.90.1.2', '100.101.2.3', new Set()) === false
    && isEncryptedTailnetTransport('100.90.1.2', '192.168.1.10', new Set(['100.101.2.3'])) === false);
  check('mixed-case pairing route cannot bypass the guard', requiresSecureApiTransport('/API/pair') === true);
  check('mixed-case protected API route cannot bypass the guard', requiresSecureApiTransport('/Api/status') === true);
  check('only the public health probe is exempt', requiresSecureApiTransport('/API/PING') === false);
  check('non-API pages remain outside the API transport guard', requiresSecureApiTransport('/settings') === false);
}

console.log('1c. server event visibility is fail-closed');
{
  check('conversation summaries remain available to paired clients', serverEventAudience('conversations.changed') === 'paired');
  check('private work-calendar revisions use a capability-scoped audience', serverEventAudience('calendar.work.changed') === 'private-calendar');
  check('scheduler/log/voice/provider events require administrator', [
    'scheduler.changed', 'scheduler.ran', 'log', 'voice.command', 'voice.status', 'providers.changed', 'plugins.changed', 'dependencies.changed', 'remote-link.changed',
  ].every((event) => serverEventAudience(event) === 'admin'));
  check('new unreviewed event types are not broadcast', serverEventAudience('future.unreviewed.secret') === 'none');
}

console.log('2. global permission is a hard ceiling');
{
  let writes = 0;
  const executor = new ToolExecutor({
    computer: {
      fs: {
        write: async () => { writes++; return { path: 'x', bytes: 1 }; },
      },
    },
    safety: () => ({ mode: 'read-only', maxReadBytes: 64, maxShellBytes: 64, allowedRoots: [] }),
  });
  const result = JSON.parse(await executor.execute('write_file', { path: 'C:\\tmp\\x', content: 'x' }, async () => true, 'full'));
  check('per-run full cannot bypass global read-only', writes === 0 && /blocked/.test(result.error ?? ''), JSON.stringify(result));

  const largePluginExecutor = new ToolExecutor({
    computer: {},
    safety: () => ({ mode: 'ask', maxReadBytes: 64 * 1024, maxShellBytes: 64 * 1024, allowedRoots: [] }),
    runPluginTool: async () => ({ payload: '한'.repeat(180_000) }),
    pluginToolDestructive: () => false,
  });
  const boundedPluginResult = await largePluginExecutor.execute('plugin.large', {}, async () => true, 'ask');
  const boundedPluginPayload = JSON.parse(boundedPluginResult);
  check('all plugin tool results obey the persisted context ceiling', Buffer.byteLength(boundedPluginResult, 'utf8') < 512 * 1024 && /작업 폴더/.test(boundedPluginPayload.error ?? ''), String(Buffer.byteLength(boundedPluginResult, 'utf8')));
}

console.log('3. context cache is byte bounded and never reads a whole large file');
{
  const file = join(home, 'large.txt');
  writeFileSync(file, Buffer.alloc(4 * 1024 * 1024, 120));
  const broker = new ContextBroker(home, 2, 1024, 1024);
  const first = broker.read(file, 64 * 1024);
  const second = broker.read(file, 64);
  check('large read is truncated to entry byte cap', first.truncated && Buffer.byteLength(first.content) <= 1024);
  check('smaller repeat uses cached prefix', second.cached === true);
  check('reported cache bytes stay under byte budget', broker.stats().bytes <= 1024, JSON.stringify(broker.stats()));

  const evidenceFiles = ['evidence-a.txt', 'evidence-b.txt', 'evidence-c.txt'].map((name, index) => {
    const target = join(home, name);
    writeFileSync(target, String(index + 1).repeat(100));
    return target;
  });
  const tinyPack = broker.evidence(evidenceFiles, 7);
  const evidenceChars = tinyPack.reduce((sum, item) => sum + item.excerpt.length, 0);
  check('shared evidence pack never exceeds the caller budget', tinyPack.length === 3 && evidenceChars <= 7 && tinyPack.every((item) => item.excerpt.length > 0), JSON.stringify(tinyPack));
}

console.log('3b. conversation compaction preserves tool-call/result boundaries');
{
  const compactHome = join(home, 'compact-store');
  const store = new ConversationStore(compactHome);
  const conversation = store.create({ title: 'compaction test' });
  const large = 'x'.repeat(6_000);
  const history = [
    { role: 'user', content: large },
    { role: 'assistant', content: large },
    { role: 'user', content: large },
    { role: 'assistant', content: large },
    { role: 'user', content: large },
    { role: 'assistant', content: large, toolCalls: [{ id: 'paired-call', name: 'read_file', args: '{"path":"x"}' }] },
    { role: 'tool', content: '', toolResults: [{ id: 'paired-call', name: 'read_file', content: large }] },
    { role: 'assistant', content: large },
    { role: 'user', content: large },
    { role: 'assistant', content: large },
    { role: 'user', content: large },
    { role: 'assistant', content: large },
    { role: 'user', content: large },
    { role: 'assistant', content: large },
    { role: 'user', content: large },
    { role: 'assistant', content: large },
    { role: 'user', content: large },
    { role: 'assistant', content: large },
  ];
  store.appendResult(conversation.id, history, { promptTokens: 1, completionTokens: 1 });
  const retained = store.turns(conversation.id);
  check('compaction retains the assistant call before its tool result', retained[0]?.role === 'assistant' && retained[0]?.toolCalls?.[0]?.id === 'paired-call' && retained[1]?.role === 'tool' && retained[1]?.toolResults?.[0]?.id === 'paired-call', retained.map((turn) => turn.role).join(','));
  check('compaction still removes old context and writes a summary', retained.length < history.length && Boolean(store.contextSummary(conversation.id)));

  const wide = '한'.repeat(6_000);
  const wideHistory = history.map((turn) => ({
    ...turn,
    content: turn.content ? wide : '',
    ...(turn.toolResults ? { toolResults: turn.toolResults.map((result) => ({ ...result, content: wide })) } : {}),
  }));
  for (let cycle = 0; cycle < 8; cycle++) {
    store.appendResult(conversation.id, wideHistory, { promptTokens: 1, completionTokens: 1 });
  }
  const boundedSummary = store.contextSummary(conversation.id) ?? '';
  const reopened = new ConversationStore(compactHome);
  check('multibyte summaries remain inside the reload byte limit', Buffer.byteLength(boundedSummary, 'utf8') <= 64 * 1024 && reopened.get(conversation.id)?.id === conversation.id, String(Buffer.byteLength(boundedSummary, 'utf8')));

  const atomicConversation = store.create({ title: 'atomic size validation' });
  store.appendResult(atomicConversation.id, [
    { role: 'user', content: 'keep this request' },
    { role: 'assistant', content: 'keep this answer' },
  ], { promptTokens: 1, completionTokens: 1 });
  const conversationFile = join(compactHome, 'conversations.json');
  const beforeRejectedAppend = readFileSync(conversationFile, 'utf8');
  const beforeRejectedTurns = JSON.stringify(store.turns(atomicConversation.id));
  let oversizedUserError = '';
  try {
    store.appendResult(atomicConversation.id, [
      { role: 'user', content: '한'.repeat(180_000) },
    ], { promptTokens: 1, completionTokens: 1 });
  } catch (error) {
    oversizedUserError = error instanceof Error ? error.message : String(error);
  }
  check('oversized user turn is rejected with file/workspace guidance', /파일 첨부|작업 폴더/.test(oversizedUserError), oversizedUserError);
  check('rejected user turn changes neither disk nor live history', readFileSync(conversationFile, 'utf8') === beforeRejectedAppend && JSON.stringify(store.turns(atomicConversation.id)) === beforeRejectedTurns);

  let oversizedToolError = '';
  try {
    store.appendResult(atomicConversation.id, [
      { role: 'user', content: 'run a tool' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'large-call', name: 'plugin.large', args: '인'.repeat(100_000) }] },
      { role: 'tool', content: '', toolResults: [{ id: 'large-call', name: 'plugin.large', content: '결'.repeat(180_000) }] },
    ], { promptTokens: 1, completionTokens: 1 });
  } catch (error) {
    oversizedToolError = error instanceof Error ? error.message : String(error);
  }
  check('oversized assistant/tool payload is rejected before append', /파일 첨부|작업 폴더/.test(oversizedToolError), oversizedToolError);
  check('rejected tool append leaves the last-known-good file byte-identical', readFileSync(conversationFile, 'utf8') === beforeRejectedAppend && JSON.stringify(store.turns(atomicConversation.id)) === beforeRejectedTurns);
  const reopenedAfterRejection = new ConversationStore(compactHome);
  check('last-known-good conversation reopens after rejected oversized appends', reopenedAfterRejection.turns(atomicConversation.id)?.[1]?.content === 'keep this answer');

  const originalConversationSave = store.save;
  store.save = () => { throw new Error('simulated disk failure'); };
  let appendPersistenceError = '';
  try {
    store.appendResult(atomicConversation.id, [
      { role: 'user', content: 'new request that must roll back' },
      { role: 'assistant', content: 'new answer that must roll back' },
    ], { promptTokens: 9, completionTokens: 9 });
  } catch (error) {
    appendPersistenceError = error instanceof Error ? error.message : String(error);
  } finally {
    store.save = originalConversationSave;
  }
  check('append persistence failure is surfaced', /simulated disk failure/.test(appendPersistenceError), appendPersistenceError);
  check('append persistence failure rolls back live history and usage', JSON.stringify(store.turns(atomicConversation.id)) === beforeRejectedTurns && store.get(atomicConversation.id)?.usage.promptTokens === 1);
}

console.log('4. OpenAI adapters stream and report complete usage');
{
  const originalFetch = globalThis.fetch;
  const bodies = [];
  globalThis.fetch = async (_url, init = {}) => {
    const body = JSON.parse(String(init.body ?? '{}'));
    bodies.push(body);
    if (body.stream_options) {
      return new Response([
        'data: {"choices":[{"delta":{"content":"chat"}}]}',
        'data: {"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":3,"prompt_tokens_details":{"cached_tokens":5}}}',
        'data: [DONE]',
        'data: {"choices":[{"delta":{"content":"ignored"}}]}',
        '',
      ].join('\n'), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    return new Response([
      'data: {"type":"response.output_text.delta","delta":"hello "}',
      'data: {"type":"response.output_text.delta","delta":"world"}',
      'data: {"type":"response.output_item.added","output_index":1,"item":{"type":"function_call","call_id":"call_1","name":"read_file","arguments":""}}',
      'data: {"type":"response.function_call_arguments.delta","output_index":1,"delta":"{\\"path\\":\\"x\\"}"}',
      'data: {"type":"response.function_call_arguments.done","output_index":1,"call_id":"call_1","name":"read_file","arguments":"{\\"path\\":\\"x\\"}"}',
      'data: {"type":"response.completed","response":{"usage":{"input_tokens":11,"output_tokens":4,"input_tokens_details":{"cached_tokens":8},"output_tokens_details":{"reasoning_tokens":2}}}}',
      'data: [DONE]',
      '',
    ].join('\n'), { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  try {
    const responseDeltas = [];
    const responses = new OpenAICompatibleProvider('openai', 'OpenAI', 'openai', 'https://api.openai.com/v1', 'gpt-test', 'key');
    const responseResult = await responses.chat({
      turns: [{ role: 'user', content: 'test' }],
      promptCacheKey: 'conversation:stable',
      onEvent: (event) => { if (event.type === 'text') responseDeltas.push(event.text); },
    });
    check('Responses SSE emits deltas and tool call', responseResult.text === 'hello world' && responseResult.toolCalls[0]?.name === 'read_file');
    check('Responses usage includes cache and reasoning', responseResult.usage.promptTokens === 11 && responseResult.usage.cachedPromptTokens === 8 && responseResult.usage.reasoningTokens === 2);
    check('Responses body enables stream/cache/parallel tools', bodies[0]?.stream === true && bodies[0]?.prompt_cache_key === 'conversation:stable' && bodies[0]?.parallel_tool_calls === true);
    check('Responses deltas are not replayed as one chunk', responseDeltas.length === 2);

    const compatible = new OpenAICompatibleProvider('compat', 'Compat', 'openai-compatible', 'https://example.invalid/v1', 'model', 'key');
    const compatibleResult = await compatible.chat({ turns: [{ role: 'user', content: 'test' }], promptCacheKey: 'compat:key' });
    check('Chat Completions requests usage in stream', bodies[1]?.stream_options?.include_usage === true);
    check('Chat Completions parses cached usage', compatibleResult.usage.promptTokens === 7 && compatibleResult.usage.cachedPromptTokens === 5);
    check('Chat Completions stops at the official DONE sentinel', compatibleResult.text === 'chat', compatibleResult.text);

    let truncatedChatToolEvents = 0;
    let truncatedChat = '';
    globalThis.fetch = async () => new Response([
      'data: {"choices":[{"delta":{"content":"partial chat","tool_calls":[{"index":0,"id":"partial_call","function":{"name":"write_file","arguments":"{}"}}]}}]}',
      '',
    ].join('\n'), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    try {
      await compatible.chat({
        turns: [{ role: 'user', content: 'truncated compatible stream' }],
        onEvent: (event) => { if (event.type === 'tool') truncatedChatToolEvents++; },
      });
    } catch (err) {
      truncatedChat = err instanceof Error ? err.message : String(err);
    }
    check('Chat Completions EOF without DONE rejects partial result', /before \[DONE\]/.test(truncatedChat), truncatedChat);
    check('truncated Chat Completions stream does not commit tool calls', truncatedChatToolEvents === 0, String(truncatedChatToolEvents));

    const responseStream = async (lines, onEvent) => {
      globalThis.fetch = async () => new Response([...lines, ''].join('\n'), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      });
      return responses.chat({ turns: [{ role: 'user', content: 'terminal test' }], onEvent });
    };
    const rejectionMessage = async (lines) => {
      try {
        await responseStream(lines);
        return '';
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
    };

    const failed = await rejectionMessage([
      'data: {"type":"response.output_text.delta","delta":"partial"}',
      'data: {"type":"response.failed","response":{"status":"failed","error":{"code":"server_error","message":"generation failed"}}}',
    ]);
    check('Responses HTTP 200 failed event rejects partial result', /generation failed/.test(failed), failed);

    const incomplete = await rejectionMessage([
      'data: {"type":"response.output_text.delta","delta":"partial"}',
      'data: {"type":"response.incomplete","response":{"status":"incomplete","incomplete_details":{"reason":"max_output_tokens"}}}',
    ]);
    check('Responses incomplete event reports its reason', /max_output_tokens/.test(incomplete), incomplete);

    let truncatedToolEvents = 0;
    let truncated = '';
    try {
      await responseStream([
        'data: {"type":"response.output_text.delta","delta":"unterminated"}',
        'data: {"type":"response.output_item.done","output_index":0,"item":{"type":"function_call","call_id":"unsafe_partial","name":"write_file","arguments":"{}"}}',
      ], (event) => { if (event.type === 'tool') truncatedToolEvents++; });
    } catch (err) {
      truncated = err instanceof Error ? err.message : String(err);
    }
    check('Responses EOF without completed terminal rejects partial result', /before response\.completed/.test(truncated), truncated);
    check('truncated Responses stream does not commit tool calls', truncatedToolEvents === 0, String(truncatedToolEvents));

    const refusalDeltas = [];
    const refusal = await responseStream([
      'data: {"type":"response.refusal.delta","delta":"I can"}',
      'data: {"type":"response.refusal.done","refusal":"I cannot comply"}',
      'data: {"type":"response.completed","response":{"status":"completed","output":[],"usage":{"input_tokens":2,"output_tokens":3}}}',
    ], (event) => { if (event.type === 'text') refusalDeltas.push(event.text); });
    check('Responses refusal is returned as meaningful assistant text', refusal.text === 'I cannot comply', refusal.text);
    check('Responses refusal delta and done form one streamed explanation', refusalDeltas.join('') === refusal.text, refusalDeltas.join('|'));

    const emptyRefusal = await rejectionMessage([
      'data: {"type":"response.refusal.done","refusal":""}',
      'data: {"type":"response.completed","response":{"status":"completed","output":[]}}',
    ]);
    check('empty refusal cannot become a successful empty response', /without an explanation/.test(emptyRefusal), emptyRefusal);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

console.log('5. shell abort reaps the process tree');
{
  const controller = new AbortController();
  const started = Date.now();
  const pending = runShell('ping 127.0.0.1 -n 30 > nul', { shell: 'cmd', timeoutMs: 60_000, signal: controller.signal });
  setTimeout(() => controller.abort(), 100);
  const result = await pending;
  check('abort returns promptly and unsuccessfully', !result.ok && Date.now() - started < 5_000, JSON.stringify(result));
}

console.log('6. active runs are isolated by device ownership');
{
  const detachedSession = new ChatSession();
  detachedSession.begin();
  let streamStops = 0;
  cleanupDisconnectedClientState({
    chat: detachedSession,
    stream: { stop() { streamStops++; } },
  });
  check('socket disconnect stops transient streaming but preserves the active run', streamStops === 1 && detachedSession.busy === true && detachedSession.signal()?.aborted === false);
  detachedSession.cancel();
  detachedSession.end();

  const server = new AgentServer();
  const session = new ChatSession();
  session.begin();
  server.activeRuns.set('owned-run', {
    session,
    startedAt: Date.now(),
    status: 'running',
    ownerClientId: 'owner-client',
    ownerLinkId: 'owner-link',
    permissionMode: 'read-only',
  });
  const handlers = server.handlers();
  const client = (id, auth) => ({ id, state: { auth, chat: new ChatSession() } });
  const outsider = client('other-client', { isAdmin: false, linkId: 'other-link', permissionCap: 'full' });
  const reconnectedOwner = client('new-owner-client', { isAdmin: false, linkId: 'owner-link', permissionCap: 'read-only' });
  const admin = client('admin-client', { isAdmin: true, permissionCap: 'full' });

  const outsiderRuns = handlers.get('chat.runs')({}, outsider);
  check('other linked devices cannot discover active runs', Array.isArray(outsiderRuns) && outsiderRuns.length === 0);
  let outsiderSteerBlocked = false;
  let outsiderCancelBlocked = false;
  try { handlers.get('chat.steer')({ conversationId: 'owned-run', text: 'escalate' }, outsider); } catch { outsiderSteerBlocked = true; }
  try { handlers.get('chat.cancel')({ conversationId: 'owned-run' }, outsider); } catch { outsiderCancelBlocked = true; }
  check('other linked devices cannot steer an active run', outsiderSteerBlocked && session.steeringQueued === 0);
  check('other linked devices cannot cancel an active run', outsiderCancelBlocked && session.signal()?.aborted === false);

  const ownerRuns = handlers.get('chat.runs')({}, reconnectedOwner);
  const ownerSteer = handlers.get('chat.steer')({ conversationId: 'owned-run', text: 'continue safely' }, reconnectedOwner);
  check('same device credential can recover its active run', ownerRuns.length === 1 && ownerSteer.queued === 1);
  const adminCancel = handlers.get('chat.cancel')({ conversationId: 'owned-run' }, admin);
  check('administrator can stop any active run', adminCancel.ok === true && session.signal()?.aborted === true);
  session.end();
}

console.log('7. linked devices cannot create privileged scheduled work');
{
  const server = new AgentServer();
  const handlers = server.handlers();
  const readOnly = {
    id: 'read-only-client',
    state: {
      auth: { isAdmin: false, linkId: 'read-only-link', permissionCap: 'read-only' },
      chat: new ChatSession(),
    },
  };
  let addBlocked = false;
  let removeBlocked = false;
  let enableBlocked = false;
  try { handlers.get('scheduler.add')({ name: 'escape', type: 'shell', command: 'whoami', whenKind: 'once', at: new Date().toISOString() }, readOnly); } catch { addBlocked = true; }
  try { handlers.get('scheduler.remove')({ id: 'anything' }, readOnly); } catch { removeBlocked = true; }
  try { handlers.get('scheduler.setEnabled')({ id: 'anything', enabled: true }, readOnly); } catch { enableBlocked = true; }
  check('scheduler mutations require local administrator', addBlocked && removeBlocked && enableBlocked);
}

console.log('7b. device permission changes invalidate live sessions');
{
  const server = new AgentServer();
  const created = server.config.createDeviceLink('live device', 'full');
  const running = new ChatSession();
  running.begin();
  const pendingApproval = running.askConfirm(() => undefined, {
    conversationId: 'live-device-run',
    conversationTitle: 'live device run',
    tool: 'write_file',
    input: {},
    summary: 'write a protected file',
  });
  server.activeRuns.set('live-device-run', {
    session: running,
    startedAt: Date.now(),
    status: 'running',
    ownerClientId: 'old-socket',
    ownerLinkId: created.link.id,
    permissionMode: 'full',
  });
  const disconnectedLinks = [];
  let disconnectedAll = 0;
  server.hub = {
    disconnectLink(id) { disconnectedLinks.push(id); return 1; },
    disconnectAuthenticated() { disconnectedAll++; return 1; },
  };
  const admin = {
    id: 'local-admin',
    state: { auth: { isAdmin: true, permissionCap: 'full' }, chat: new ChatSession() },
  };
  const handlers = server.handlers();
  const downgraded = handlers.get('pairing.link.update')({ id: created.link.id, permissionCap: 'read-only' }, admin);
  const downgradeApproval = await pendingApproval;
  check('permission downgrade cancels work, rejects approval and disconnects the affected link', downgraded.permissionCap === 'read-only' && running.signal()?.aborted === true && downgradeApproval === false && running.pendingConfirmForOwner() === undefined && disconnectedLinks.includes(created.link.id));
  running.end();

  const capabilityLink = server.config.createDeviceLink('capability device', 'ask', ['work-sync']);
  const withPrivateCalendar = handlers.get('pairing.link.capability.set')({
    id: capabilityLink.link.id, capability: 'private-calendar', enabled: true,
  }, admin);
  const atomicAddPreservedCurrent = withPrivateCalendar.capabilities.includes('work-sync')
    && withPrivateCalendar.capabilities.includes('private-calendar');
  server.config.patchDeviceLink(capabilityLink.link.id, { capabilities: ['private-calendar'] });
  const withoutPrivateCalendar = handlers.get('pairing.link.capability.set')({
    id: capabilityLink.link.id, capability: 'private-calendar', enabled: false,
  }, admin);
  check('single-capability updates preserve current server state instead of replaying a stale full array',
    atomicAddPreservedCurrent && withoutPrivateCalendar.capabilities.length === 0);
  let unsupportedCapabilityBlocked = false;
  let pairedCapabilityAdminBlocked = false;
  try {
    handlers.get('pairing.link.capability.set')({ id: capabilityLink.link.id, capability: 'administrator', enabled: true }, admin);
  } catch { unsupportedCapabilityBlocked = true; }
  try {
    handlers.get('pairing.link.capability.set')({ id: capabilityLink.link.id, capability: 'private-calendar', enabled: true }, {
      id: 'paired-client',
      state: { auth: { isAdmin: false, linkId: capabilityLink.link.id, permissionCap: 'ask' }, chat: new ChatSession() },
    });
  } catch { pairedCapabilityAdminBlocked = true; }
  check('single-capability RPC validates its enum and remains administrator-only', unsupportedCapabilityBlocked && pairedCapabilityAdminBlocked);

  const revoked = server.config.createDeviceLink('revoked device', 'full');
  const revokedRun = new ChatSession();
  revokedRun.begin();
  const revokedApprovalPromise = revokedRun.askConfirm(() => undefined, {
    conversationId: 'revoked-run',
    conversationTitle: 'revoked run',
    tool: 'run_shell',
    input: {},
    summary: 'run a protected command',
  });
  server.activeRuns.set('revoked-run', {
    session: revokedRun,
    startedAt: Date.now(),
    status: 'awaiting approval',
    ownerClientId: 'revoked-socket',
    ownerLinkId: revoked.link.id,
    permissionMode: 'full',
  });
  const revokeResult = handlers.get('pairing.link.revoke')({ id: revoked.link.id }, admin);
  const revokedApproval = await revokedApprovalPromise;
  check('explicit link revoke cancels its run and discards pending approval', revokeResult.ok === true && revokedRun.signal()?.aborted === true && revokedApproval === false && revokedRun.pendingConfirmForOwner() === undefined && disconnectedLinks.includes(revoked.link.id));
  revokedRun.end();

  const globalRun = new ChatSession();
  globalRun.begin();
  const globalApprovalPromise = globalRun.askConfirm(() => undefined, {
    conversationId: 'global-run',
    conversationTitle: 'global run',
    tool: 'write_file',
    input: {},
    summary: 'write after credential rotation',
  });
  server.activeRuns.set('global-run', {
    session: globalRun,
    startedAt: Date.now(),
    status: 'awaiting approval',
    ownerClientId: 'global-socket',
    ownerLinkId: created.link.id,
    permissionMode: 'full',
  });
  const oldSecret = server.secret;
  const rotated = handlers.get('pairing.regenerate')({}, admin);
  await new Promise((resolveTimer) => setTimeout(resolveTimer, 10));
  const globalApproval = await globalApprovalPromise;
  check('global credential rotation changes the secret, cancels all work/approvals and invalidates all live sessions', rotated.secret !== oldSecret && server.secret === rotated.secret && globalRun.signal()?.aborted === true && globalApproval === false && globalRun.pendingConfirmForOwner() === undefined && disconnectedAll === 1);
  globalRun.end();
}

console.log('7c. distributed PIN guessing hits a global bound');
{
  const server = new AgentServer();
  const currentPin = server.config.pin;
  for (let index = 0; index < 50; index++) {
    server.exchangePin('000000', `attacker-${index}`, 'ask', `distributed-${index}`);
  }
  const globallyBlocked = server.exchangePin(currentPin, 'legitimate', 'ask', 'fresh-address');
  check('rotating client identities cannot bypass the global pairing failure ceiling', globallyBlocked.ok === false && /too many attempts/.test(globallyBlocked.error ?? ''));

  const handlers = server.handlers();
  const admin = { id: 'admin', state: { auth: { isAdmin: true, permissionCap: 'full' }, chat: new ChatSession() } };
  const rotated = handlers.get('pairing.regeneratePin')({}, admin);
  const recovered = server.exchangePin(rotated.pin, 'legitimate', 'ask', 'fresh-address');
  check('local PIN rotation clears a distributed lockout for a new enrollment epoch', recovered.ok === true);
}

console.log('7d. unattended remote handoff is admin-only, strong, memory-only and single-use');
{
  const server = new AgentServer();
  const handlers = server.handlers();
  const admin = { id: 'admin', state: { auth: { isAdmin: true, permissionCap: 'full' }, chat: new ChatSession() } };
  const paired = { id: 'paired', state: { auth: { isAdmin: false, linkId: 'paired-link', permissionCap: 'ask' }, chat: new ChatSession() } };
  let pairedBlocked = false;
  try { handlers.get('pairing.createRemoteHandoff')({ ttlMinutes: 24 * 60 }, paired); } catch { pairedBlocked = true; }
  check('only the local administrator can mint an unattended handoff code', pairedBlocked);
  const pairedInfo = handlers.get('pairing.info')({}, paired);
  check('paired clients receive no PIN, QR, remote handoff, local secret or administrator-secret fingerprint', ['pin', 'qrPayload', 'remoteHandoff', 'localSecret', 'maskedSecret'].every((field) => !Object.hasOwn(pairedInfo, field)));

  const shortPinBefore = server.config.pin;
  const before = Date.now();
  const handoff = handlers.get('pairing.createRemoteHandoff')({ ttlMinutes: 24 * 60 }, admin);
  const ttl = handoff.expiresAt - before;
  check('remote handoff uses a separate 12-digit code capped at 24 hours', /^\d{12}$/.test(handoff.pin) && handoff.pin !== shortPinBefore && ttl > 23 * 60 * 60_000 && ttl <= 24 * 60 * 60_000 + 1_000);
  const adminPairingInfo = handlers.get('pairing.info')({}, admin);
  check('only the local administrator can recover the active handoff for QR state synchronization', adminPairingInfo.remoteHandoff?.pin === handoff.pin && adminPairingInfo.remoteHandoff?.expiresAt === handoff.expiresAt);
  check('creating a remote handoff does not weaken or extend the ordinary QR PIN', server.config.pin === shortPinBefore);
  check('remote handoff plaintext is never persisted', !readFileSync(join(home, 'config.json'), 'utf8').includes(handoff.pin));

  const accepted = server.exchangePin(handoff.pin, 'remote phone', 'full', 'remote-handoff-client');
  const auth = accepted.secret ? server.authenticate(accepted.secret) : null;
  const replay = server.exchangePin(handoff.pin, 'replay phone', 'ask', 'remote-handoff-replay');
  check('remote handoff grants at most ask and is consumed exactly once', accepted.ok === true && auth?.isAdmin === false && auth?.permissionCap === 'ask' && replay.ok === false);
  check('consuming the handoff rotates the ordinary PIN too', server.config.pin !== shortPinBefore);

  const handoffBeforeShortPair = handlers.get('pairing.createRemoteHandoff')({ ttlMinutes: 24 * 60 }, admin);
  const acceptedShort = server.exchangePin(server.config.pin, 'nearby phone', 'ask', 'nearby-client');
  const handoffAfterShortPair = server.exchangePin(handoffBeforeShortPair.pin, 'late remote phone', 'ask', 'late-remote-client');
  check('consuming the ordinary QR PIN also invalidates a pending remote handoff', acceptedShort.ok === true && handoffAfterShortPair.ok === false);

  const handoffBeforeRotation = handlers.get('pairing.createRemoteHandoff')({ ttlMinutes: 24 * 60 }, admin);
  handlers.get('pairing.regeneratePin')({}, admin);
  check('explicit PIN rotation revokes a pending remote handoff', server.exchangePin(handoffBeforeRotation.pin, 'stale handoff', 'ask', 'stale-rotation-client').ok === false);

  const handoffBeforeRevoke = handlers.get('pairing.createRemoteHandoff')({ ttlMinutes: 24 * 60 }, admin);
  const revoked = handlers.get('pairing.revokeRemoteHandoff')({}, admin);
  check('administrator can explicitly revoke a remote handoff', revoked.ok === true && server.exchangePin(handoffBeforeRevoke.pin, 'revoked handoff', 'ask', 'revoked-handoff-client').ok === false);

  await server.start({ port: 0 });
  const handoffBeforeLinkStop = handlers.get('pairing.createRemoteHandoff')({ ttlMinutes: 24 * 60 }, admin);
  server.bus.emit('remote-link.changed', { running: false });
  check('stopping the public remote link revokes its remote handoff', server.exchangePin(handoffBeforeLinkStop.pin, 'link-stop replay', 'ask', 'link-stop-client').ok === false);
  const handoffBeforeAgentStop = handlers.get('pairing.createRemoteHandoff')({ ttlMinutes: 24 * 60 }, admin);
  await server.stop();
  check('stopping and reusing the same agent object cannot retain a handoff', server.exchangePin(handoffBeforeAgentStop.pin, 'agent-stop replay', 'ask', 'agent-stop-client').ok === false);
}

console.log('8. stored conversation permissions cannot exceed the linked device cap');
{
  const server = new AgentServer();
  const handlers = server.handlers();
  const client = (id, permissionCap) => ({
    id,
    state: {
      auth: { isAdmin: false, linkId: `${id}-link`, permissionCap },
      chat: new ChatSession(),
    },
  });
  const readOnly = client('reader', 'read-only');
  const ask = client('asker', 'ask');
  let readOnlyCreateBlocked = false;
  let readOnlyMemoryBlocked = false;
  try { handlers.get('conversations.create')({ title: 'escape', permissionMode: 'full' }, readOnly); } catch { readOnlyCreateBlocked = true; }
  try { handlers.get('memory.add')({ text: 'poison' }, readOnly); } catch { readOnlyMemoryBlocked = true; }
  check('read-only devices cannot mutate retained content', readOnlyCreateBlocked && readOnlyMemoryBlocked);

  const created = handlers.get('conversations.create')({ title: 'bounded', permissionMode: 'full' }, ask);
  const updated = handlers.get('conversations.update')({ id: created.id, permissionMode: 'full' }, ask);
  check('ask devices cannot persist a full-permission conversation', created.permissionMode === 'ask' && updated.permissionMode === 'ask');
}

console.log('9. cross-PC sync validates both stores and preserves local access decisions');
{
  const server = new AgentServer();
  const local = server.conversations.create({ title: 'local original', permissionMode: 'full' });
  const changed = server.conversations.exportSnapshot();
  changed[0].title = 'must not partially apply';
  changed[0].updatedAt += 1;
  let invalidRejected = false;
  try {
    server.mergeSyncSnapshot({
      version: 1,
      conversations: changed,
      routingPresets: [{ id: 'broken', name: 'broken', createdAt: 1, updatedAt: 2, mode: 'balanced', executionMode: 'single', roles: {}, maxPremiumCalls: 1, escalationEnabled: true, graph: { nodes: [], edges: [{ id: 'bad', from: 'missing', to: 'missing-too' }] } }],
    });
  } catch { invalidRejected = true; }
  check('invalid second store cannot partially update conversations', invalidRejected && server.conversations.get(local.id)?.title === 'local original');

  const imported = structuredClone(changed[0]);
  imported.id = 'sync-new-conversation';
  imported.title = 'safe import';
  imported.permissionMode = 'full';
  imported.workspaceId = 'destination-sensitive-workspace';
  imported.createdAt = Date.now();
  imported.updatedAt = Date.now();
  server.mergeSyncSnapshot({ version: 1, conversations: [imported], routingPresets: [] });
  const safe = server.conversations.get(imported.id);
  check('new synced conversations are ask-capped and lose remote workspace binding', safe?.permissionMode === 'ask' && safe.workspaceId === undefined);

  const linearSource = new ConversationStore(join(home, 'sync-linear-source'));
  const linearTarget = new ConversationStore(join(home, 'sync-linear-target'));
  const linear = linearSource.create({ title: 'shared baseline' });
  linearTarget.mergeSnapshot(linearSource.exportSnapshot());
  linearSource.update(linear.id, { title: 'ordinary descendant edit' });
  const linearMerge = linearTarget.mergeSnapshot(linearSource.exportSnapshot());
  check('ordinary descendant sync updates without a false conflict copy', linearMerge.updated === 1 && linearMerge.conflicts === 0 && linearTarget.list().length === 1 && linearTarget.get(linear.id)?.title === 'ordinary descendant edit');

  const branchA = new ConversationStore(join(home, 'sync-conflict-a'));
  const branchB = new ConversationStore(join(home, 'sync-conflict-b'));
  const branchSeed = branchA.create({ title: 'conflict baseline' });
  branchB.mergeSnapshot(branchA.exportSnapshot());
  branchA.update(branchSeed.id, { title: 'PC A independent edit' });
  branchB.update(branchSeed.id, { title: 'PC B independent edit' });
  const conflictMerge = branchB.mergeSnapshot(branchA.exportSnapshot());
  const conflictTitles = branchB.list().map((item) => item.title);
  check('divergent conversation edits preserve both branches as a visible conflict copy', conflictMerge.conflicts === 1 && conflictMerge.conflictIds.length === 1 && conflictTitles.some((title) => title.startsWith('PC A independent edit')) && conflictTitles.some((title) => title.startsWith('PC B independent edit')));
  const countAfterConflict = branchB.list().length;
  const repeatedConflict = branchB.mergeSnapshot(branchA.exportSnapshot());
  check('repeating the same divergent snapshot does not proliferate conflict copies', repeatedConflict.conflicts === 0 && branchB.list().length === countAfterConflict);
  branchA.mergeSnapshot(branchB.exportSnapshot());
  const convergedTitles = branchA.list().map((item) => item.title);
  check('conflict copies converge to the other PC without losing either branch', convergedTitles.some((title) => title.startsWith('PC A independent edit')) && convergedTitles.some((title) => title.startsWith('PC B independent edit')));

  const conversationCountStore = new ConversationStore(join(home, 'sync-conversation-count'));
  const conversationSeed = conversationCountStore.create({ title: 'count seed' });
  const conversationTemplate = conversationCountStore.exportSnapshot()[0];
  const remoteConversations = Array.from({ length: 5_000 }, (_, index) => ({
    ...structuredClone(conversationTemplate),
    id: `remote-count-${index}`,
    title: `remote ${index}`,
    createdAt: 1,
    updatedAt: 2,
  }));
  const conversationCountBefore = JSON.stringify(conversationCountStore.exportSnapshot());
  let conversationCountRejected = false;
  try { conversationCountStore.mergeSnapshot(remoteConversations); } catch { conversationCountRejected = true; }
  check('conversation merge enforces the combined 5,000-item ceiling before mutation', conversationCountRejected && JSON.stringify(conversationCountStore.exportSnapshot()) === conversationCountBefore);

  const oversizedTrustedConversations = [structuredClone(conversationTemplate), ...remoteConversations];
  conversationCountStore.restoreSnapshot(oversizedTrustedConversations);
  check('trusted conversation rollback bypasses remote import ceilings', conversationCountStore.exportSnapshot().length === 5_001 && conversationCountStore.get(conversationSeed.id)?.title === 'count seed');
  const trustedConversationBefore = JSON.stringify(conversationCountStore.exportSnapshot());
  const conversationSave = conversationCountStore.save;
  conversationCountStore.save = () => { throw new Error('simulated conversation persistence failure'); };
  let conversationRestoreFailed = false;
  try { conversationCountStore.restoreSnapshot([conversationTemplate]); } catch { conversationRestoreFailed = true; }
  conversationCountStore.save = conversationSave;
  check('failed trusted conversation restore also restores live memory', conversationRestoreFailed && JSON.stringify(conversationCountStore.exportSnapshot()) === trustedConversationBefore);

  const conversationByteStore = new ConversationStore(join(home, 'sync-conversation-bytes'));
  const byteTemplate = conversationByteStore.create({ title: 'byte seed' });
  const byteSnapshot = conversationByteStore.exportSnapshot()[0];
  conversationByteStore.restoreSnapshot([]);
  const largeTurn = 'x'.repeat(500 * 1024);
  const makeLargeConversation = (prefix, index) => ({
    ...structuredClone(byteSnapshot),
    id: `${prefix}-${index}`,
    title: `${prefix} ${index}`,
    createdAt: 1,
    updatedAt: 2,
    turns: [{ role: 'user', content: largeTurn }],
  });
  const localByteConversations = Array.from({ length: 34 }, (_, index) => makeLargeConversation('local-byte', index));
  const remoteByteConversations = Array.from({ length: 34 }, (_, index) => makeLargeConversation('remote-byte', index));
  conversationByteStore.mergeSnapshot(localByteConversations);
  let conversationBytesRejected = false;
  try { conversationByteStore.mergeSnapshot(remoteByteConversations); } catch { conversationBytesRejected = true; }
  check('conversation merge enforces the combined 32MB ceiling before mutation', conversationBytesRejected && conversationByteStore.exportSnapshot().length === localByteConversations.length);

  const presetCountStore = new ConfigStore(join(home, 'sync-preset-count'));
  presetCountStore.saveRoutingPreset('count seed');
  const presetTemplate = presetCountStore.exportUserRoutingPresets()[0];
  const remotePresets = Array.from({ length: 500 }, (_, index) => ({
    ...structuredClone(presetTemplate),
    id: `remote-preset-${index}`,
    name: `remote preset ${index}`,
    createdAt: 1,
    updatedAt: 2,
  }));
  const presetCountBefore = JSON.stringify(presetCountStore.exportUserRoutingPresets());
  let presetCountRejected = false;
  try { presetCountStore.mergeRoutingPresets(remotePresets); } catch { presetCountRejected = true; }
  check('preset merge enforces the combined 500-item ceiling before mutation', presetCountRejected && JSON.stringify(presetCountStore.exportUserRoutingPresets()) === presetCountBefore);

  presetCountStore.restoreUserRoutingPresets([structuredClone(presetTemplate), ...remotePresets]);
  check('trusted preset rollback bypasses remote import ceilings', presetCountStore.exportUserRoutingPresets().length === 501);
  const trustedPresetBefore = JSON.stringify(presetCountStore.exportUserRoutingPresets());
  const configSave = presetCountStore.save;
  presetCountStore.save = () => { throw new Error('simulated config persistence failure'); };
  let presetRestoreFailed = false;
  try { presetCountStore.restoreUserRoutingPresets([presetTemplate]); } catch { presetRestoreFailed = true; }
  presetCountStore.save = configSave;
  check('failed trusted preset restore also restores live memory', presetRestoreFailed && JSON.stringify(presetCountStore.exportUserRoutingPresets()) === trustedPresetBefore);

  const presetByteStore = new ConfigStore(join(home, 'sync-preset-bytes'));
  const providerValue = 'p'.repeat(240);
  const modelValue = 'm'.repeat(500);
  const integrationValue = 'i'.repeat(240);
  const presetRoles = Object.fromEntries(['router', 'fast', 'general', 'reasoning', 'coding', 'vision', 'critic', 'summarizer'].map((role) => [role, Array.from({ length: 16 }, () => providerValue)]));
  const presetNodes = Array.from({ length: 64 }, (_, index) => ({ id: `node-${index}`, kind: 'model', label: 'n'.repeat(120), role: 'general', providerId: providerValue, providerModel: modelValue, integrationId: integrationValue, x: index, y: index }));
  const presetEdges = [];
  for (let from = 0; from < presetNodes.length && presetEdges.length < 256; from++) {
    for (let to = from + 1; to < presetNodes.length && presetEdges.length < 256; to++) {
      presetEdges.push({ id: `edge-${presetEdges.length}`, from: `node-${from}`, to: `node-${to}`, label: 'e'.repeat(240) });
    }
  }
  const makeLargePreset = (prefix, index) => ({
    id: `${prefix}-${index}`,
    name: `${prefix} ${index}`,
    description: 'd'.repeat(240),
    builtin: false,
    createdAt: 1,
    updatedAt: 2,
    mode: 'balanced',
    executionMode: 'pipeline',
    meetingRounds: 2,
    crossGroupRounds: 1,
    maxIterations: 6,
    roles: presetRoles,
    maxPremiumCalls: 1,
    escalationEnabled: true,
    graph: { nodes: presetNodes, edges: presetEdges },
  });
  const localBytePresets = Array.from({ length: 25 }, (_, index) => makeLargePreset('local-large-preset', index));
  const remoteBytePresets = Array.from({ length: 25 }, (_, index) => makeLargePreset('remote-large-preset', index));
  presetByteStore.mergeRoutingPresets(localBytePresets);
  let presetBytesRejected = false;
  try { presetByteStore.mergeRoutingPresets(remoteBytePresets); } catch { presetBytesRejected = true; }
  check('preset merge enforces the combined 8MB ceiling before mutation', presetBytesRejected && presetByteStore.exportUserRoutingPresets().length === localBytePresets.length);
}

console.log('10. PIN pairing gets narrow work sync without control-plane administration');
{
  const server = new AgentServer();
  server.config.updateSettings({ safety: { ...server.config.settings.safety, mode: 'full' } });
  const paired = server.exchangePin(server.config.pin, 'untrusted nearby device', 'full', 'pairing-test');
  const auth = paired.secret ? server.authenticate(paired.secret) : null;
  check('short PIN grants at most ask and never administrator', paired.ok === true && auth?.permissionCap === 'ask' && auth.isAdmin === false);
  if (paired.linkId && paired.secret) {
    const defaultLink = server.config.deviceLinks.find((link) => link.id === paired.linkId);
    check('default ask pairing receives only the dedicated work-sync capability', defaultLink?.capabilities.includes('work-sync') === true && server.isSyncSecret(paired.secret) === true);
    server.config.patchDeviceLink(paired.linkId, { permissionCap: 'full', capabilities: [] });
    check('full tool permission alone cannot grant work sync', server.isSyncSecret(paired.secret) === false && server.isAdminSecret(paired.secret) === false);
    server.config.patchDeviceLink(paired.linkId, { permissionCap: 'ask', capabilities: ['work-sync'] });
    check('work-sync capability operates at ask without becoming administrator', server.isSyncSecret(paired.secret) === true && server.authenticate(paired.secret)?.permissionCap === 'ask' && server.isAdminSecret(paired.secret) === false);
    server.config.updateSettings({ safety: { ...server.config.settings.safety, mode: 'read-only' } });
    check('global read-only ceiling still disables dedicated work sync', server.isSyncSecret(paired.secret) === false);
  }
}

console.log('11. scheduled work rechecks live safety and aborts on stop');
{
  const server = new AgentServer();
  server.config.updateSettings({ safety: { ...server.config.settings.safety, mode: 'ask' } });
  const blocked = server.scheduler.add({
    name: 'live policy check', type: 'shell', command: 'echo must-not-run', shellKind: 'cmd',
    when: { kind: 'daily', at: '23:59' }, allowDestructive: false, permissionMode: 'full', createdByAdmin: true,
  });
  await server.scheduler.run(blocked.id);
  check('current non-full global policy blocks an old full shell schedule', /차단됨/.test(server.scheduler.list().find((job) => job.id === blocked.id)?.lastResult ?? ''));

  server.config.updateSettings({ safety: { ...server.config.settings.safety, mode: 'full' } });
  const long = server.scheduler.add({
    name: 'abort on stop', type: 'shell', command: 'ping 127.0.0.1 -n 30 > nul', shellKind: 'cmd',
    when: { kind: 'daily', at: '23:59' }, allowDestructive: false, permissionMode: 'full', createdByAdmin: true,
  });
  const started = Date.now();
  const running = server.scheduler.run(long.id);
  setTimeout(() => server.scheduler.stop(), 100);
  await running;
  const stoppedResult = server.scheduler.list().find((job) => job.id === long.id)?.lastResult ?? '';
  check('scheduler stop aborts and reaps an active shell promptly', Date.now() - started < 5_000 && /"ok":false/.test(stoppedResult), stoppedResult);
}

console.log('12. server restart does not multiply event listeners');
{
  const server = new AgentServer();
  await server.start({ port: 0, host: '127.0.0.1' });
  const first = server.bus.listenerCount('log');
  await server.stop();
  const stopped = server.bus.listenerCount('log');
  await server.start({ port: 0, host: '127.0.0.1' });
  const second = server.bus.listenerCount('log');
  check('listeners are removed on stop', first === 1 && stopped === 0, `${first} -> ${stopped}`);
  check('restart restores exactly one listener', second === first, `${first} -> ${second}`);
  await server.stop();
}

rmSync(home, { recursive: true, force: true });
console.log(failures === 0 ? '\nCORE HARDENING TESTS PASSED' : `\n${failures} CORE HARDENING FAILURES`);
process.exitCode = failures === 0 ? 0 : 1;
