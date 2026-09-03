import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';
import type { PluginContext } from '../../src/plugins/context.js';
import type { PluginExecutionContext, RegisterCommandOptions } from '../../src/plugins/commands.js';
import { createCalendarPlugin } from '../../src/plugins/calendar.js';
import {
  MAX_WORK_CALENDAR_STATE_BYTES,
  WorkCalendarPrivateStore,
  type WorkCalendarSaveOptions,
} from '../../src/plugins/calendar/private-store.js';
import { previewNaverRoute } from '../../src/plugins/calendar/naver-route.js';
import { VERSION } from '../../src/server/server.js';
import { extractWorkAssignmentsFromWorksheetXml, parseWorkCalendarXlsx } from '../../src/plugins/calendar/xlsx-source.js';
import { isSeoulNonWorkingDay, isSeoulWeekend, koreanPublicHolidays, seoulPublicHolidayDates } from '../../src/plugins/calendar/seoul-calendar.js';
import { trustedNmapRoute as trustedWebNmapRoute } from '../../../web/src/naver-route-link.js';
import { trustedNmapRoute as trustedMobileNmapRoute } from '../../../../apps/mobile/src/naver-route-link.js';
import {
  naverMapHttpsFallbackFromNmap,
  openTrustedNmapRouteWithHttpsFallback,
  trustedNaverMapHttpsRoute,
  trustedNmapRoute as trustedDesktopNmapRoute,
  trustedNmapRouteForAnyMode,
} from '../../../desktop/nmap-route.mjs';

const worksheet = `<?xml version="1.0" encoding="UTF-8"?>
<worksheet><sheetData>
  <row r="1"><c r="C1" t="inlineStr"><is><t>8월</t></is></c><c r="D1"/><c r="E1"/><c r="F1"/><c r="G1"/><c r="H1"/><c r="I1"/></row>
  <row r="2"><c r="C2"><v>1</v></c><c r="D2"><v>2</v></c><c r="E2"><v>3</v></c><c r="F2"><v>4</v></c><c r="G2"><v>5</v></c><c r="H2"><v>6</v></c><c r="I2"><v>7</v></c></row>
  <row r="3"><c r="A3" t="inlineStr"><is><t>team-red</t></is></c><c r="B3" t="inlineStr"><is><t>person-a</t></is></c><c r="D3"><v>0</v></c><c r="E3" t="inlineStr"><is><t>zone-7</t></is></c></row>
</sheetData><mergeCells count="1"><mergeCell ref="C1:I1"/></mergeCells></worksheet>`;

const request = { person: 'person-a', team: 'team-red', year: 2026 };
assert.deepEqual(extractWorkAssignmentsFromWorksheetXml(worksheet, request), [
  { date: '2026-08-01', kind: 'off' },
  { date: '2026-08-02', kind: 'off' },
  { date: '2026-08-03', kind: 'onsite', destinationLabel: 'zone-7' },
  { date: '2026-08-04', kind: 'off' },
  { date: '2026-08-05', kind: 'off' },
  { date: '2026-08-06', kind: 'off' },
  { date: '2026-08-07', kind: 'off' },
]);
const whitespaceDestination = worksheet.replace('zone-7', 'zone-\n\t7');
assert.equal(extractWorkAssignmentsFromWorksheetXml(whitespaceDestination, request)[2]?.destinationLabel, 'zone- 7');
const controlledDestination = worksheet.replace('zone-7', 'zone-\u0001-7');
assert.throws(() => extractWorkAssignmentsFromWorksheetXml(controlledDestination, request), /control characters/);

const duplicate = worksheet.replace('</sheetData>', '<row r="4"><c r="A4" t="inlineStr"><is><t>team-red</t></is></c><c r="B4" t="inlineStr"><is><t>person-a</t></is></c></row></sheetData>');
assert.throws(() => extractWorkAssignmentsFromWorksheetXml(duplicate, request), /not unique/);
const sparseHeader = worksheet.replace('<c r="I2"><v>7</v></c>', '');
assert.throws(() => extractWorkAssignmentsFromWorksheetXml(sparseHeader, request), /headers/);
const unrelatedTeamNote = worksheet.replace(
  '<row r="3"><c r="A3" t="inlineStr"><is><t>team-red</t></is></c><c r="B3" t="inlineStr"><is><t>person-a</t></is></c><c r="D3"><v>0</v></c><c r="E3" t="inlineStr"><is><t>zone-7</t></is></c></row>',
  '<row r="3"><c r="E3" t="inlineStr"><is><t>team-red</t></is></c></row><row r="4"><c r="A4" t="inlineStr"><is><t>team-blue</t></is></c><c r="B4" t="inlineStr"><is><t>person-a</t></is></c></row>',
);
assert.deepEqual(extractWorkAssignmentsFromWorksheetXml(unrelatedTeamNote, request), []);

const syntheticXlsx = zipSync({
  '[Content_Types].xml': new TextEncoder().encode('<Types/>'),
  'xl/workbook.xml': new TextEncoder().encode('<workbook xmlns:r="urn:relationships"><sheets><sheet name="schedule" sheetId="1" r:id="rId1"/></sheets></workbook>'),
  'xl/_rels/workbook.xml.rels': new TextEncoder().encode('<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>'),
  'xl/worksheets/sheet1.xml': new TextEncoder().encode(worksheet),
});
assert.deepEqual(await parseWorkCalendarXlsx('synthetic.xlsx', syntheticXlsx, request), [
  { date: '2026-08-01', kind: 'off' },
  { date: '2026-08-02', kind: 'off' },
  { date: '2026-08-03', kind: 'onsite', destinationLabel: 'zone-7' },
  { date: '2026-08-04', kind: 'off' },
  { date: '2026-08-05', kind: 'off' },
  { date: '2026-08-06', kind: 'off' },
  { date: '2026-08-07', kind: 'off' },
]);
const externalLinkXlsx = zipSync({
  '[Content_Types].xml': new TextEncoder().encode('<Types/>'),
  'xl/workbook.xml': new TextEncoder().encode('<workbook/>'),
  'xl/_rels/workbook.xml.rels': new TextEncoder().encode('<Relationships><Relationship Id="rId1" Target="https://invalid.test" TargetMode="External"/></Relationships>'),
});
await assert.rejects(() => parseWorkCalendarXlsx('synthetic.xlsx', externalLinkXlsx, request), /external links/);

const originalFetch = globalThis.fetch;
const mapRequests: Array<{ url: string; init?: RequestInit }> = [];
let geocodeRequest = 0;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  mapRequests.push({ url, init });
  if (url.includes('/geocode')) {
    geocodeRequest++;
    return new Response(JSON.stringify({
      status: 'OK',
      addresses: [{ x: geocodeRequest === 1 ? '127.01' : '127.02', y: geocodeRequest === 1 ? '37.51' : '37.52' }],
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  }
  return new Response(JSON.stringify({ code: 0, route: { trafast: [{ summary: { distance: 12_345, duration: 1_800_000 } }] } }), {
    status: 200, headers: { 'content-type': 'application/json' },
  });
}) as typeof fetch;
try {
  const preview = await previewNaverRoute({
    startAddress: 'synthetic-start', destinationAddress: 'synthetic-destination',
    credentials: { clientId: 'synthetic-client', clientSecret: 'synthetic-secret' },
  });
  assert.deepEqual(preview.car, { distanceM: 12_345, durationMin: 30 });
  assert(preview.links.publicTransit.startsWith('nmap://route/public?'));
  assert(preview.links.walk.startsWith('nmap://route/walk?'));
  assert(preview.links.car.startsWith('nmap://route/car?'));
  const publicRouteParams = new URL(preview.links.publicTransit).searchParams;
  assert.equal(publicRouteParams.get('sname'), '출발지');
  assert.equal(publicRouteParams.get('dname'), '목적지');
  assert.equal(mapRequests.length, 3);
  assert(mapRequests.every(({ url, init }) => new URL(url).origin === 'https://maps.apigw.ntruss.com'
    && init?.redirect === 'error' && !url.includes('synthetic-client') && !url.includes('synthetic-secret')));

  const validators = [trustedWebNmapRoute, trustedMobileNmapRoute, trustedDesktopNmapRoute];
  for (const validate of validators) {
    assert.equal(validate(preview.links.publicTransit, 'publicTransit'), preview.links.publicTransit);
    assert.equal(validate(preview.links.walk, 'walk'), preview.links.walk);
    assert.equal(validate(preview.links.car, 'car'), preview.links.car);
    assert.equal(validate(preview.links.publicTransit, 'car'), null);
  }
  assert.equal(trustedNmapRouteForAnyMode(preview.links.publicTransit), preview.links.publicTransit);

  const httpsFallbacks = [
    [preview.links.publicTransit, 'transit'],
    [preview.links.walk, 'walk'],
    [preview.links.car, 'car'],
  ] as const;
  for (const [nmapRoute, webMode] of httpsFallbacks) {
    const fallback = naverMapHttpsFallbackFromNmap(nmapRoute);
    assert(fallback);
    assert.equal(trustedNaverMapHttpsRoute(fallback), fallback);
    const fallbackUrl = new URL(fallback);
    assert.equal(fallbackUrl.origin, 'https://map.naver.com');
    assert.equal(fallbackUrl.search, '');
    assert.equal(fallbackUrl.hash, '');
    const segments = fallbackUrl.pathname.split('/');
    assert.deepEqual([segments[1], segments[2], segments[5], segments[6]], ['p', 'directions', '-', webMode]);
    const startParts = segments[3].split(',');
    const destinationParts = segments[4].split(',');
    assert.equal(decodeURIComponent(startParts[2]), '출발지');
    assert.equal(decodeURIComponent(destinationParts[2]), '목적지');
    assert.equal(startParts[3], '');
    assert.equal(destinationParts[3], '');
    assert.equal(startParts[4], 'SIMPLE_POI');
    assert.equal(destinationParts[4], 'SIMPLE_POI');
    assert(Number.isFinite(Number(startParts[0])) && Number.isFinite(Number(startParts[1])));
    assert(Number.isFinite(Number(destinationParts[0])) && Number.isFinite(Number(destinationParts[1])));
  }

  const publicFallback = naverMapHttpsFallbackFromNmap(preview.links.publicTransit);
  assert(publicFallback);
  const rejectedHttpsFallbacks = [
    publicFallback.replace('https://map.naver.com/', 'http://map.naver.com/'),
    publicFallback.replace('https://map.naver.com/', 'https://invalid.test/'),
    publicFallback.replace('https://map.naver.com/', 'https://user:pass@map.naver.com/'),
    `${publicFallback}?redirect=https%3A%2F%2Finvalid.test`,
    `${publicFallback}#fragment`,
    publicFallback.replace(encodeURIComponent('출발지'), encodeURIComponent('private-start')),
    publicFallback.replace(encodeURIComponent('목적지'), encodeURIComponent('private-destination')),
    publicFallback.replace('SIMPLE_POI', 'PLACE_POI'),
    publicFallback.replace('/-/transit', '/extra/-/transit'),
  ];
  for (const rejected of rejectedHttpsFallbacks) assert.equal(trustedNaverMapHttpsRoute(rejected), null);

  const openedWithFallback: string[] = [];
  assert.equal(await openTrustedNmapRouteWithHttpsFallback(preview.links.publicTransit, async (externalUrl) => {
    openedWithFallback.push(externalUrl);
    if (externalUrl.startsWith('nmap:')) throw new Error('synthetic missing protocol handler');
  }), true);
  assert.deepEqual(openedWithFallback, [preview.links.publicTransit, publicFallback]);

  const openedWithoutFallback: string[] = [];
  assert.equal(await openTrustedNmapRouteWithHttpsFallback(preview.links.car, async (externalUrl) => {
    openedWithoutFallback.push(externalUrl);
  }), true);
  assert.deepEqual(openedWithoutFallback, [preview.links.car]);

  const rejectedOpenAttempts: string[] = [];
  assert.equal(await openTrustedNmapRouteWithHttpsFallback(preview.links.walk, async (externalUrl) => {
    rejectedOpenAttempts.push(externalUrl);
    throw new Error('synthetic open failure');
  }), false);
  assert.equal(rejectedOpenAttempts.length, 2);

  let invalidOpenAttempted = false;
  assert.equal(await openTrustedNmapRouteWithHttpsFallback('nmap://route/public?unsafe=1', async () => {
    invalidOpenAttempted = true;
  }), false);
  assert.equal(invalidOpenAttempted, false);

  const mutatePublicLink = (mutate: (url: URL) => void): string => {
    const url = new URL(preview.links.publicTransit);
    mutate(url);
    return url.href;
  };
  const rejectedLinks = [
    `${preview.links.publicTransit}&redirect=https%3A%2F%2Finvalid.test`,
    `${preview.links.publicTransit}&appname=com.mrrobot.mobile`,
    mutatePublicLink((url) => url.searchParams.set('appname', 'com.untrusted.app')),
    mutatePublicLink((url) => url.searchParams.set('slat', '91')),
    mutatePublicLink((url) => url.searchParams.set('slng', '0x7f')),
    mutatePublicLink((url) => url.searchParams.set('sname', 'internal-start-label')),
    mutatePublicLink((url) => url.searchParams.set('dname', 'internal-destination-label')),
    mutatePublicLink((url) => url.searchParams.set('sname', 'line\nbreak')),
    mutatePublicLink((url) => url.searchParams.set('dname', 'x'.repeat(81))),
    mutatePublicLink((url) => url.searchParams.delete('dlat')),
    preview.links.publicTransit.replace('nmap://route/', 'nmap://user:pass@route/'),
    `${preview.links.publicTransit}#fragment`,
  ];
  for (const rejected of rejectedLinks) {
    for (const validate of validators) assert.equal(validate(rejected, 'publicTransit'), null);
    assert.equal(trustedNmapRouteForAnyMode(rejected), null);
  }
} finally {
  globalThis.fetch = originalFetch;
}

let directionsUnavailableGeocodes = 0;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = String(input);
  if (url.includes('/geocode')) {
    directionsUnavailableGeocodes++;
    return new Response(JSON.stringify({
      status: 'OK',
      addresses: [{ x: directionsUnavailableGeocodes === 1 ? '127.01' : '127.02', y: directionsUnavailableGeocodes === 1 ? '37.51' : '37.52' }],
    }), { status: 200 });
  }
  return new Response(JSON.stringify({ error: 'directions-not-enabled' }), { status: 403 });
}) as typeof fetch;
try {
  const preview = await previewNaverRoute({
    startAddress: 'synthetic-start', destinationAddress: 'synthetic-destination',
    credentials: { clientId: 'synthetic-client', clientSecret: 'synthetic-secret' },
  });
  assert.equal(preview.car, null);
  assert(preview.links.publicTransit.startsWith('nmap://route/public?'));
  assert(preview.links.walk.startsWith('nmap://route/walk?'));
  assert(preview.links.car.startsWith('nmap://route/car?'));
  assert.match(preview.notice, /지도 앱에서 확인/);
} finally {
  globalThis.fetch = originalFetch;
}

let cancelledDuringDirectionsGeocodes = 0;
const cancelledDuringDirections = new AbortController();
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  if (url.includes('/geocode')) {
    cancelledDuringDirectionsGeocodes++;
    return new Response(JSON.stringify({
      status: 'OK',
      addresses: [{ x: cancelledDuringDirectionsGeocodes === 1 ? '127.01' : '127.02', y: cancelledDuringDirectionsGeocodes === 1 ? '37.51' : '37.52' }],
    }), { status: 200 });
  }
  return new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => reject(new DOMException('synthetic abort', 'AbortError')), { once: true });
    cancelledDuringDirections.abort();
  });
}) as typeof fetch;
try {
  await assert.rejects(() => previewNaverRoute({
    startAddress: 'synthetic-start', destinationAddress: 'synthetic-destination',
    credentials: { clientId: 'synthetic-client', clientSecret: 'synthetic-secret' },
    signal: cancelledDuringDirections.signal,
  }), /취소/);
} finally {
  globalThis.fetch = originalFetch;
}

let oversizedResponseCancelled = false;
globalThis.fetch = (async () => new Response(new ReadableStream<Uint8Array>({
  start(controller) {
    controller.enqueue(new Uint8Array(1024 * 1024 + 1));
  },
  cancel() { oversizedResponseCancelled = true; },
}), { status: 200 })) as typeof fetch;
try {
  await assert.rejects(() => previewNaverRoute({
    startAddress: 'synthetic-start', destinationAddress: 'synthetic-destination',
    credentials: { clientId: 'synthetic-client', clientSecret: 'synthetic-secret' },
  }), /응답 크기/);
  assert.equal(oversizedResponseCancelled, true);
} finally {
  globalThis.fetch = originalFetch;
}

let cancelledFetches = 0;
globalThis.fetch = (async () => {
  cancelledFetches++;
  throw new Error('fetch must not run for an already-cancelled request');
}) as typeof fetch;
try {
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(() => previewNaverRoute({
    startAddress: 'synthetic-start', destinationAddress: 'synthetic-destination',
    credentials: { clientId: 'synthetic-client', clientSecret: 'synthetic-secret' },
    signal: cancelled.signal,
  }), /취소/);
  assert.equal(cancelledFetches, 0);
} finally {
  globalThis.fetch = originalFetch;
}

globalThis.fetch = (async (input: string | URL | Request) => {
  throw new Error(`synthetic transport error: ${String(input)}`);
}) as typeof fetch;
try {
  await assert.rejects(() => previewNaverRoute({
    startAddress: 'synthetic-private-start', destinationAddress: 'synthetic-private-destination',
    credentials: { clientId: 'synthetic-client', clientSecret: 'synthetic-secret' },
  }), (error: unknown) => {
    assert(error instanceof Error);
    assert.match(error.message, /안전하게 연결하지 못했습니다/);
    assert(!error.message.includes('synthetic-private-start'));
    assert(!error.message.includes('synthetic-private-destination'));
    return true;
  });
} finally {
  globalThis.fetch = originalFetch;
}

const holidays = koreanPublicHolidays(2026);
assert.deepEqual(holidays.map((holiday) => holiday.date), [
  '2026-01-01',
  '2026-02-16', '2026-02-17', '2026-02-18',
  '2026-03-01', '2026-03-02',
  '2026-05-01', '2026-05-05', '2026-05-24', '2026-05-25',
  '2026-06-03', '2026-06-06', '2026-07-17',
  '2026-08-15', '2026-08-17',
  '2026-09-24', '2026-09-25', '2026-09-26',
  '2026-10-03', '2026-10-05', '2026-10-09', '2026-12-25',
]);
assert(holidays.some((holiday) => holiday.date === '2026-03-01' && holiday.id === 'independence-day'));
assert(holidays.some((holiday) => holiday.date === '2026-06-03' && holiday.id === 'local-election'));
assert(holidays.some((holiday) => holiday.date === '2026-09-26' && holiday.id === 'harvest-festival'));
assert(!holidays.some((holiday) => holiday.date === '2026-09-28'));
assert(isSeoulWeekend('2026-08-01'));
assert(isSeoulNonWorkingDay('2026-03-01'));
assert(isSeoulNonWorkingDay('2026-07-14', { publicHolidayDates: ['2026-07-14'] }));
assert(seoulPublicHolidayDates(2026, { publicHolidayDates: ['2026-07-14'] }).has('2026-07-14'));

const holidays2025 = koreanPublicHolidays(2025);
assert(!holidays2025.some((holiday) => holiday.date === '2025-05-01' || holiday.id === 'labor-day'));
assert(!holidays2025.some((holiday) => holiday.date === '2025-07-17' || holiday.id === 'constitution-day'));
const holidays2027 = koreanPublicHolidays(2027);
assert(holidays2027.some((holiday) => holiday.date === '2027-05-01' && holiday.id === 'labor-day'));
assert(holidays2027.some((holiday) => holiday.date === '2027-05-03' && holiday.id === 'labor-day-substitute' && holiday.substitute));
assert(holidays2027.some((holiday) => holiday.date === '2027-07-17' && holiday.id === 'constitution-day'));
assert(holidays2027.some((holiday) => holiday.date === '2027-07-19' && holiday.id === 'constitution-day-substitute' && holiday.substitute));

const originalTimeZone = process.env.TZ;
const generatedByTimeZone = ['Asia/Seoul', 'UTC', 'America/Los_Angeles'].map((timeZone) => {
  process.env.TZ = timeZone;
  return koreanPublicHolidays(2027).map((holiday) => `${holiday.date}:${holiday.id}`);
});
if (originalTimeZone === undefined) delete process.env.TZ;
else process.env.TZ = originalTimeZone;
assert.deepEqual(generatedByTimeZone[1], generatedByTimeZone[0]);
assert.deepEqual(generatedByTimeZone[2], generatedByTimeZone[0]);

type TestCommand = {
  handler: (params: unknown, execution?: PluginExecutionContext) => unknown | Promise<unknown>;
  options: RegisterCommandOptions;
};
const commands = new Map<string, TestCommand>();
const emitted: Array<{ event: string; data: unknown }> = [];
const privateSaveOptions: WorkCalendarSaveOptions[] = [];
let protectedState: any = {
  version: 1,
  revision: 4,
  importedAt: 1_700_000_000_000,
  assignments: {
    '2026-08-15': { status: 'onsite', destinationLabel: 'synthetic-zone' },
    '2026-08-30': { status: 'onsite', destinationLabel: 'legacy-zone' },
    '2026-08-31': { status: 'onsite', destinationLabel: 'synthetic-zone' },
  },
  overrides: {},
  places: {
    'synthetic-zone': { label: 'synthetic-zone', address: 'synthetic-address', updatedAt: 1_700_000_000_000 },
    'legacy-zone': { label: 'legacy-zone', address: 'legacy-address', updatedAt: 1_700_000_000_000 },
  },
  profile: { naverConsent: false },
};
const plugin = createCalendarPlugin({
  privateStore: {
    load: () => protectedState,
    save: (value, options) => {
      privateSaveOptions.push({ ...options });
      protectedState = structuredClone(value);
    },
  },
});
await plugin.activate?.({
  pluginId: 'calendar',
  storage: { get: () => undefined, set: () => undefined },
  registerCommand: (name, handler, options = {}) => { commands.set(name, { handler, options }); },
  emit: (event, data) => { emitted.push({ event, data }); },
} as unknown as PluginContext);

const execution = (permissionMode: PluginExecutionContext['permissionMode'], capabilities: string[] = [], isAdmin = false): PluginExecutionContext => ({
  permissionMode,
  deviceCapabilities: capabilities,
  isAdmin,
  destructiveApproved: isAdmin || permissionMode === 'full',
  approvalSource: 'policy',
});
const call = async (name: string, params: unknown, context: PluginExecutionContext): Promise<any> => {
  const command = commands.get(name);
  assert(command, `missing test command ${name}`);
  return command.handler(params, context);
};

const publicStatus = await call('calendar.status', {}, execution('read-only'));
assert(!('workCalendar' in publicStatus));
await assert.rejects(() => call('calendar.work.month', { year: 2026, month: 8 }, execution('read-only')), /보기 권한/);
await assert.rejects(() => call('calendar.work.route.preview', { date: '2026-08-31' }, execution('read-only', ['private-calendar'])), /동의/);
const viewOnlyMonth = await call('calendar.work.month', { year: 2026, month: 8 }, execution('read-only', ['private-calendar']));
assert.equal(viewOnlyMonth.access.canEdit, false);
const editableMonth = await call('calendar.work.month', { year: 2026, month: 8 }, execution('ask', ['private-calendar']));
assert.equal(editableMonth.access.canEdit, true);
assert.equal(editableMonth.days.length, 31);
assert.equal(editableMonth.days.find((day: any) => day.date === '2026-08-31')?.source, 'excel');
await assert.rejects(
  () => call('calendar.work.override.set', { date: '2026-08-15', status: 'onsite', destinationLabel: 'manual-zone' }, execution('read-only', ['private-calendar'])),
  /읽기 전용/,
);
await call('calendar.work.override.set', {
  date: '2026-08-15', status: 'onsite', destinationLabel: 'manual-zone', destinationAddress: 'manual-address',
}, execution('ask', ['private-calendar']));
assert.equal(protectedState.places['manual-zone']?.address, 'manual-address');
const overriddenHoliday = await call('calendar.work.month', { year: 2026, month: 8 }, execution('ask', ['private-calendar']));
assert.equal(overriddenHoliday.days.find((day: any) => day.date === '2026-08-15')?.source, 'manual');
await call('calendar.work.override.remove', { date: '2026-08-15' }, execution('ask', ['private-calendar']));
assert.equal(protectedState.places['manual-zone'], undefined);
assert.equal(protectedState.places['synthetic-zone']?.address, 'synthetic-address');
const restoredHoliday = await call('calendar.work.month', { year: 2026, month: 8 }, execution('ask', ['private-calendar']));
assert.equal(restoredHoliday.days.find((day: any) => day.date === '2026-08-15')?.source, 'holiday');
assert.equal(restoredHoliday.days.find((day: any) => day.date === '2026-08-15')?.status, 'off');
await call('calendar.work.settings.set', {
  homeAddress: 'synthetic-home', naverClientId: 'synthetic-id', naverClientSecret: 'synthetic-secret', naverConsent: true,
}, execution('full', [], true));
const clearedSettings = await call('calendar.work.settings.set', { clearNaverCredentials: true }, execution('full', [], true));
assert.equal(clearedSettings.naverClientIdSet, false);
assert.equal(clearedSettings.naverClientSecretSet, false);
assert.equal(clearedSettings.naverConsent, false);
assert.equal(protectedState.profile.naverClientId, undefined);
assert.equal(protectedState.profile.naverClientSecret, undefined);
const importTestDirectory = mkdtempSync(join(tmpdir(), 'mr-robot-work-calendar-import-test-'));
try {
  const missingPrivateWorkbook = join(importTestDirectory, 'private-source-marker.xlsx');
  await assert.rejects(
    () => call('calendar.work.import', {
      path: missingPrivateWorkbook, person: request.person, team: request.team, year: request.year,
    }, execution('full', [], true)),
    (error: unknown) => {
      assert(error instanceof Error);
      assert.equal(error.message, '엑셀 근무표를 안전하게 가져오지 못했습니다. 파일 형식과 식별값을 확인해 주세요.');
      assert(!error.message.includes(missingPrivateWorkbook));
      assert(!error.message.includes('private-source-marker'));
      return true;
    },
  );
  const privateDirectoryWithWorkbookExtension = join(importTestDirectory, 'private-open-marker.xlsx');
  mkdirSync(privateDirectoryWithWorkbookExtension);
  await assert.rejects(
    () => call('calendar.work.import', {
      path: privateDirectoryWithWorkbookExtension, person: request.person, team: request.team, year: request.year,
    }, execution('full', [], true)),
    (error: unknown) => {
      assert(error instanceof Error);
      assert(!error.message.includes(privateDirectoryWithWorkbookExtension));
      assert(!error.message.includes('private-open-marker'));
      return true;
    },
  );
  const syntheticWorkbook = join(importTestDirectory, 'synthetic.xlsx');
  writeFileSync(syntheticWorkbook, syntheticXlsx);
  const originalWorkbook = readFileSync(syntheticWorkbook);
  await call('calendar.work.import', {
    path: syntheticWorkbook, person: request.person, team: request.team, year: request.year,
  }, execution('full', [], true));
  assert.deepEqual(readFileSync(syntheticWorkbook), originalWorkbook);
  assert.deepEqual(Object.keys(protectedState.places), []);
} finally {
  rmSync(importTestDirectory, { recursive: true, force: true });
}
assert(privateSaveOptions.length >= 5);
assert(privateSaveOptions.every((options) => options.purgePrevious === true));
assert([...commands.entries()].filter(([name]) => name.startsWith('calendar.work.')).every(([, command]) => command.options.tool !== true));
assert(emitted.every(({ event, data }) => event !== 'calendar.work.changed'
  || (!JSON.stringify(data).includes('synthetic-zone') && !JSON.stringify(data).includes('synthetic-address'))));

if (process.platform === 'win32') {
  const privateTestDirectory = mkdtempSync(join(tmpdir(), 'mr-robot-work-calendar-test-'));
  const protectedFile = join(privateTestDirectory, 'state.bin');
  try {
    const privateStore = new WorkCalendarPrivateStore<{ marker: string; revision: number }>(protectedFile);
    const first = { marker: '합성-개인-근무지-주소', revision: 1 };
    const second = { marker: '합성-변경-근무지-주소', revision: 2 };
    privateStore.save(first);
    assert(readFileSync(protectedFile, 'utf8').startsWith('dpapi:work-calendar:v1:'));
    assert(!readFileSync(protectedFile, 'utf8').includes(first.marker));
    assert.deepEqual(privateStore.load(), first);
    privateStore.save(second);
    assert.deepEqual(privateStore.load(), second);
    assert(existsSync(`${protectedFile}.previous`));
    writeFileSync(protectedFile, 'corrupt-test-ciphertext', 'utf8');
    assert.deepEqual(privateStore.load(), first);

    const purgedProtectedFile = join(privateTestDirectory, 'purged-state.bin');
    const purgedStore = new WorkCalendarPrivateStore<{ marker: string; revision: number }>(purgedProtectedFile);
    const superseded = { marker: '합성-폐기할-비밀-집-주소', revision: 1 };
    const sanitized = { marker: '합성-최신-한글-상태', revision: 2 };
    purgedStore.save(superseded);
    purgedStore.save(sanitized, { purgePrevious: true });
    const purgedPrimaryCiphertext = readFileSync(purgedProtectedFile, 'utf8');
    const purgedPreviousCiphertext = readFileSync(`${purgedProtectedFile}.previous`, 'utf8');
    for (const ciphertext of [purgedPrimaryCiphertext, purgedPreviousCiphertext]) {
      assert(ciphertext.startsWith('dpapi:work-calendar:v1:'));
      assert(!ciphertext.includes(superseded.marker));
      assert(!ciphertext.includes(sanitized.marker));
    }
    assert.deepEqual(purgedStore.load(), sanitized);
    const purgedRecoveryStore = new WorkCalendarPrivateStore<{ marker: string; revision: number }>(`${purgedProtectedFile}.previous`);
    assert.deepEqual(purgedRecoveryStore.load(), sanitized);
    writeFileSync(purgedProtectedFile, 'corrupt-test-ciphertext', 'utf8');
    assert.deepEqual(purgedStore.load(), sanitized);

    const largeProtectedFile = join(privateTestDirectory, 'large-state.bin');
    const largeStore = new WorkCalendarPrivateStore<{ marker: string }>(largeProtectedFile);
    const emptyPayloadBytes = Buffer.byteLength(JSON.stringify({ marker: '' }), 'utf8');
    const maximumKoreanCharacters = Math.floor((MAX_WORK_CALENDAR_STATE_BYTES - emptyPayloadBytes) / Buffer.byteLength('한', 'utf8'));
    const maximumState = { marker: '한'.repeat(maximumKoreanCharacters) };
    const maximumStateBytes = Buffer.byteLength(JSON.stringify(maximumState), 'utf8');
    assert(maximumStateBytes <= MAX_WORK_CALENDAR_STATE_BYTES);
    assert(MAX_WORK_CALENDAR_STATE_BYTES - maximumStateBytes < Buffer.byteLength('한', 'utf8'));
    largeStore.save(maximumState, { purgePrevious: true });
    assert.deepEqual(largeStore.load(), maximumState);
    const maximumCiphertext = readFileSync(largeProtectedFile);
    const maximumPreviousCiphertext = readFileSync(`${largeProtectedFile}.previous`);
    assert.throws(
      () => largeStore.save({ marker: `${maximumState.marker}한` }, { purgePrevious: true }),
      /protected storage limit/,
    );
    assert.deepEqual(readFileSync(largeProtectedFile), maximumCiphertext);
    assert.deepEqual(readFileSync(`${largeProtectedFile}.previous`), maximumPreviousCiphertext);
  } finally {
    rmSync(privateTestDirectory, { recursive: true, force: true });
  }
}

const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url));
for (const relative of ['package.json', 'packages/agent/package.json', 'packages/desktop/package.json', 'packages/shared/package.json', 'packages/web/package.json']) {
  const manifest = JSON.parse(readFileSync(join(repositoryRoot, relative), 'utf8')) as { version?: string };
  assert.equal(manifest.version, '0.4.2', `${relative} version must match the 0.4.2 desktop release`);
}
const mobileManifest = JSON.parse(readFileSync(join(repositoryRoot, 'apps/mobile/package.json'), 'utf8')) as { version?: string };
assert.equal(mobileManifest.version, '0.4.0', 'Android remains on the verified 0.4.0 release');
const mobileApp = JSON.parse(readFileSync(join(repositoryRoot, 'apps/mobile/app.json'), 'utf8')) as { expo?: { version?: string; android?: { versionCode?: number } } };
assert.equal(mobileApp.expo?.version, '0.4.0');
assert.equal(mobileApp.expo?.android?.versionCode, 15);
assert.equal(VERSION, '0.4.2');
assert.equal(plugin.manifest.version, '0.3.7');

console.log('calendar source tests passed');
