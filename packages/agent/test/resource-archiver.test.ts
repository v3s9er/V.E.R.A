import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { unzipSync } from 'fflate';
import { archiveWebResources, previewResourceArchive, RequestPacer, validateResourceArchiveRequest } from '../src/plugins/resource-archiver/archive.js';
import { MAX_REWRITE_BYTES, discoverReferences, rewriteResourceLinks } from '../src/plugins/resource-archiver/extract.js';
import { SingleArchiveGate } from '../src/plugins/resource-archiver/index.js';
import {
  isPublicAddress,
  redactUrl,
  reserveNetworkRequest,
  resolvePublicTarget,
  resolvePublicTargetCached,
  resolveThenPaceRequest,
  validateRedirectTarget,
  type SharedRequestBudget,
} from '../src/plugins/resource-archiver/security.js';

assert.equal(isPublicAddress('127.0.0.1'), false);
assert.equal(isPublicAddress('10.2.3.4'), false);
assert.equal(isPublicAddress('169.254.169.254'), false);
assert.equal(isPublicAddress('192.0.2.2'), false);
assert.equal(isPublicAddress('192.88.99.2'), false);
assert.equal(isPublicAddress('8.8.8.8'), true);
assert.equal(isPublicAddress('::1'), false);
assert.equal(isPublicAddress('fc00::1234'), false);
assert.equal(isPublicAddress('fec0::1234'), false);
assert.equal(isPublicAddress('100:0:0:1::1234'), false);
assert.equal(isPublicAddress('3fff::1234'), false);
assert.equal(isPublicAddress('5f00::1234'), false);
assert.equal(isPublicAddress('4000::1'), false);
assert.equal(isPublicAddress('2001:5::1'), false);
assert.equal(isPublicAddress('2001:100::1'), false);
assert.equal(isPublicAddress('2001:1::4'), false);
assert.equal(isPublicAddress('2606:4700:4700::1111'), true);
const redactedQuery = redactUrl('https://example.com/path?apiKey=one&accessToken=two&authToken=three&sessionId=four&passwordHash=five&ordinary=six');
assert.doesNotMatch(redactedQuery, /one|two|three|four|five|six/);
assert.equal([...new URL(redactedQuery).searchParams.values()].every((value) => value === '[REDACTED]'), true);
assert.throws(() => validateRedirectTarget(new URL('https://example.com/a'), 'http://example.com/b'), /내려가는 리디렉션/);
assert.equal(validateRedirectTarget(new URL('https://example.com/a'), '/b').href, 'https://example.com/b');

await assert.rejects(
  resolvePublicTarget(new URL('https://example.test/a'), { pageHost: 'example.test', allowedCrossOriginHosts: new Set() }, async () => [
    { address: '93.184.216.34', family: 4 as const },
    { address: '127.0.0.1', family: 4 as const },
  ] as never),
  /섞인 DNS/,
);
await assert.rejects(
  resolvePublicTarget(new URL('https://cdn.example.test/a'), { pageHost: 'example.test', allowedCrossOriginHosts: new Set() }, async () => [
    { address: '93.184.216.34', family: 4 as const },
  ] as never),
  /허용 목록/,
);
let cachedLookupCount = 0;
const pinCache = new Map();
const fakePublicResolver = (async () => {
  cachedLookupCount += 1;
  return [{ address: '93.184.216.34', family: 4 as const }];
}) as never;
await resolvePublicTargetCached(new URL('https://example.test/a'), { pageHost: 'example.test', allowedCrossOriginHosts: new Set() }, pinCache, fakePublicResolver);
await resolvePublicTargetCached(new URL('https://example.test/b'), { pageHost: 'example.test', allowedCrossOriginHosts: new Set() }, pinCache, fakePublicResolver);
assert.equal(cachedLookupCount, 1);
const stalledLookupAbort = new AbortController();
const stalledLookup = resolvePublicTargetCached(
  new URL('https://stalled.example.test/a'),
  { pageHost: 'stalled.example.test', allowedCrossOriginHosts: new Set() },
  new Map(),
  (() => new Promise(() => undefined)) as never,
  stalledLookupAbort.signal,
);
stalledLookupAbort.abort(new Error('dns-deadline'));
await assert.rejects(stalledLookup, /dns-deadline/);
let releaseSlowDns!: () => void;
const slowDns = new Promise<string>((resolve) => { releaseSlowDns = () => resolve('validated-pin'); });
const postDnsPacer = new RequestPacer(100);
const physicalStarts: number[] = [];
const pacedAfterDns = Array.from({ length: 3 }, async () => {
  await resolveThenPaceRequest(() => slowDns, () => postDnsPacer.wait());
  physicalStarts.push(Date.now());
});
releaseSlowDns();
await Promise.all(pacedAfterDns);
assert.ok(
  physicalStarts[1] - physicalStarts[0] >= 85 && physicalStarts[2] - physicalStarts[1] >= 85,
  `post-DNS physical starts were not paced: ${physicalStarts.join(',')}`,
);

const hardRequestBudget: SharedRequestBudget = { limit: 2, used: 0, reserved: 0 };
const firstPermit = reserveNetworkRequest(hardRequestBudget);
const secondPermit = reserveNetworkRequest(hardRequestBudget);
assert.throws(() => reserveNetworkRequest(hardRequestBudget), /2회 한도/);
firstPermit.commit();
secondPermit.release();
reserveNetworkRequest(hardRequestBudget).commit();
assert.equal(hardRequestBudget.used, 2);
assert.throws(() => reserveNetworkRequest(hardRequestBudget), /2회 한도/);

assert.throws(() => validateResourceArchiveRequest({ pageUrl: 'https://example.com' }), /허가/);
assert.throws(() => validateResourceArchiveRequest({ authorizationConfirmed: true, pageUrl: 'https://user:pass@example.com/' }), /사용자 이름/);
assert.throws(() => validateResourceArchiveRequest({ authorizationConfirmed: true, pageUrl: 'https://example.com/', allowedCrossOriginHosts: ['*.example.com'] }), /올바르지/);
assert.equal(validateResourceArchiveRequest({ authorizationConfirmed: true, pageUrl: 'https://example.com/' }).limits.maxResources, 200);
assert.equal(validateResourceArchiveRequest({ authorizationConfirmed: true, pageUrl: 'https://example.com/' }).limits.maxNetworkRequests, 40);
assert.equal(validateResourceArchiveRequest({ authorizationConfirmed: true, pageUrl: 'https://example.com/', limits: { maxNetworkRequests: 0 } }).limits.maxNetworkRequests, 0);
assert.equal(validateResourceArchiveRequest({ authorizationConfirmed: true, pageUrl: 'https://example.com/' }).fetchMissing, false);
assert.equal(validateResourceArchiveRequest({ authorizationConfirmed: true, pageUrl: 'https://example.com/' }).limits.retries, 0);
assert.equal(validateResourceArchiveRequest({ authorizationConfirmed: true, pageUrl: 'https://example.com/' }).limits.minRequestIntervalMs, 150);
assert.equal(validateResourceArchiveRequest({ authorizationConfirmed: true, pageUrl: 'https://example.com/' }).limits.overallTimeoutMs, 60_000);
assert.throws(() => validateResourceArchiveRequest({ authorizationConfirmed: true, pageUrl: 'https://example.com/', limits: { minRequestIntervalMs: 99 } }), /100~2000/);
assert.throws(() => validateResourceArchiveRequest({ authorizationConfirmed: true, pageUrl: 'https://example.com/', limits: { maxNetworkRequests: 501 } }), /0~500/);
assert.throws(() => validateResourceArchiveRequest({ authorizationConfirmed: true, pageUrl: 'https://example.com/', limits: { overallTimeoutMs: 300_001 } }), /1000~300000/);
const dryRun = previewResourceArchive({
  authorizationConfirmed: true,
  pageUrl: 'https://example.com/',
  capturedResources: [{ url: 'https://example.com/', mimeType: 'text/html', bodyText: '<img src="/missing.png">' }],
});
assert.equal(dryRun.dryRun, true);
assert.equal(dryRun.networkOptIn, false);
assert.equal(dryRun.discoveredReferences, 1);
assert.equal(dryRun.estimatedNetworkRequests, 0);
assert.equal(dryRun.networkRequestLimit, 40);
assert.equal(dryRun.trafficProfile.directFetch, 'off-by-default');
assert.equal(dryRun.trafficProfile.minRequestIntervalMs, 150);
assert.equal(dryRun.trafficProfile.retries, 0);
assert.equal(dryRun.trafficProfile.requestsUsed, 0);
assert.equal(dryRun.trafficProfile.overallTimeoutMs, 60_000);
assert.match(dryRun.warnings[0], /꺼져/);
const pacer = new RequestPacer(100);
const starts: number[] = [];
await Promise.all(Array.from({ length: 3 }, async () => {
  await pacer.wait();
  starts.push(Date.now());
}));
assert.ok(starts[1] - starts[0] >= 85 && starts[2] - starts[1] >= 85, `request starts were not paced: ${starts.join(',')}`);
const singleFlight = new SingleArchiveGate();
let releaseFirst!: () => void;
const firstRun = singleFlight.run(() => new Promise<void>((resolve) => { releaseFirst = resolve; }));
await assert.rejects(singleFlight.run(async () => undefined), /이미 실행 중/);
releaseFirst();
await firstRun;
assert.equal(await singleFlight.run(async () => 'available-again'), 'available-again');

const sourceHtml = Buffer.from(`<!doctype html><html><head><base href="https://example.com/root/"><link rel="stylesheet" href="../assets/site.css"></head><body><img srcset="../img/a.png 1x, ../img/b.png 2x"><a href="/not-a-resource">nav</a><style>.x{background:url('../img/a.png')}</style></body></html>`);
const discovered = discoverReferences(sourceHtml, 'text/html', 'https://example.com/page.html', 10);
assert.deepEqual(new Set(discovered), new Set([
  'https://example.com/assets/site.css',
  'https://example.com/img/a.png',
  'https://example.com/img/b.png',
]));
const rewritten = rewriteResourceLinks(
  sourceHtml,
  'text/html',
  'https://example.com/page.html',
  'resources/example.com/page.html',
  new Map([
    ['https://example.com/assets/site.css', 'resources/example.com/assets/site.css'],
    ['https://example.com/img/a.png', 'resources/example.com/img/a.png'],
    ['https://example.com/img/b.png', 'resources/example.com/img/b.png'],
  ]),
  1024 * 1024,
).toString();
assert.match(rewritten, /<base href="\.\/">/);
assert.match(rewritten, /href="assets\/site\.css"/);
assert.match(rewritten, /srcset="img\/a\.png 1x, img\/b\.png 2x"/);
assert.match(rewritten, /href="\/not-a-resource"/);
assert.throws(
  () => rewriteResourceLinks(
    Buffer.alloc(MAX_REWRITE_BYTES + 1, 0x61),
    'text/html',
    'https://example.com/large.html',
    'resources/example.com/large.html',
    new Map(),
    MAX_REWRITE_BYTES + 1,
  ),
  /재작성 처리 한도/,
);

const referenceFlood = Buffer.from(Array.from({ length: 10_000 }, (_, index) => `<img src="/asset-${index}.png">`).join(''));
const boundedFlood = discoverReferences(referenceFlood, 'text/html', 'https://example.com/', 7);
assert.equal(boundedFlood.length, 7);

const workspace = await mkdtemp(join(tmpdir(), 'mr-robot-resource-archive-'));
try {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const result = await archiveWebResources({
    authorizationConfirmed: true,
    pageUrl: 'https://example.com/private?token=top-secret',
    outputPath: 'archives/site.zip',
    fetchMissing: false,
    capturedResources: [
      {
        url: 'https://example.com/private?token=top-secret',
        status: 200,
        mimeType: 'text/html',
        bodyText: '<!doctype html><link rel="stylesheet" href="/assets/site.css"><img src="/img/a.png?sig=hide">',
        responseHeaders: { 'Content-Type': 'text/html', 'Set-Cookie': 'secret=yes', Authorization: 'Bearer no' },
      },
      { url: 'https://example.com/assets/site.css', status: 200, mimeType: 'text/css', bodyText: 'body{background:url("../img/a.png?sig=hide")}' },
      { url: 'https://example.com/img/a.png?sig=hide', status: 200, mimeType: 'image/png', bodyBase64: png.toString('base64') },
      { url: 'https://example.com/img/b.png', status: 200, mimeType: 'image/png', bodyBase64: png.toString('base64') },
    ],
  }, {
    permissionMode: 'workspace',
    workspaceRoot: workspace,
    destructiveApproved: true,
    approvalSource: 'prompt',
  });

  assert.equal(result.manifest.saved, 4);
  assert.equal(result.manifest.deduplicated, 1);
  assert.equal(result.manifest.networkRequestsUsed, 0);
  assert.equal(result.trafficProfile.requestsUsed, 0);
  assert.equal(result.trafficProfile.networkRequestLimit, 40);
  assert.equal(result.failures.length, 0);
  const zip = unzipSync(await readFile(result.outputPath));
  const originalZipBytes = await readFile(result.outputPath);
  assert.ok(zip['mr-robot-manifest.json']);
  assert.ok(zip['SHA256SUMS.txt']);
  const manifestText = Buffer.from(zip['mr-robot-manifest.json']).toString('utf8');
  assert.doesNotMatch(manifestText, /top-secret|sig=hide|Set-Cookie|Bearer no/i);
  const manifest = JSON.parse(manifestText) as {
    resources: Array<{ url: string; archivePath: string; duplicateOf?: string; headers?: Record<string, string> }>;
    graph: Array<{ from: string; to: string }>;
  };
  assert.equal(manifest.graph.length, 3);
  assert.equal(manifest.resources.filter((entry) => entry.duplicateOf).length, 1);
  assert.equal(manifest.resources.find((entry) => entry.url.includes('/private'))?.headers?.['content-type'], 'text/html');
  const htmlEntry = manifest.resources.find((entry) => entry.url.includes('/private'))!;
  const archivedHtml = Buffer.from(zip[htmlEntry.archivePath]).toString('utf8');
  assert.match(archivedHtml, /href="assets\/site\.css"/);
  assert.doesNotMatch(archivedHtml, /href="https:\/\//);

  await assert.rejects(
    archiveWebResources({
      authorizationConfirmed: true,
      pageUrl: 'https://example.com/',
      outputPath: 'archives/site.zip',
      fetchMissing: false,
      capturedResources: [{ url: 'https://example.com/', mimeType: 'text/html', bodyText: 'must not replace prior archive' }],
    }, { permissionMode: 'workspace', workspaceRoot: workspace, destructiveApproved: true, approvalSource: 'prompt' }),
    /덮어쓰지/,
  );
  assert.deepEqual(await readFile(result.outputPath), originalZipBytes);

  const floodResult = await archiveWebResources({
    authorizationConfirmed: true,
    pageUrl: 'https://example.com/flood.html',
    outputPath: 'archives/flood.zip',
    fetchMissing: false,
    capturedResources: [{ url: 'https://example.com/flood.html', mimeType: 'text/html', bodyBase64: referenceFlood.toString('base64') }],
    limits: { maxResources: 8, maxResourceBytes: 512 * 1024, maxTotalBytes: 2 * 1024 * 1024 },
  }, { permissionMode: 'workspace', workspaceRoot: workspace, destructiveApproved: true, approvalSource: 'prompt' });
  const floodZip = unzipSync(await readFile(floodResult.outputPath));
  const floodManifest = JSON.parse(Buffer.from(floodZip['mr-robot-manifest.json']).toString('utf8')) as { graph: unknown[] };
  assert.ok(floodManifest.graph.length <= 8);

  const expansionHtml = '<img src="/x">'.repeat(100);
  const expansionPageUrl = `https://example.com/${Array.from({ length: 16 }, (_, index) => `deep-${index}`).join('/')}/expand.html`;
  const expansionResult = await archiveWebResources({
    authorizationConfirmed: true,
    pageUrl: expansionPageUrl,
    outputPath: 'archives/expansion.zip',
    fetchMissing: false,
    capturedResources: [
      { url: expansionPageUrl, mimeType: 'text/html', bodyText: expansionHtml },
      { url: 'https://example.com/x', mimeType: 'application/octet-stream', bodyText: 'x' },
    ],
    limits: { maxResources: 4, maxResourceBytes: 2_048, maxTotalBytes: 64 * 1024 },
  }, { permissionMode: 'workspace', workspaceRoot: workspace, destructiveApproved: true, approvalSource: 'prompt' });
  assert.ok(expansionResult.failures.some((failure) => failure.stage === 'rewrite' && /크기 한도/.test(failure.reason)));
  const expansionZip = unzipSync(await readFile(expansionResult.outputPath));
  const expansionManifest = JSON.parse(Buffer.from(expansionZip['mr-robot-manifest.json']).toString('utf8')) as { resources: Array<{ url: string; archivePath: string }> };
  const expansionPage = expansionManifest.resources.find((entry) => entry.url.includes('/expand.html'))!;
  assert.equal(Buffer.from(expansionZip[expansionPage.archivePath]).toString('utf8'), expansionHtml);

  const writeAbort = new AbortController();
  const abortedOutput = join(workspace, 'archives', 'write-aborted.zip');
  await assert.rejects(
    archiveWebResources({
      authorizationConfirmed: true,
      pageUrl: 'https://example.com/write-aborted.html',
      outputPath: 'archives/write-aborted.zip',
      capturedResources: [{ url: 'https://example.com/write-aborted.html', mimeType: 'text/html', bodyText: 'ok' }],
    }, { permissionMode: 'workspace', workspaceRoot: workspace, destructiveApproved: true, approvalSource: 'prompt', signal: writeAbort.signal }, (progress) => {
      if (progress.phase === 'writing' && progress.completed === 0) writeAbort.abort(new Error('write-deadline'));
    }),
    /write-deadline/,
  );
  await assert.rejects(access(abortedOutput));

  const packingAbort = new AbortController();
  const packingAbortedOutput = join(workspace, 'archives', 'packing-aborted.zip');
  await assert.rejects(
    archiveWebResources({
      authorizationConfirmed: true,
      pageUrl: 'https://example.com/packing-aborted.bin',
      outputPath: 'archives/packing-aborted.zip',
      rewriteOfflineLinks: false,
      capturedResources: [{
        url: 'https://example.com/packing-aborted.bin',
        mimeType: 'application/octet-stream',
        bodyBase64: Buffer.alloc(256 * 1024, 0x61).toString('base64'),
      }],
    }, { permissionMode: 'workspace', workspaceRoot: workspace, destructiveApproved: true, approvalSource: 'prompt', signal: packingAbort.signal }, (progress) => {
      if (progress.phase === 'packing' && progress.completed === 0) {
        queueMicrotask(() => packingAbort.abort(new Error('packing-deadline')));
      }
    }),
    /packing-deadline/,
  );
  await assert.rejects(access(packingAbortedOutput));

  await assert.rejects(
    archiveWebResources({
      authorizationConfirmed: true,
      pageUrl: 'https://example.com/',
      outputPath: 'archives/read-only.zip',
      capturedResources: [{ url: 'https://example.com/', mimeType: 'text/html', bodyText: 'ok' }],
    }, { permissionMode: 'read-only', workspaceRoot: workspace, destructiveApproved: true, approvalSource: 'prompt' }),
    /읽기 전용/,
  );

  const cancelled = new AbortController();
  cancelled.abort(new Error('caller-cancelled'));
  await assert.rejects(
    archiveWebResources({
      authorizationConfirmed: true,
      pageUrl: 'https://example.com/',
      outputPath: 'archives/cancelled.zip',
      capturedResources: [{ url: 'https://example.com/', mimeType: 'text/html', bodyText: 'ok' }],
    }, { permissionMode: 'workspace', workspaceRoot: workspace, destructiveApproved: true, approvalSource: 'prompt', signal: cancelled.signal }),
    /caller-cancelled/,
  );

  for (const invalidOutputPath of [
    'archives/site.zip:stream',
    'archives/CON.zip',
    'archives/COM¹.zip',
    'archives/LPT².zip',
    'archives/CONIN$.zip',
    'archives/CONOUT$.zip',
    `archives/bad${String.fromCharCode(1)}.zip`,
  ]) {
    await assert.rejects(
      archiveWebResources({
        authorizationConfirmed: true,
        pageUrl: 'https://example.com/',
        outputPath: invalidOutputPath,
        capturedResources: [{ url: 'https://example.com/', mimeType: 'text/html', bodyText: 'ok' }],
      }, { permissionMode: 'workspace', workspaceRoot: workspace, destructiveApproved: true, approvalSource: 'prompt' }),
      /NTFS ADS|예약 장치/,
    );
  }

  await assert.rejects(
    archiveWebResources({
      authorizationConfirmed: true,
      pageUrl: 'https://example.com/',
      outputPath: '../escape.zip',
      fetchMissing: false,
      capturedResources: [{ url: 'https://example.com/', mimeType: 'text/html', bodyText: 'ok' }],
    }, { permissionMode: 'workspace', workspaceRoot: workspace, destructiveApproved: true, approvalSource: 'prompt' }),
    /밖의 경로/,
  );
  await assert.rejects(
    archiveWebResources({
      authorizationConfirmed: true,
      pageUrl: 'http://127.0.0.1/',
      fetchMissing: true,
      limits: { retries: 0 },
    }, { permissionMode: 'workspace', workspaceRoot: workspace, destructiveApproved: true, approvalSource: 'prompt' }),
    /사설·예약 주소/,
  );
} finally {
  await rm(workspace, { recursive: true, force: true });
}

console.log('resource archiver tests passed');
