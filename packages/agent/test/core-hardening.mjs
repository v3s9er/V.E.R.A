import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { WebSocket } from 'ws';

const here = fileURLToPath(new URL('.', import.meta.url));
const dist = resolve(here, '..', 'dist');
const home = mkdtempSync(join(tmpdir(), 'mr-robot-core-hardening-'));
process.env.MR_ROBOT_HOME = home;

const { ChatSession } = await import(pathToFileURL(join(dist, 'server', 'chat.js')).href);
const { canUseAuditOnly, cleanupDisconnectedClientState, WsUpgradeTickets, webSocketTicketBinding } = await import(pathToFileURL(join(dist, 'server', 'ws.js')).href);
const { FileTransferAdmission } = await import(pathToFileURL(join(dist, 'server', 'transfer-admission.js')).href);
const { ContextBroker } = await import(pathToFileURL(join(dist, 'context-broker.js')).href);
const { ToolExecutor } = await import(pathToFileURL(join(dist, 'ai', 'executor.js')).href);
const { ModelBudgetExceededError } = await import(pathToFileURL(join(dist, 'ai', 'loop.js')).href);
const { OpenAICompatibleProvider } = await import(pathToFileURL(join(dist, 'ai', 'openai.js')).href);
const { runShell } = await import(pathToFileURL(join(dist, 'computer', 'shell.js')).href);
const { AgentServer, ChatRunAdmissionPolicy, serverEventAudience } = await import(pathToFileURL(join(dist, 'server', 'server.js')).href);
const { fetchVerifiedPlainPeer, isEncryptedTailnetTransport, isPublicPeerAddress, isSecurePlainPeerTransport, normalizePeerBase, requiresSecureApiTransport } = await import(pathToFileURL(join(dist, 'server', 'http.js')).href);
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

function authenticateTestSocket(url, secret, desktopAuditProof, headers = undefined) {
  return new Promise((resolveSocket, rejectSocket) => {
    const socket = new WebSocket(url, headers ? { headers } : undefined);
    const timer = setTimeout(() => {
      try { socket.terminate(); } catch { /* best effort */ }
      rejectSocket(new Error('test WebSocket authentication timed out'));
    }, 2_000);
    const fail = (error) => {
      clearTimeout(timer);
      rejectSocket(error instanceof Error ? error : new Error(String(error)));
    };
    socket.once('error', fail);
    socket.once('open', () => {
      socket.send(JSON.stringify({
        id: 1,
        method: 'auth',
        params: { secret, ...(desktopAuditProof ? { desktopAuditProof } : {}) },
      }));
    });
    socket.on('message', (raw) => {
      let message;
      try { message = JSON.parse(String(raw)); } catch { return; }
      if (message?.id !== 1) return;
      clearTimeout(timer);
      socket.removeListener('error', fail);
      try { socket.close(); } catch { /* best effort */ }
      resolveSocket(message.result);
    });
  });
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
  check('outbound plaintext peer sockets are fail-closed to loopback or the real Tailnet adapter',
    isSecurePlainPeerTransport('127.0.0.1', '127.0.0.1') === true
    && isSecurePlainPeerTransport('100.90.1.2', '100.101.2.3', new Set(['100.101.2.3'])) === true
    && isSecurePlainPeerTransport('100.90.1.2', '100.101.2.3', new Set()) === false
    && isSecurePlainPeerTransport('192.168.1.20', '192.168.1.10', new Set()) === false);
  check('mixed-case pairing route cannot bypass the guard', requiresSecureApiTransport('/API/pair') === true);
  check('mixed-case protected API route cannot bypass the guard', requiresSecureApiTransport('/Api/status') === true);
  check('only the public health probe is exempt', requiresSecureApiTransport('/API/PING') === false);
  check('non-API pages remain outside the API transport guard', requiresSecureApiTransport('/settings') === false);
  check('named HTTPS tunnel domains are accepted as peer origins',
    normalizePeerBase('https://robot.v3s9er.com').origin === 'https://robot.v3s9er.com');
  check('public peer pinning rejects private, CGNAT, metadata, documentation and local IPv6 answers',
    isPublicPeerAddress('104.16.1.2') === true
    && isPublicPeerAddress('2606:4700::6810:102') === true
    && isPublicPeerAddress('10.0.0.1') === false
    && isPublicPeerAddress('100.64.0.1') === false
    && isPublicPeerAddress('169.254.169.254') === false
    && isPublicPeerAddress('203.0.113.8') === false
    && isPublicPeerAddress('::1') === false
    && isPublicPeerAddress('fd00::1') === false);
  let plaintextDomainRejected = false;
  try { normalizePeerBase('http://robot.v3s9er.com'); } catch { plaintextDomainRejected = true; }
  check('named tunnel domains remain HTTPS-only', plaintextDomainRejected);
  let mdnsDomainRejected = false;
  try { normalizePeerBase('https://printer.local'); } catch { mdnsDomainRejected = true; }
  check('mDNS names cannot bypass public DNS pinning', mdnsDomainRejected);
}

console.log('1bb. public WebSocket admission tickets are bound, expiring, and single-use');
{
  const localBinding = webSocketTicketBinding({
    directRemote: '127.0.0.1', directLocal: '127.0.0.1', hostHeader: '127.0.0.1:8787',
  });
  const publicBinding = webSocketTicketBinding({
    directRemote: '127.0.0.1', directLocal: '127.0.0.1', hostHeader: 'robot.example.com',
    cloudflareConnectingIp: '203.0.113.20', cloudflareRay: '1234567890abcdef-icn',
  });
  const genericProxyBinding = webSocketTicketBinding({
    directRemote: '127.0.0.1', directLocal: '127.0.0.1', hostHeader: 'proxy.example.com',
  });
  const rewrittenProxyBinding = webSocketTicketBinding({
    directRemote: '127.0.0.1', directLocal: '127.0.0.1', hostHeader: '127.0.0.1:8787',
  });
  const ordinaryAdmin = (remoteAddress, directLoopback) => ({
    remoteAddress,
    directLoopback,
    state: { auth: { isAdmin: true, permissionCap: 'full' } },
  });
  check('direct loopback stays ticket-free but network provenance alone grants no audit authority',
    localBinding.requiresTicket === false && localBinding.directLoopback === true);
  check('Cloudflare/public loopback route requires a ticket', publicBinding.requiresTicket === true
    && publicBinding.directLoopback === false
    && publicBinding.source === 'cloudflare:203.0.113.20' && publicBinding.audience === 'robot.example.com');
  check('public Host, rewritten loopback Host, Cloudflare and Tailnet paths cannot infer native audit authority',
    genericProxyBinding.requiresTicket === true
      && genericProxyBinding.directLoopback === false
      && rewrittenProxyBinding.directLoopback === true
      && canUseAuditOnly(ordinaryAdmin('public:198.51.100.4', false)) === false
      && canUseAuditOnly(ordinaryAdmin('127.0.0.1', rewrittenProxyBinding.directLoopback)) === false
      && canUseAuditOnly(ordinaryAdmin('cloudflare:203.0.113.20', false)) === false
      && canUseAuditOnly(ordinaryAdmin('100.90.1.2', false)) === false
      && canUseAuditOnly({ state: { auth: { isAdmin: true, permissionCap: 'full', nativeAuditOnly: true } } }) === true);

  const protocols = (ticket) => `mr-robot-rpc-v1, ${ticket.protocol}`;
  const tickets = new WsUpgradeTickets(1_000);
  const wrongSource = tickets.issue(publicBinding.source, publicBinding.audience, 'device:a', 10_000);
  check('source mismatch is rejected and consumes the presented ticket',
    tickets.consume(protocols(wrongSource), 'cloudflare:203.0.113.99', publicBinding.audience, 10_001) === null
    && tickets.consume(protocols(wrongSource), publicBinding.source, publicBinding.audience, 10_002) === null);
  const valid = tickets.issue(publicBinding.source, publicBinding.audience, 'device:a', 20_000);
  check('valid ticket returns only its bound principal and cannot replay',
    tickets.consume(protocols(valid), publicBinding.source, publicBinding.audience, 20_001) === 'device:a'
    && tickets.consume(protocols(valid), publicBinding.source, publicBinding.audience, 20_002) === null);
  const expired = tickets.issue(publicBinding.source, publicBinding.audience, 'device:a', 30_000);
  check('expired ticket is rejected', tickets.consume(protocols(expired), publicBinding.source, publicBinding.audience, 31_001) === null);

  const principalBound = new WsUpgradeTickets(30_000);
  const outstanding = Array.from({ length: 8 }, (_, index) => principalBound.issue(`cloudflare:198.51.100.${index + 1}`, 'robot.example.com', 'device:stolen', 40_000));
  let ninthPrincipalTicketBlocked = false;
  try { principalBound.issue('cloudflare:198.51.100.99', 'robot.example.com', 'device:stolen', 40_001); } catch { ninthPrincipalTicketBlocked = true; }
  check('one principal cannot evade outstanding-ticket limits by rotating source IPs',
    ninthPrincipalTicketBlocked && outstanding.length === 8);

  const rateBound = new WsUpgradeTickets(30_000);
  for (let index = 0; index < 16; index++) {
    const issued = rateBound.issue('cloudflare:203.0.113.8', 'robot.example.com', 'device:rate', 50_000 + index);
    rateBound.consume(protocols(issued), 'cloudflare:203.0.113.8', 'robot.example.com', 50_000 + index);
  }
  let issueRateBlocked = false;
  try { rateBound.issue('cloudflare:203.0.113.9', 'robot.example.com', 'device:rate', 50_020); } catch { issueRateBlocked = true; }
  check('ticket consumption cannot bypass the per-principal issuance window', issueRateBlocked);

  const globallyBound = new WsUpgradeTickets(30_000);
  const firstGlobal = globallyBound.issue('cloudflare:192.0.2.1', 'robot.example.com', 'device:0', 60_000);
  for (let index = 1; index < 512; index++) {
    globallyBound.issue(`cloudflare:192.0.${Math.floor(index / 250) + 2}.${(index % 250) + 1}`, 'robot.example.com', `device:${index}`, 60_000);
  }
  let globalCapacityBlocked = false;
  try { globallyBound.issue('cloudflare:203.0.113.250', 'robot.example.com', 'device:overflow', 60_001); } catch { globalCapacityBlocked = true; }
  check('global capacity rejects overflow without evicting another principal ticket',
    globalCapacityBlocked && globallyBound.consume(protocols(firstGlobal), 'cloudflare:192.0.2.1', 'robot.example.com', 60_002) === 'device:0');
}

console.log('1bc. verified plaintext peer responses preserve Fetch body boundaries');
{
  const peer = createServer((request, response) => {
    const path = request.url ?? '/';
    if (path === '/normal') {
      response.writeHead(206, 'Partial Content', {
        'content-type': 'application/octet-stream',
        'content-length': '12',
        'x-peer-boundary': 'preserved',
      });
      response.end('hello peer!\n');
      return;
    }
    if (path === '/slow') return;
    const status = Number(path.slice(1));
    response.writeHead(status, { 'x-peer-boundary': String(status) });
    // 205 can legally arrive with bytes from a non-conforming peer. The
    // wrapper must still expose the Fetch-mandated null body without buffering.
    response.end(status === 205 ? 'must-not-leak' : undefined);
  });
  await new Promise((resolveListen, rejectListen) => {
    peer.once('error', rejectListen);
    peer.listen(0, '127.0.0.1', resolveListen);
  });
  const address = peer.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  try {
    const normal = await fetchVerifiedPlainPeer(
      new URL(`http://127.0.0.1:${port}/normal`),
      { accept: 'application/octet-stream' },
      AbortSignal.timeout(2_000),
    );
    check('ordinary peer response preserves status, headers, and streaming body',
      normal.status === 206
      && normal.statusText === 'Partial Content'
      && normal.headers.get('x-peer-boundary') === 'preserved'
      && await normal.text() === 'hello peer!\n');

    for (const status of [204, 205, 304]) {
      const response = await fetchVerifiedPlainPeer(
        new URL(`http://127.0.0.1:${port}/${status}`),
        {},
        AbortSignal.timeout(2_000),
      );
      check(`${status} peer response resolves bodyless without an uncaught constructor error`,
        response.status === status
        && response.headers.get('x-peer-boundary') === String(status)
        && response.body === null
        && await response.text() === '');
    }

    const controller = new AbortController();
    const pending = fetchVerifiedPlainPeer(
      new URL(`http://127.0.0.1:${port}/slow`),
      {},
      controller.signal,
    );
    setTimeout(() => controller.abort(new Error('peer request test abort')), 20);
    let aborted = false;
    try { await pending; } catch { aborted = true; }
    check('verified peer request retains AbortSignal cancellation', aborted);
  } finally {
    peer.closeAllConnections();
    await new Promise((resolveClose) => peer.close(resolveClose));
  }
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

  const localStarted = await server.start({ port: 0 });
  const nativeProof = server.issueDesktopAuditProof();
  const nativeAuth = await authenticateTestSocket(`ws://127.0.0.1:${localStarted.port}/ws`, server.secret, nativeProof);
  const replayedProof = await authenticateTestSocket(`ws://127.0.0.1:${localStarted.port}/ws`, server.secret, nativeProof);
  const rewrittenProxyAuth = await authenticateTestSocket(
    `ws://127.0.0.1:${localStarted.port}/ws`,
    server.secret,
    undefined,
    { Host: `127.0.0.1:${localStarted.port}` },
  );
  check('only a fresh main-process-issued proof grants local desktop audit authority and it cannot replay',
    nativeAuth?.ok === true && nativeAuth.canUseAuditOnly === true
      && replayedProof?.ok === true && replayedProof.canUseAuditOnly === false
      && rewrittenProxyAuth?.ok === true && rewrittenProxyAuth.canUseAuditOnly === false);
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
  const admin = { id: 'local-admin', remoteAddress: '127.0.0.1', directLoopback: true, state: { auth: { isAdmin: true, permissionCap: 'full', nativeAuditOnly: true }, chat: new ChatSession() } };
  const remoteAdmin = { id: 'remote-admin', remoteAddress: 'cloudflare:203.0.113.20', directLoopback: false, state: { auth: { isAdmin: true, permissionCap: 'full' }, chat: new ChatSession() } };
  let readOnlyCreateBlocked = false;
  let readOnlyMemoryBlocked = false;
  try { handlers.get('conversations.create')({ title: 'escape', permissionMode: 'full' }, readOnly); } catch { readOnlyCreateBlocked = true; }
  try { handlers.get('memory.add')({ text: 'poison' }, readOnly); } catch { readOnlyMemoryBlocked = true; }
  check('read-only devices cannot mutate retained content', readOnlyCreateBlocked && readOnlyMemoryBlocked);

  const created = handlers.get('conversations.create')({ title: 'bounded', permissionMode: 'full' }, ask);
  const updated = handlers.get('conversations.update')({ id: created.id, permissionMode: 'full' }, ask);
  check('ask devices cannot persist a full-permission conversation', created.permissionMode === 'ask' && updated.permissionMode === 'ask');

  const linkedAudit = handlers.get('conversations.create')({ title: 'linked audit attempt', tokenPolicy: 'audit-only' }, ask);
  const adminAudit = handlers.get('conversations.create')({ title: 'local audit', tokenPolicy: 'audit-only' }, admin);
  const remoteAdminAudit = handlers.get('conversations.create')({ title: 'remote admin audit attempt', tokenPolicy: 'audit-only' }, remoteAdmin);
  const linkedDowngrade = handlers.get('conversations.update')({ id: adminAudit.id, tokenPolicy: 'audit-only' }, ask);
  check('only a native-capability administrator can persist audit-only token policy',
    linkedAudit.tokenPolicy === 'adaptive'
      && adminAudit.tokenPolicy === 'audit-only'
      && remoteAdminAudit.tokenPolicy === 'adaptive'
      && linkedDowngrade.tokenPolicy === 'adaptive');
  let invalidTokenPolicyRejected = false;
  try { handlers.get('conversations.create')({ tokenPolicy: 'unbounded' }, admin); } catch { invalidTokenPolicyRejected = true; }
  let invalidTokenPolicyUpdateRejected = false;
  try { handlers.get('conversations.update')({ id: created.id, tokenPolicy: 'unbounded' }, admin); } catch { invalidTokenPolicyUpdateRejected = true; }
  check('explicit invalid conversation token policies are rejected', invalidTokenPolicyRejected && invalidTokenPolicyUpdateRejected);
}

console.log('8b. model-run admission is shared, bounded, and failure-safe');
{
  let now = 10_000;
  const policy = new ChatRunAdmissionPolicy({
    now: () => now,
    globalActive: 2,
    linkedActive: 1,
    adminActive: 2,
    startWindowMs: 1_000,
    globalStartsPerWindow: 20,
    linkedStartsPerWindow: 10,
    adminStartsPerWindow: 20,
    auditWindowMs: 1_000,
    maxPrincipals: 2,
  });
  const linkedAuth = (id) => ({ isAdmin: false, linkId: id, permissionCap: 'ask' });
  const first = policy.acquire(linkedAuth('one'));
  let activeBlocked = false;
  try { policy.acquire(linkedAuth('one')); } catch { activeBlocked = true; }
  first.finish({ promptTokens: 60, completionTokens: 50 });
  first.finish({ promptTokens: 999, completionTokens: 999 });
  const afterFirst = policy.snapshot();
  const afterHardTask = policy.acquire(linkedAuth('one'));
  afterHardTask.finish({ promptTokens: 0, completionTokens: 0 });
  check('linked active slots release idempotently without a fixed rolling token lockout',
    activeBlocked && afterFirst.globalActive === 0 && afterFirst.globalTokens === 110);
  now += 1_000;
  const afterExpiry = policy.acquire(linkedAuth('one'));
  afterExpiry.finish({ promptTokens: 1, completionTokens: 0 });
  check('diagnostic token history expires without controlling admission', policy.snapshot().globalTokens === 1);

  const secondIdentity = policy.acquire(linkedAuth('two'));
  secondIdentity.finish({ promptTokens: 1, completionTokens: 0 });
  let identityMapBlocked = false;
  try { policy.acquire(linkedAuth('three')); } catch { identityMapBlocked = true; }
  check('principal accounting map remains bounded and fails closed', identityMapBlocked && policy.snapshot().principalCount === 2);
  const staleLease = policy.acquire(linkedAuth('one'));
  policy.clear();
  staleLease.finish({ promptTokens: 100, completionTokens: 100 });
  check('clear resets counters and late completions cannot repopulate a stopped epoch',
    JSON.stringify(policy.snapshot()) === JSON.stringify({ principalCount: 0, globalActive: 0, globalProviderCallsInFlight: 0, globalReserved: 0, globalStarts: 0, globalTokens: 0, globalAuditTokens: 0 }));
}

{
  const auth = { isAdmin: false, linkId: 'parallel-budget', permissionCap: 'ask' };
  const policy = new ChatRunAdmissionPolicy({
    globalActive: 2,
    linkedActive: 2,
    adminActive: 2,
    globalStartsPerWindow: 20,
    linkedStartsPerWindow: 20,
    adminStartsPerWindow: 20,
  });
  const first = policy.acquire(auth);
  const second = policy.acquire(auth);
  let thirdBlocked = false;
  try { policy.acquire(auth); } catch { thirdBlocked = true; }
  check('concurrent jobs retain independent adaptive budgets while active slots remain bounded',
    thirdBlocked && first.tokenBudget === 64_000 && second.tokenBudget === 64_000 && policy.snapshot().globalReserved === 128_000);
  first.finish();
  second.finish();
  const next = policy.acquire(auth);
  next.finish({ promptTokens: 0, completionTokens: 0 });
  check('unknown failed runs remain audited without blocking the next legitimate task',
    policy.snapshot().globalReserved === 0 && policy.snapshot().globalTokens === 128_000);
}

{
  const auth = { isAdmin: false, linkId: 'incremental-budget', permissionCap: 'ask' };
  const policy = new ChatRunAdmissionPolicy({
    globalActive: 1,
    linkedActive: 1,
    adminActive: 1,
    globalStartsPerWindow: 20,
    linkedStartsPerWindow: 20,
    adminStartsPerWindow: 20,
    adaptiveSimpleCallTokens: 20,
    adaptiveStandardCallTokens: 40,
    adaptiveComplexCallTokens: 80,
    adaptiveAbsoluteMaxTokens: 100,
  });
  const partial = policy.acquire(auth);
  const failedCall = partial.reserveModelCall('api', 30);
  let parallelCallBlocked = false;
  try { partial.reserveModelCall('api', 80); } catch { parallelCallBlocked = true; }
  failedCall.finish();
  partial.finish();
  check('a failed provider invocation retains its conservative call reservation exactly once',
    parallelCallBlocked && policy.snapshot().globalTokens === 30 && policy.snapshot().globalReserved === 0);
  policy.clear();
  const successful = policy.acquire(auth);
  const exactCall = successful.reserveModelCall('api', 40);
  const within = exactCall.finish({ promptTokens: 6, completionTokens: 4 });
  successful.finish({ promptTokens: 6, completionTokens: 4 });
  check('syntactically valid under-reporting cannot release the host reservation',
    within && policy.snapshot().globalTokens === 40);
}

{
  const auth = { isAdmin: true, permissionCap: 'full' };
  const policy = new ChatRunAdmissionPolicy({ globalStartsPerWindow: 40, adminStartsPerWindow: 40 });
  const profile = (overrides = {}) => ({
    tokenPolicy: 'adaptive', complexity: 0, executionMode: 'single', reasoningEffort: 'none',
    plannedModelCalls: 1, hasTools: false, inputBytes: 0, ...overrides,
  });

  const simple = policy.acquire(auth);
  simple.configureModelBudget(profile());
  const simpleBudget = simple.tokenBudget;
  simple.finish({ promptTokens: 0, completionTokens: 0 });
  const highTool = policy.acquire(auth);
  highTool.configureModelBudget(profile({ complexity: 6, reasoningEffort: 'high', hasTools: true }));
  const highBudget = highTool.tokenBudget;
  highTool.finish({ promptTokens: 0, completionTokens: 0 });
  const pipeline = policy.acquire(auth);
  pipeline.configureModelBudget(profile({ complexity: 6, executionMode: 'pipeline', reasoningEffort: 'max', plannedModelCalls: 4 }));
  const pipelineBudget = pipeline.tokenBudget;
  pipeline.finish({ promptTokens: 0, completionTokens: 0 });
  const swarm = policy.acquire(auth);
  swarm.configureModelBudget(profile({ complexity: 8, executionMode: 'swarm', reasoningEffort: 'max', plannedModelCalls: 20, hasTools: true }));
  const swarmBudget = swarm.tokenBudget;
  swarm.finish({ promptTokens: 0, completionTokens: 0 });
  check('adaptive budgets scale from simple work through reasoning and configured workflows',
    simpleBudget === 51_200 && highBudget > simpleBudget && pipelineBudget === 8_000_000 && swarmBudget === 8_000_000);

  const progressing = policy.acquire(auth);
  progressing.configureModelBudget(profile({ hasTools: true }));
  const firstProgressCall = progressing.reserveModelCall('api', 40_000);
  firstProgressCall.finish({ promptTokens: 30_000, completionTokens: 0 });
  let beforeProgressBlocked = false;
  try { progressing.reserveModelCall('api', 30_000); } catch { beforeProgressBlocked = true; }
  progressing.noteModelProgress('tool');
  const continued = progressing.reserveModelCall('api', 30_000);
  const continuedWithin = continued.finish({ promptTokens: 20_000, completionTokens: 0 });
  progressing.finish({ promptTokens: 50_000, completionTokens: 0 });
  check('single tool loops expand only after a completed progress round', beforeProgressBlocked && continuedWithin);

  policy.clear();
  const ordinary = policy.acquire(auth);
  ordinary.configureModelBudget(profile({ hasTools: true }));
  const estimated = ordinary.reserveModelCall('api', 20);
  const hiddenPromptAccepted = estimated.finish({ promptTokens: 28, completionTokens: 2 });
  ordinary.finish({ promptTokens: 28, completionTokens: 2 });
  check('provider usage may exceed a conservative call estimate within the held run budget',
    hiddenPromptAccepted && policy.snapshot().globalTokens === 30);

  policy.clear();
  const runaway = policy.acquire(auth);
  runaway.configureModelBudget(profile());
  const smallEstimate = runaway.reserveModelCall('api', 20);
  const runawayBlocked = !smallEstimate.finish({ promptTokens: 10_000_000, completionTokens: 1 });
  runaway.finish({ promptTokens: 10_000_000, completionTokens: 1 });
  check('a provider report beyond the whole run allowance still fails closed as token debt',
    runawayBlocked && policy.snapshot().globalTokens === 10_000_001);
}

{
  const policy = new ChatRunAdmissionPolicy({
    globalActive: 8,
    linkedActive: 4,
    adminActive: 4,
    globalProviderCallsInFlight: 2,
    linkedProviderCallsInFlight: 1,
    adminProviderCallsInFlight: 2,
    globalStartsPerWindow: 100,
    linkedStartsPerWindow: 100,
    adminStartsPerWindow: 100,
  });
  const linked = (id) => ({ isAdmin: false, linkId: id, permissionCap: 'ask' });
  const first = policy.acquire(linked('provider-a'));
  const firstCall = first.reserveModelCall('api', 5);
  let principalLimitError;
  try { first.reserveModelCall('api', 5); } catch (error) { principalLimitError = error; }

  const second = policy.acquire(linked('provider-b'));
  const secondCall = second.reserveModelCall('api', 5);
  const third = policy.acquire(linked('provider-c'));
  let globalLimitError;
  try { third.reserveModelCall('api', 5); } catch (error) { globalLimitError = error; }
  check('provider-call fan-out obeys typed per-principal and global in-flight limits without leaking rejected reservations',
    principalLimitError instanceof ModelBudgetExceededError
      && globalLimitError instanceof ModelBudgetExceededError
      && policy.snapshot().globalProviderCallsInFlight === 2);

  firstCall.finish({ promptTokens: 1, completionTokens: 0 });
  const retriedCall = first.reserveModelCall('api', 5);
  retriedCall.finish({ promptTokens: 1, completionTokens: 0 });
  retriedCall.finish({ promptTokens: 999, completionTokens: 999 });
  first.finish({ promptTokens: 2, completionTokens: 0 });
  secondCall.finish({ promptTokens: 1, completionTokens: 0 });
  second.finish({ promptTokens: 1, completionTokens: 0 });
  third.finish({ promptTokens: 0, completionTokens: 0 });
  check('provider-call finish is idempotent and releases capacity for a retry',
    policy.snapshot().globalProviderCallsInFlight === 0);

  const tokensBeforeOrphan = policy.snapshot().globalTokens;
  const orphaned = policy.acquire(linked('provider-orphan'));
  const orphanedCall = orphaned.reserveModelCall('api', 5);
  const neighboring = policy.acquire(linked('provider-neighbor'));
  const neighboringCall = neighboring.reserveModelCall('api', 5);
  orphaned.finish({ promptTokens: 0, completionTokens: 0 });
  const afterOrphanRunFinish = policy.snapshot();
  const blockedWhileProviderLives = policy.acquire(linked('provider-blocked'));
  let stillAtGlobalLimit;
  try { blockedWhileProviderLives.reserveModelCall('api', 5); } catch (error) { stillAtGlobalLimit = error; }
  blockedWhileProviderLives.finish({ promptTokens: 0, completionTokens: 0 });
  orphanedCall.finish({ promptTokens: 999, completionTokens: 999 });
  const afterLateOrphanFinish = policy.snapshot();
  orphanedCall.finish({ promptTokens: 999, completionTokens: 999 });
  const afterDuplicateOrphanFinish = policy.snapshot();
  neighboringCall.finish({ promptTokens: 1, completionTokens: 0 });
  neighboring.finish({ promptTokens: 1, completionTokens: 0 });
  check('top-level finish cannot release a live provider slot and call settlement releases it exactly once',
    afterOrphanRunFinish.globalProviderCallsInFlight === 2
      && afterOrphanRunFinish.globalTokens === tokensBeforeOrphan + 5
      && stillAtGlobalLimit instanceof ModelBudgetExceededError
      && afterLateOrphanFinish.globalProviderCallsInFlight === 1
      && afterLateOrphanFinish.globalTokens === afterOrphanRunFinish.globalTokens
      && afterDuplicateOrphanFinish.globalProviderCallsInFlight === 1
      && policy.snapshot().globalProviderCallsInFlight === 0);

  const stale = policy.acquire(linked('provider-stale'));
  const staleCall = stale.reserveModelCall('api', 5);
  policy.clear();
  const afterClearWithLiveProvider = policy.snapshot();
  const fresh = policy.acquire(linked('provider-fresh'));
  const freshCall = fresh.reserveModelCall('api', 5);
  const afterFreshProvider = policy.snapshot();
  staleCall.finish({ promptTokens: 1, completionTokens: 0 });
  stale.finish({ promptTokens: 1, completionTokens: 0 });
  const afterStaleFinish = policy.snapshot();
  freshCall.finish({ promptTokens: 1, completionTokens: 0 });
  fresh.finish({ promptTokens: 1, completionTokens: 0 });
  check('clear starts a new epoch whose live provider count cannot be decremented by a stale finish',
    afterClearWithLiveProvider.globalProviderCallsInFlight === 1
      && afterFreshProvider.globalProviderCallsInFlight === 2
      && afterStaleFinish.globalProviderCallsInFlight === 1
      && policy.snapshot().globalProviderCallsInFlight === 0);
}

{
  const admin = { isAdmin: true, permissionCap: 'full' };
  const linked = { isAdmin: false, linkId: 'audit-link', permissionCap: 'ask' };
  const policy = new ChatRunAdmissionPolicy({ globalStartsPerWindow: 20, adminStartsPerWindow: 20, linkedStartsPerWindow: 20 });
  const auditProfile = {
    tokenPolicy: 'audit-only', complexity: 0, executionMode: 'single', reasoningEffort: 'none',
    plannedModelCalls: 1, hasTools: false, inputBytes: 0,
  };
  const audit = policy.acquire(admin, { allowAuditOnly: true });
  audit.configureModelBudget(auditProfile);
  const auditCall = audit.reserveModelCall('api', 20);
  const auditContinues = auditCall.finish({ promptTokens: 10_000_000, completionTokens: 1 });
  audit.finish({ promptTokens: 10_000_000, completionTokens: 1 });
  const afterAudit = policy.snapshot();
  const adaptive = policy.acquire(admin);
  adaptive.configureModelBudget({ ...auditProfile, tokenPolicy: 'adaptive' });
  const afterAuditCall = adaptive.reserveModelCall('api', 20);
  const adaptiveUnaffected = afterAuditCall.finish({ promptTokens: 10, completionTokens: 0 });
  adaptive.finish({ promptTokens: 10, completionTokens: 0 });
  check('administrator audit-only usage never stops on tokens or contaminates adaptive accounting',
    auditContinues && afterAudit.globalTokens === 0 && afterAudit.globalAuditTokens === 10_000_001 && adaptiveUnaffected);

  const remoteAttempt = policy.acquire(linked);
  remoteAttempt.configureModelBudget(auditProfile);
  const remoteCall = remoteAttempt.reserveModelCall('api', 20);
  const remoteRunawayBlocked = !remoteCall.finish({ promptTokens: 10_000_000, completionTokens: 0 });
  remoteAttempt.finish({ promptTokens: 10_000_000, completionTokens: 0 });
  check('linked clients cannot activate audit-only by bypassing the RPC UI',
    remoteAttempt.tokenPolicy === 'adaptive' && remoteRunawayBlocked);

  const remoteAdminAttempt = policy.acquire(admin);
  remoteAdminAttempt.configureModelBudget(auditProfile);
  const remoteAdminCall = remoteAdminAttempt.reserveModelCall('api', 20);
  const remoteAdminRunawayBlocked = !remoteAdminCall.finish({ promptTokens: 10_000_000, completionTokens: 0 });
  remoteAdminAttempt.finish({ promptTokens: 10_000_000, completionTokens: 0 });
  check('administrator identity alone cannot bypass adaptive policy without a local capability',
    remoteAdminAttempt.tokenPolicy === 'adaptive' && remoteAdminRunawayBlocked);

  const invalid = policy.acquire(admin);
  invalid.configureModelBudget({ ...auditProfile, tokenPolicy: 'adaptive' });
  const invalidCall = invalid.reserveModelCall('api', 20);
  const invalidBlocked = !invalidCall.finish({ promptTokens: 0, completionTokens: 0, reportStatus: 'invalid' });
  invalid.finish({ promptTokens: 0, completionTokens: 0 });
  check('a normalized invalid provider report still fails closed and remains finite in diagnostics',
    invalidBlocked && Number.isFinite(policy.snapshot().globalTokens));

  const auditInvalid = policy.acquire(admin, { allowAuditOnly: true });
  auditInvalid.configureModelBudget(auditProfile);
  const auditInvalidCall = auditInvalid.reserveModelCall('api', 20);
  const auditInvalidContinues = auditInvalidCall.finish({ promptTokens: 0, completionTokens: 0, reportStatus: 'invalid' });
  auditInvalid.finish({ promptTokens: 0, completionTokens: 0 });
  check('audit-only keeps malformed reports as finite reservation-based audit usage',
    auditInvalidContinues && Number.isFinite(policy.snapshot().globalAuditTokens));

  policy.clear();
  const auditUnderReport = policy.acquire(admin, { allowAuditOnly: true });
  auditUnderReport.configureModelBudget(auditProfile);
  const auditUnderReportCall = auditUnderReport.reserveModelCall('api', 20);
  const auditUnderReportContinues = auditUnderReportCall.finish({ promptTokens: 1, completionTokens: 1 });
  auditUnderReport.finish({ promptTokens: 1, completionTokens: 1 });
  check('audit-only accounting also retains the host reservation against plausible under-reporting',
    auditUnderReportContinues && policy.snapshot().globalAuditTokens === 20);
}

{
  const store = new ConversationStore(join(home, 'finite-token-accounting'));
  const conversation = store.create({ tokenPolicy: 'audit-only' });
  const updated = store.appendResult(conversation.id, [], {
    promptTokens: Number.POSITIVE_INFINITY,
    completionTokens: -5,
    cachedPromptTokens: 1e30,
    cacheWritePromptTokens: Number.NaN,
    reasoningTokens: 4.9,
  });
  check('persisted usage normalizes malformed provider counters to finite saturated integers',
    updated.usage.promptTokens === 0
      && updated.usage.completionTokens === 0
      && updated.usage.cachedPromptTokens === 1_000_000_000_000
      && updated.usage.cacheWritePromptTokens === 0
      && updated.usage.reasoningTokens === 4);
}

{
  const server = new AgentServer();
  const handlers = server.handlers();
  let providerCalls = 0;
  server.loop.run = async () => {
    providerCalls += 1;
    return { text: 'unexpected', turns: [], usage: { promptTokens: 1, completionTokens: 1 } };
  };
  const readOnlyAuth = { isAdmin: false, linkId: 'strict-reader', permissionCap: 'read-only' };
  const readOnlyClient = { id: 'strict-reader-client', state: { auth: readOnlyAuth, chat: new ChatSession() } };
  const before = server.conversations.list().length;
  let wsBlocked = false;
  let restBlocked = false;
  try { await handlers.get('chat.start')({ text: 'must not persist' }, readOnlyClient); } catch { wsBlocked = true; }
  try { await server.chatOnce('must not call provider', readOnlyAuth); } catch { restBlocked = true; }
  check('read-only WS and REST chat reject before provider use or retained-content mutation',
    wsBlocked && restBlocked && providerCalls === 0 && server.conversations.list().length === before);
}

{
  const server = new AgentServer();
  const handlers = server.handlers();
  const admin = { id: 'policy-admin', remoteAddress: '::1', directLoopback: true, state: { auth: { isAdmin: true, permissionCap: 'full', nativeAuditOnly: true }, chat: new ChatSession() } };
  const remoteAdmin = { id: 'policy-remote-admin', remoteAddress: '100.85.4.9', directLoopback: false, state: { auth: { isAdmin: true, permissionCap: 'full' }, chat: new ChatSession() } };
  const linked = { id: 'policy-link', state: { auth: { isAdmin: false, linkId: 'policy-link-id', permissionCap: 'ask' }, chat: new ChatSession() } };
  const conversation = handlers.get('conversations.create')({ title: 'audit locally', tokenPolicy: 'audit-only' }, admin);
  const observedPolicies = [];
  server.loop.run = async (_turns, _text, _callbacks, _tools, options) => {
    observedPolicies.push(options.tokenPolicy);
    return { text: 'ok', turns: [], usage: { promptTokens: 0, completionTokens: 0 } };
  };
  await handlers.get('chat.start')({ conversationId: conversation.id, text: 'linked attempt', tokenPolicy: 'audit-only' }, linked);
  await handlers.get('chat.start')({ conversationId: conversation.id, text: 'admin run', tokenPolicy: 'audit-only' }, admin);
  await handlers.get('chat.start')({ conversationId: conversation.id, text: 'remote admin attempt', tokenPolicy: 'audit-only' }, remoteAdmin);
  check('linked and remote-administrator execution of an audit-only conversation is forced back to adaptive',
    observedPolicies[0] === 'adaptive' && observedPolicies[1] === 'audit-only' && observedPolicies[2] === 'adaptive');

  const startsBeforeInvalid = server.chatRunAdmission.snapshot().globalStarts;
  let invalidStartRejected = false;
  try { handlers.get('chat.start')({ conversationId: conversation.id, text: 'bad policy', tokenPolicy: 'unbounded' }, admin); } catch { invalidStartRejected = true; }
  admin.state.chat.begin();
  let busyRejected = false;
  try { handlers.get('chat.start')({ conversationId: conversation.id, text: 'busy' }, admin); } catch { busyRejected = true; }
  admin.state.chat.end();
  check('invalid or already-busy starts are rejected before consuming admission state',
    invalidStartRejected && busyRejected && server.chatRunAdmission.snapshot().globalStarts === startsBeforeInvalid);
}

{
  const server = new AgentServer();
  server.chatRunAdmission = new ChatRunAdmissionPolicy({
    globalActive: 4,
    linkedActive: 1,
    adminActive: 4,
    globalStartsPerWindow: 100,
    linkedStartsPerWindow: 100,
    adminStartsPerWindow: 100,
  });
  const auth = { isAdmin: false, linkId: 'shared-budget-link', permissionCap: 'ask' };
  const client = { id: 'shared-budget-ws', state: { auth, chat: new ChatSession() } };
  const handlers = server.handlers();
  let resolveRest;
  server.loop.run = () => new Promise((resolveRun) => { resolveRest = resolveRun; });
  const conversationsBeforeBlockedRun = server.conversations.list().length;
  const restRun = server.chatOnce('hold REST slot', auth);
  let wsWhileRestBlocked = false;
  try { await handlers.get('chat.start')({ text: 'same principal over WS' }, client); } catch { wsWhileRestBlocked = true; }
  const noConversationOnAdmissionFailure = server.conversations.list().length === conversationsBeforeBlockedRun;
  resolveRest({ text: 'released', turns: [], usage: { promptTokens: 5, completionTokens: 3 } });
  await restRun;

  server.loop.run = async (_turns, text, callbacks) => {
    const call = callbacks.reserveModelCall('api', 100);
    if (text === 'provider failure') {
      // A real provider promise rejected, so its call lease settles in catch.
      call.finish({ promptTokens: 2, completionTokens: 1 });
      callbacks.onModelUsage?.({ promptTokens: 2, completionTokens: 1, accountedTokens: call.accountedTokens });
      throw new Error('expected provider failure');
    }
    if (text === 'cancel me') {
      return await new Promise((_resolveRun, rejectRun) => {
        callbacks.signal.addEventListener('abort', () => {
          call.finish();
          rejectRun(callbacks.signal.reason ?? new Error('cancelled'));
        }, { once: true });
      });
    }
    call.finish({ promptTokens: 7, completionTokens: 2 });
    return {
      text: 'ok',
      turns: [{ role: 'user', content: text }, { role: 'assistant', content: 'ok' }],
      usage: { promptTokens: 7, completionTokens: 2 },
    };
  };
  const afterRest = await handlers.get('chat.start')({ text: 'after REST release' }, client);
  const usageBeforeFailure = server.conversations.get(client.state.chat.conversationId).usage;
  const accountedBeforeFailure = server.telemetry.summary().accountedTokens;
  const failed = await handlers.get('chat.start')({ text: 'provider failure' }, client);
  const usageAfterFailure = server.conversations.get(client.state.chat.conversationId).usage;
  const failedTrace = server.telemetry.list().find((trace) => trace.ok === false && trace.error === 'expected provider failure');
  const accountedAfterFailure = server.telemetry.summary().accountedTokens;
  const cancelPromise = handlers.get('chat.start')({ text: 'cancel me' }, client);
  const cancelId = client.state.chat.conversationId;
  handlers.get('chat.cancel')({ conversationId: cancelId }, client);
  const cancelled = await cancelPromise;
  const recovered = await handlers.get('chat.start')({ text: 'after failure and cancel' }, client);
  check('REST and WS share a principal active budget without mutating on rejection',
    wsWhileRestBlocked && noConversationOnAdmissionFailure && afterRest.ok === true);
  check('failed runs persist partial actual usage and reservation-floor audit usage exactly once',
    usageAfterFailure.promptTokens - usageBeforeFailure.promptTokens === 2
      && usageAfterFailure.completionTokens - usageBeforeFailure.completionTokens === 1
      && (usageAfterFailure.accountedTokens ?? 0) - (usageBeforeFailure.accountedTokens ?? 0) === 100
      && failedTrace?.promptTokens === 2
      && failedTrace?.completionTokens === 1
      && failedTrace?.accountedTokens === 100
      && accountedAfterFailure - accountedBeforeFailure === 100);
  check('failure and cancellation release the shared active counter for the next run',
    failed.ok === false
      && cancelled.ok === false
      && recovered.ok === true
      && server.chatRunAdmission.snapshot().globalActive === 0
      && server.chatRunAdmission.snapshot().globalProviderCallsInFlight === 0);
}

console.log('8ca. REST chat persists actual and accounted usage exactly once');
{
  const server = new AgentServer();
  server.config.providers.push({
    id: 'rest-meter',
    label: 'REST meter',
    type: 'openai-compatible',
    baseUrl: 'https://provider.invalid/v1',
    model: 'meter-model',
    apiKey: 'test-only',
    isDefault: true,
    inputCostPerMillion: 2,
    outputCostPerMillion: 5,
  });
  const observedPolicies = [];
  let invocation = 0;
  server.loop.run = async (_turns, _text, callbacks, _tools, options) => {
    invocation += 1;
    observedPolicies.push(options.tokenPolicy);
    const source = { providerId: 'rest-meter', providerLabel: 'REST meter', model: 'meter-model' };
    if (invocation === 1) {
      callbacks.onModelUsage?.({ promptTokens: 3, completionTokens: 2, accountedTokens: 100 }, source);
      return {
        text: 'REST success',
        turns: [{ role: 'assistant', content: 'REST success' }],
        usage: { promptTokens: 3, completionTokens: 2 },
        route: { ...source, role: 'general', effort: 'none', reason: 'focused REST test' },
      };
    }
    callbacks.onModelUsage?.({ promptTokens: 4, completionTokens: 1, accountedTokens: 200 }, source);
    throw new Error('expected REST partial failure');
  };
  const before = server.telemetry.summary();
  const traceCountBefore = server.telemetry.list(1_000).length;
  const started = await server.start({ port: 0, host: '127.0.0.1' });
  const request = (text) => fetch(`http://127.0.0.1:${started.port}/api/chat`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-mr-robot-token': server.secret,
    },
    body: JSON.stringify({ text }),
  });
  try {
    const success = await request('success');
    const successBody = await success.json();
    const partialFailure = await request('failure');
    const after = server.telemetry.summary();
    const newTraces = server.telemetry.list(1_000).slice(0, 2);
    const failedTrace = newTraces.find((trace) => trace.ok === false);
    const successTrace = newTraces.find((trace) => trace.ok === true && trace.providerId === 'rest-meter');
    check('REST remains adaptive and writes one success plus one partial-failure telemetry record',
      success.ok && successBody.text === 'REST success' && !partialFailure.ok
        && observedPolicies.every((policy) => policy === 'adaptive')
        && server.telemetry.list(1_000).length - traceCountBefore === 2);
    check('REST Settings aggregates retain actual usage and reservation-floor audit usage without double counting',
      after.promptTokens - before.promptTokens === 7
        && after.completionTokens - before.completionTokens === 3
        && after.accountedTokens - before.accountedTokens === 300
        && successTrace?.accountedTokens === 100
        && failedTrace?.accountedTokens === 200);
    check('REST cost uses only actual provider-reported tokens on success and partial failure',
      Math.abs((successTrace?.estimatedCost ?? -1) - 0.000016) < 1e-12
        && Math.abs((failedTrace?.estimatedCost ?? -1) - 0.000013) < 1e-12);
  } finally {
    await server.stop();
  }
}

console.log('8c. HTTP transfer admission is concurrent-safe and byte-bounded');
{
  const policy = new FileTransferAdmission({
    globalActive: 2,
    principalActive: 1,
    windowMs: 1_000,
    globalBytes: 100,
    principalBytes: 60,
    maxPrincipals: 4,
  });
  const first = policy.acquire('device:a', 60, 10_000);
  let samePrincipalBlocked = false;
  try { policy.acquire('device:a', 1, 10_000); } catch { samePrincipalBlocked = true; }
  const second = policy.acquire('device:b', 40, 10_000);
  let globalActiveBlocked = false;
  try { policy.acquire('device:c', 1, 10_000); } catch { globalActiveBlocked = true; }
  check('parallel reservations cannot exceed per-device or global active limits',
    samePrincipalBlocked && globalActiveBlocked && policy.snapshot().active === 2 && policy.snapshot().reserved === 100);
  first.settle(20, 10_100);
  second.settle(40, 10_100);
  let debtBlocked = false;
  try { policy.acquire('device:a', 41, 10_100); } catch { debtBlocked = true; }
  const within = policy.acquire('device:a', 40, 10_100);
  within.settle(5, 10_200);
  check('settlement replaces reservations with actual rolling byte debt exactly once',
    debtBlocked && policy.snapshot().active === 0 && policy.snapshot().reserved === 0 && policy.snapshot().bytes === 65);
  const afterExpiry = policy.acquire('device:a', 60, 11_201);
  afterExpiry.settle(0, 11_201);
  check('rolling transfer debt expires and idle principal state remains bounded',
    policy.snapshot().active === 0 && policy.snapshot().reserved === 0 && policy.snapshot().bytes === 0);
}

console.log('9. cross-PC sync validates both stores and preserves local access decisions');
{
  const server = new AgentServer();
  const local = server.conversations.create({ title: 'local original', permissionMode: 'full', tokenPolicy: 'audit-only' });
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
  imported.tokenPolicy = 'audit-only';
  imported.workspaceId = 'destination-sensitive-workspace';
  imported.createdAt = Date.now();
  imported.updatedAt = Date.now();
  server.mergeSyncSnapshot({ version: 1, conversations: [imported], routingPresets: [] });
  const safe = server.conversations.get(imported.id);
  check('new synced conversations are ask-capped and lose remote-only local authority',
    safe?.permissionMode === 'ask' && safe.tokenPolicy === 'adaptive' && safe.workspaceId === undefined);

  const policySource = new ConversationStore(join(home, 'sync-policy-source'));
  const policyTarget = new ConversationStore(join(home, 'sync-policy-target'));
  const policyConversation = policySource.create({ title: 'policy baseline' });
  policyTarget.mergeSnapshot(policySource.exportSnapshot());
  policyTarget.update(policyConversation.id, { tokenPolicy: 'audit-only' });
  policySource.update(policyConversation.id, { title: 'remote content edit' });
  policyTarget.mergeSnapshot(policySource.exportSnapshot());
  check('sync content updates preserve the destination-local token policy',
    policyTarget.get(policyConversation.id)?.tokenPolicy === 'audit-only');

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
    check('default ask pairing receives work sync but never implicit file transfer', defaultLink?.capabilities.includes('work-sync') === true
      && defaultLink?.capabilities.includes('file-transfer') !== true
      && server.isSyncSecret(paired.secret) === true
      && server.fileAccess(paired.secret, false) === false
      && server.sharedFileAccess(paired.secret, true) === false);
    server.config.patchDeviceLink(paired.linkId, { permissionCap: 'ask', capabilities: ['work-sync', 'file-transfer'] });
    check('explicit file capability allows bounded shared transfer but not workspace mutation at ask',
      server.sharedFileAccess(paired.secret, false) === true
      && server.sharedFileAccess(paired.secret, true) === true
      && server.fileAccess(paired.secret, false) === true
      && server.fileAccess(paired.secret, true) === false);
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
