import { randomUUID } from 'node:crypto';
import { basename, extname } from 'node:path';
import { closeSync, fstatSync, openSync, readSync, realpathSync } from 'node:fs';
import type { CalendarEvent } from '@mr-robot/shared';
import type { MrRobotPlugin } from './loader.js';
import type { PluginContext } from './context.js';
import type { PluginExecutionContext } from './commands.js';
import { WorkCalendarPrivateStore, type WorkCalendarSaveOptions } from './calendar/private-store.js';
import { parseWorkCalendarXlsx } from './calendar/xlsx-source.js';
import { isSeoulWeekend, koreanPublicHolidays, type KoreanHoliday } from './calendar/seoul-calendar.js';
import { previewNaverRoute } from './calendar/naver-route.js';

type WorkStatus = 'onsite' | 'remote' | 'off' | 'unknown';
type WorkSource = 'excel' | 'manual' | 'holiday' | 'none';

interface ImportedAssignment {
  status: 'onsite' | 'off';
  destinationLabel?: string;
}

interface WorkOverride {
  status: WorkStatus;
  destinationLabel?: string;
  destinationAddress?: string;
  updatedAt: number;
}

interface PrivatePlace {
  label: string;
  address: string;
  updatedAt: number;
}

interface WorkCalendarState {
  version: 1;
  revision: number;
  importedAt?: number;
  assignments: Record<string, ImportedAssignment>;
  overrides: Record<string, WorkOverride>;
  places: Record<string, PrivatePlace>;
  profile: {
    homeAddress?: string;
    naverClientId?: string;
    naverClientSecret?: string;
    naverConsent: boolean;
  };
}

interface WorkCalendarStore {
  load(): WorkCalendarState | undefined;
  save(value: WorkCalendarState, options?: WorkCalendarSaveOptions): void;
}

interface WorkStateChange extends WorkCalendarSaveOptions {
  from?: string;
  to?: string;
  purgePrevious: true;
}

interface WorkDayView {
  date: string;
  status: WorkStatus;
  destinationLabel?: string;
  destinationAddress?: string;
  source: WorkSource;
  overridden: boolean;
  holidayName?: string;
}

const MAX_WORKBOOK_BYTES = 25 * 1024 * 1024;
const MAX_ASSIGNMENTS = 6_000;
const SAFE_IMPORT_MESSAGES = new Set([
  '매크로 없는 .xlsx 파일만 가져올 수 있습니다.',
  '가져올 파일은 25MB 이하의 .xlsx 통합 문서여야 합니다.',
  '가져오는 동안 엑셀 파일 크기가 변경되었습니다. 다시 시도해 주세요.',
  '지정한 행과 날짜 머리글을 가진 근무 일정을 찾지 못했습니다.',
  '가져온 근무 일정이 안전 한도를 넘었습니다.',
]);

function emptyWorkState(): WorkCalendarState {
  return { version: 1, revision: 0, assignments: {}, overrides: {}, places: {}, profile: { naverConsent: false } };
}

function events(ctx: PluginContext): CalendarEvent[] {
  return ctx.storage.get<CalendarEvent[]>('events') ?? [];
}

function validDate(value: unknown, label: string): string {
  const text = String(value ?? '');
  if (!text || Number.isNaN(new Date(text).getTime())) throw new Error(`${label} 시간이 올바르지 않습니다.`);
  return text;
}

function assertPrivateCalendar(execution?: PluginExecutionContext): void {
  if (execution?.isAdmin === true || execution?.deviceCapabilities?.includes('private-calendar')) return;
  throw new Error('이 기기에는 개인 근무 캘린더 보기 권한이 없습니다. PC의 연결 기기 설정에서 따로 허용해 주세요.');
}

function assertPrivateCalendarEdit(execution?: PluginExecutionContext): void {
  assertPrivateCalendar(execution);
  if (execution?.isAdmin !== true && execution?.permissionMode === 'read-only') {
    throw new Error('이 기기는 개인 근무 캘린더 읽기 전용입니다. PC에서 기기 권한을 변경해 주세요.');
  }
}

function assertPrivateCalendarAdmin(execution?: PluginExecutionContext): void {
  assertPrivateCalendar(execution);
  if (execution?.isAdmin !== true) throw new Error('개인 근무 캘린더 설정은 PC 관리자만 변경할 수 있습니다.');
}

function assertDateKey(value: unknown): string {
  const date = String(value ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('날짜 형식은 YYYY-MM-DD여야 합니다.');
  const [year, month, day] = date.split('-').map(Number);
  if (year < 1900 || year > 2200 || month < 1 || month > 12 || day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) {
    throw new Error('달력 날짜가 올바르지 않습니다.');
  }
  return date;
}

function boundedText(value: unknown, label: string, maximum: number, allowEmpty = false): string {
  const result = String(value ?? '').trim().replace(/\s+/g, ' ');
  if ((!allowEmpty && !result) || result.length > maximum || /[\u0000-\u001f\u007f]/.test(result)) throw new Error(`${label} 형식이 올바르지 않습니다.`);
  return result;
}

function optionalText(value: unknown, label: string, maximum: number): string | undefined {
  if (value === undefined || value === null || String(value).trim() === '') return undefined;
  return boundedText(value, label, maximum);
}

function normalizePlaceKey(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLocaleLowerCase('ko-KR').slice(0, 160);
}

function pruneUnusedPlaces(
  assignments: Record<string, ImportedAssignment>,
  overrides: Record<string, WorkOverride>,
  places: Record<string, PrivatePlace>,
): Record<string, PrivatePlace> {
  const referenced = new Set<string>();
  for (const assignment of Object.values(assignments)) {
    if (assignment.status === 'onsite' && assignment.destinationLabel) referenced.add(normalizePlaceKey(assignment.destinationLabel));
  }
  for (const override of Object.values(overrides)) {
    if ((override.status === 'onsite' || override.status === 'remote') && override.destinationLabel) {
      referenced.add(normalizePlaceKey(override.destinationLabel));
    }
  }
  return Object.fromEntries(Object.entries(places).filter(([key]) => referenced.has(key)));
}

function currentSeoulDate(): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date());
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

function holidayLabel(holiday: KoreanHoliday): string {
  const labels: Record<string, string> = {
    'new-year': '신정', 'independence-day': '삼일절', 'children-day': '어린이날',
    'memorial-day': '현충일', 'liberation-day': '광복절', 'foundation-day': '개천절',
    'alphabet-day': '한글날', christmas: '성탄절', 'lunar-new-year': '설날',
    'buddha-birthday': '부처님오신날', 'harvest-festival': '추석',
    'labor-day': '노동절', 'constitution-day': '제헌절', 'local-election': '전국동시지방선거',
  };
  const baseId = holiday.id.replace(/-substitute$/, '');
  const base = labels[baseId] ?? '공휴일';
  return holiday.substitute || /-substitute$/.test(holiday.id) ? `${base} 대체공휴일` : base;
}

function holidayMap(year: number): Map<string, string> {
  return new Map(koreanPublicHolidays(year).map((item) => [item.date, holidayLabel(item)]));
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function effectiveDay(state: WorkCalendarState, date: string, holidays: Map<string, string>): WorkDayView {
  const imported = state.assignments[date];
  const override = state.overrides[date];
  const holidayName = holidays.get(date) ?? (isSeoulWeekend(date) ? (new Date(`${date}T00:00:00Z`).getUTCDay() === 0 ? '일요일' : '토요일') : undefined);
  let status: WorkStatus = imported?.status ?? 'unknown';
  let source: WorkSource = imported ? 'excel' : 'none';
  let destinationLabel = imported?.destinationLabel;
  let destinationAddress: string | undefined;

  if (holidayName) {
    status = 'off';
    source = 'holiday';
    destinationLabel = undefined;
  }
  if (override) {
    status = override.status;
    source = 'manual';
    destinationLabel = override.destinationLabel ?? destinationLabel;
    destinationAddress = override.destinationAddress;
  }
  if (status === 'off' || status === 'unknown') {
    destinationLabel = undefined;
    destinationAddress = undefined;
  } else if (!destinationAddress && destinationLabel) {
    destinationAddress = state.places[normalizePlaceKey(destinationLabel)]?.address;
  }
  return {
    date, status, source, overridden: Boolean(override),
    ...(destinationLabel ? { destinationLabel } : {}),
    ...(destinationAddress ? { destinationAddress } : {}),
    ...(holidayName ? { holidayName } : {}),
  };
}

function plainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function protectedText(value: unknown, maximum: number, allowWhitespace = true): value is string {
  return typeof value === 'string' && value.length <= maximum
    && !/[\u0000-\u001f\u007f]/.test(value)
    && (allowWhitespace || !/\s/.test(value));
}

function normalizeStoredState(value: WorkCalendarState | undefined): WorkCalendarState {
  if (value === undefined) return emptyWorkState();
  if (!value || value.version !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 0
    || !plainRecord(value.assignments) || !plainRecord(value.overrides) || !plainRecord(value.places)
    || !plainRecord(value.profile)
    || (value.importedAt !== undefined && (!Number.isFinite(value.importedAt) || value.importedAt < 0))) {
    throw new Error('암호화된 근무 캘린더 상태 형식을 확인할 수 없습니다. 기존 파일은 덮어쓰지 않았습니다.');
  }
  if (Object.keys(value.assignments).length > MAX_ASSIGNMENTS || Object.keys(value.overrides).length > MAX_ASSIGNMENTS || Object.keys(value.places).length > 1_000) {
    throw new Error('암호화된 근무 캘린더 상태가 안전 한도를 넘었습니다.');
  }
  for (const [date, assignment] of Object.entries(value.assignments)) {
    assertDateKey(date);
    if (!assignment || !['onsite', 'off'].includes(assignment.status)
      || (assignment.destinationLabel !== undefined && !protectedText(assignment.destinationLabel, 160))) {
      throw new Error('암호화된 근무 캘린더 일정 형식을 확인할 수 없습니다.');
    }
  }
  for (const [date, override] of Object.entries(value.overrides)) {
    assertDateKey(date);
    if (!override || !['onsite', 'remote', 'off', 'unknown'].includes(override.status)
      || !Number.isFinite(override.updatedAt)
      || (override.destinationLabel !== undefined && !protectedText(override.destinationLabel, 160))
      || (override.destinationAddress !== undefined && !protectedText(override.destinationAddress, 300))) {
      throw new Error('암호화된 근무 캘린더 수동 일정 형식을 확인할 수 없습니다.');
    }
  }
  for (const [key, place] of Object.entries(value.places)) {
    if (!protectedText(key, 160) || !place || !protectedText(place.label, 160)
      || !protectedText(place.address, 300) || !Number.isFinite(place.updatedAt)) {
      throw new Error('암호화된 근무지 주소 형식을 확인할 수 없습니다.');
    }
  }
  if (typeof value.profile.naverConsent !== 'boolean'
    || (value.profile.homeAddress !== undefined && !protectedText(value.profile.homeAddress, 300))
    || (value.profile.naverClientId !== undefined && !protectedText(value.profile.naverClientId, 200, false))
    || (value.profile.naverClientSecret !== undefined && !protectedText(value.profile.naverClientSecret, 500))) {
    throw new Error('암호화된 근무 캘린더 설정 형식을 확인할 수 없습니다.');
  }
  return value;
}

export function createCalendarPlugin(options: { privateStore?: WorkCalendarStore } = {}): MrRobotPlugin {
  return {
    manifest: {
      id: 'calendar', name: '캘린더', version: '0.3.7', kind: 'integration', enabledByDefault: true,
      description: '암호화된 근무표 가져오기, 월간 일정, 공휴일과 일회성 NAVER 경로 조회를 제공합니다.',
      capabilities: ['calendar.events.local', 'calendar.ics.export', 'calendar.work.private', 'calendar.work.xlsx', 'calendar.work.naver-route'],
      permissions: ['calendar.read', 'calendar.write', 'network.client'],
      dependencies: [],
    },
    activate(ctx) {
      const privateStore: WorkCalendarStore = options.privateStore ?? new WorkCalendarPrivateStore<WorkCalendarState>();
      let workState = normalizeStoredState(privateStore.load());
      const saveWorkState = (next: WorkCalendarState, change: WorkStateChange): void => {
        next.revision = workState.revision + 1;
        privateStore.save(next, { purgePrevious: change.purgePrevious });
        workState = next;
        ctx.emit('calendar.work.changed', {
          revision: next.revision,
          ...(change.from ? { from: change.from } : {}),
          ...(change.to ? { to: change.to } : {}),
        });
      };

      ctx.registerCommand('calendar.status', () => ({
        ok: true, provider: 'local', events: events(ctx).length,
        google: { configured: false, note: 'Google OAuth 클라이언트를 등록하면 교체 가능한 공급자로 연결됩니다.' },
      }), { destructive: false });

      ctx.registerCommand('calendar.events.list', (raw) => {
        const body = (raw ?? {}) as { from?: string; to?: string };
        const from = body.from ? new Date(body.from).getTime() : -Infinity;
        const to = body.to ? new Date(body.to).getTime() : Infinity;
        return events(ctx)
          .filter((item) => new Date(item.endAt).getTime() >= from && new Date(item.startAt).getTime() <= to)
          .sort((a, b) => a.startAt.localeCompare(b.startAt));
      }, {
        destructive: false, tool: true, description: '등록된 일반 일정과 약속을 조회합니다. 암호화된 근무 일정은 포함하지 않습니다.',
        toolWhen: (message) => /일정|약속|캘린더|스케줄|calendar|schedule|appointment/i.test(message),
        parameters: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } } },
      });

      ctx.registerCommand('calendar.events.add', (raw) => {
        const body = (raw ?? {}) as Partial<CalendarEvent>;
        const startAt = validDate(body.startAt, '시작');
        const endAt = validDate(body.endAt ?? body.startAt, '종료');
        if (new Date(endAt).getTime() < new Date(startAt).getTime()) throw new Error('종료 시간은 시작 시간보다 빠를 수 없습니다.');
        const now = Date.now();
        const item: CalendarEvent = {
          id: randomUUID(), title: String(body.title ?? '').trim().slice(0, 160) || '새 일정',
          description: body.description?.trim().slice(0, 4000), startAt, endAt,
          allDay: body.allDay === true, location: body.location?.trim().slice(0, 500), source: 'local', createdAt: now, updatedAt: now,
        };
        const next = [...events(ctx), item];
        ctx.storage.set('events', next);
        ctx.emit('calendar.changed', next);
        return item;
      }, {
        tool: true, destructive: true, description: '새 일반 일정을 캘린더에 추가합니다.',
        toolWhen: (message) => /일정|약속|캘린더|스케줄|calendar|schedule|appointment/i.test(message),
        parameters: { type: 'object', properties: {
          title: { type: 'string' }, startAt: { type: 'string' }, endAt: { type: 'string' },
          allDay: { type: 'boolean' }, description: { type: 'string' }, location: { type: 'string' },
        }, required: ['title', 'startAt', 'endAt'] },
      });

      ctx.registerCommand('calendar.events.remove', (raw) => {
        const id = String((raw as { id?: string } | undefined)?.id ?? '');
        const current = events(ctx);
        const next = current.filter((item) => item.id !== id);
        if (next.length === current.length) throw new Error('일정을 찾을 수 없습니다.');
        ctx.storage.set('events', next);
        ctx.emit('calendar.changed', next);
        return { ok: true };
      }, {
        tool: true, destructive: true, description: '일반 일정을 삭제합니다.',
        toolWhen: (message) => /일정|약속|캘린더|스케줄|calendar|schedule/i.test(message),
        parameters: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
      });

      ctx.registerCommand('calendar.ics.export', () => {
        const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Mr.Robot//Calendar//KO'];
        for (const item of events(ctx)) {
          const format = (value: string) => new Date(value).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
          lines.push('BEGIN:VEVENT', `UID:${item.id}@mr-robot.local`, `DTSTART:${format(item.startAt)}`, `DTEND:${format(item.endAt)}`, `SUMMARY:${item.title.replace(/[;,]/g, '\\$&')}`, 'END:VEVENT');
        }
        lines.push('END:VCALENDAR');
        return { filename: 'mr-robot-calendar.ics', content: lines.join('\r\n') };
      }, { destructive: false });

      ctx.registerCommand('calendar.work.month', (raw, execution) => {
        assertPrivateCalendar(execution);
        const body = (raw ?? {}) as { year?: number; month?: number };
        const year = Number(body.year);
        const month = Number(body.month);
        if (!Number.isInteger(year) || year < 1900 || year > 2200 || !Number.isInteger(month) || month < 1 || month > 12) throw new Error('조회할 연도와 월이 올바르지 않습니다.');
        const holidays = holidayMap(year);
        const days = Array.from({ length: daysInMonth(year, month) }, (_, index) => {
          const date = `${year}-${String(month).padStart(2, '0')}-${String(index + 1).padStart(2, '0')}`;
          return effectiveDay(workState, date, holidays);
        });
        return {
          year, month, today: currentSeoulDate(), days,
          configured: Object.keys(workState.assignments).length > 0,
          ...(workState.importedAt ? { importedAt: new Date(workState.importedAt).toISOString() } : {}),
          access: {
            isAdmin: execution?.isAdmin === true,
            canEdit: execution?.isAdmin === true
              || (execution?.permissionMode !== 'read-only' && execution?.deviceCapabilities?.includes('private-calendar') === true),
          },
          profile: {
            homeAddressSet: Boolean(workState.profile.homeAddress),
            naverConfigured: Boolean(workState.profile.naverClientId && workState.profile.naverClientSecret),
            naverConsent: workState.profile.naverConsent === true,
          },
        };
      }, { destructive: false, tool: false });

      ctx.registerCommand('calendar.work.import', async (raw, execution) => {
        assertPrivateCalendarAdmin(execution);
        const body = (raw ?? {}) as { path?: string; person?: string; team?: string; year?: number };
        const path = String(body.path ?? '').trim();
        if (!path || path.length > 2_048 || /[\u0000-\u001f\u007f]/.test(path)) throw new Error('파일 경로 형식이 올바르지 않습니다.');
        const person = boundedText(body.person, '행 식별값', 100);
        const team = optionalText(body.team, '그룹 식별값', 100);
        const year = body.year === undefined ? Number(currentSeoulDate().slice(0, 4)) : Number(body.year);
        if (!Number.isInteger(year) || year < 1900 || year > 2200) throw new Error('가져올 연도가 올바르지 않습니다.');
        let bytes: Buffer | undefined;
        let fileDescriptor: number | undefined;
        try {
          const resolved = realpathSync(path);
          if (extname(resolved).toLocaleLowerCase('en-US') !== '.xlsx') throw new Error('매크로 없는 .xlsx 파일만 가져올 수 있습니다.');
          // Open once, read through that descriptor, and never request write
          // access. This prevents a path replacement between validation and
          // reading, and makes it impossible for the importer to edit Excel.
          fileDescriptor = openSync(resolved, 'r');
          const stat = fstatSync(fileDescriptor);
          if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_WORKBOOK_BYTES) throw new Error('가져올 파일은 25MB 이하의 .xlsx 통합 문서여야 합니다.');
          bytes = Buffer.allocUnsafe(stat.size);
          let offset = 0;
          while (offset < bytes.length) {
            const count = readSync(fileDescriptor, bytes, offset, bytes.length - offset, null);
            if (count === 0) throw new Error('가져오는 동안 엑셀 파일 크기가 변경되었습니다. 다시 시도해 주세요.');
            offset += count;
          }
          const extra = Buffer.alloc(1);
          const grew = readSync(fileDescriptor, extra, 0, 1, null) !== 0;
          extra.fill(0);
          if (grew) throw new Error('가져오는 동안 엑셀 파일 크기가 변경되었습니다. 다시 시도해 주세요.');
          const parsed = await parseWorkCalendarXlsx(basename(resolved), bytes, { person, ...(team ? { team } : {}), year });
          if (parsed.length === 0) throw new Error('지정한 행과 날짜 머리글을 가진 근무 일정을 찾지 못했습니다.');
          const assignments = Object.fromEntries(Object.entries(workState.assignments).filter(([date]) => !date.startsWith(`${year}-`)));
          for (const item of parsed) assignments[item.date] = {
            status: item.kind,
            ...(item.destinationLabel ? { destinationLabel: item.destinationLabel } : {}),
          };
          if (Object.keys(assignments).length > MAX_ASSIGNMENTS) throw new Error('가져온 근무 일정이 안전 한도를 넘었습니다.');
          const importedAt = Date.now();
          const places = pruneUnusedPlaces(assignments, workState.overrides, workState.places);
          saveWorkState({ ...workState, importedAt, assignments, places }, {
            from: `${year}-01-01`, to: `${year}-12-31`, purgePrevious: true,
          });
          return {
            ok: true, year, importedAt: new Date(importedAt).toISOString(), days: parsed.length,
            onsite: parsed.filter((item) => item.kind === 'onsite').length,
            off: parsed.filter((item) => item.kind === 'off').length,
          };
        } catch (error) {
          // Node filesystem errors include the full source path in `message`.
          // Expose only messages created above and never substring-allowlist an
          // error merely because a private path happens to end in `.xlsx`.
          if (error instanceof Error && SAFE_IMPORT_MESSAGES.has(error.message)) throw error;
          throw new Error('엑셀 근무표를 안전하게 가져오지 못했습니다. 파일 형식과 식별값을 확인해 주세요.');
        } finally {
          if (fileDescriptor !== undefined) {
            try { closeSync(fileDescriptor); } catch { /* read-only descriptor cleanup */ }
          }
          bytes?.fill(0);
        }
      }, { destructive: true, adminOnly: true, tool: false });

      ctx.registerCommand('calendar.work.override.set', (raw, execution) => {
        assertPrivateCalendarEdit(execution);
        const body = (raw ?? {}) as { date?: string; status?: WorkStatus; destinationLabel?: string; destinationAddress?: string };
        const date = assertDateKey(body.date);
        const status = String(body.status ?? '') as WorkStatus;
        if (!['onsite', 'remote', 'off', 'unknown'].includes(status)) throw new Error('근무 형태가 올바르지 않습니다.');
        const destinationLabel = optionalText(body.destinationLabel, '근무지 이름', 160);
        const destinationAddress = optionalText(body.destinationAddress, '근무지 주소', 300);
        const overrides = { ...workState.overrides, [date]: {
          status,
          ...((status === 'onsite' || status === 'remote') && destinationLabel ? { destinationLabel } : {}),
          ...((status === 'onsite' || status === 'remote') && destinationAddress ? { destinationAddress } : {}),
          updatedAt: Date.now(),
        } };
        let places = workState.places;
        if (destinationLabel && destinationAddress) places = { ...places, [normalizePlaceKey(destinationLabel)]: { label: destinationLabel, address: destinationAddress, updatedAt: Date.now() } };
        places = pruneUnusedPlaces(workState.assignments, overrides, places);
        saveWorkState({ ...workState, overrides, places }, { from: date, to: date, purgePrevious: true });
        return { ok: true };
      }, { destructive: true, requiredCapability: 'private-calendar', tool: false });

      ctx.registerCommand('calendar.work.override.remove', (raw, execution) => {
        assertPrivateCalendarEdit(execution);
        const date = assertDateKey((raw as { date?: string } | undefined)?.date);
        if (!workState.overrides[date]) return { ok: true, changed: false };
        const overrides = { ...workState.overrides };
        delete overrides[date];
        const places = pruneUnusedPlaces(workState.assignments, overrides, workState.places);
        saveWorkState({ ...workState, overrides, places }, { from: date, to: date, purgePrevious: true });
        return { ok: true, changed: true };
      }, { destructive: true, requiredCapability: 'private-calendar', tool: false });

      ctx.registerCommand('calendar.work.settings.get', (_raw, execution) => {
        assertPrivateCalendarAdmin(execution);
        return {
          homeAddress: workState.profile.homeAddress ?? '',
          naverClientIdSet: Boolean(workState.profile.naverClientId),
          naverClientSecretSet: Boolean(workState.profile.naverClientSecret),
          naverConsent: workState.profile.naverConsent === true,
        };
      }, { destructive: false, adminOnly: true, tool: false });

      ctx.registerCommand('calendar.work.settings.set', (raw, execution) => {
        assertPrivateCalendarAdmin(execution);
        const body = (raw ?? {}) as { homeAddress?: string; naverClientId?: string; naverClientSecret?: string; naverConsent?: boolean; clearNaverCredentials?: boolean };
        const homeAddress = body.homeAddress === undefined ? workState.profile.homeAddress : optionalText(body.homeAddress, '집 주소', 300);
        const profile = {
          ...workState.profile,
          ...(homeAddress ? { homeAddress } : { homeAddress: undefined }),
          naverConsent: body.naverConsent === undefined ? workState.profile.naverConsent : body.naverConsent === true,
        };
        if (body.clearNaverCredentials === true) {
          profile.naverClientId = undefined;
          profile.naverClientSecret = undefined;
          profile.naverConsent = false;
        } else {
          const clientId = optionalText(body.naverClientId, 'NAVER Client ID', 200);
          const clientSecret = optionalText(body.naverClientSecret, 'NAVER Client Secret', 500);
          if (clientId) profile.naverClientId = clientId;
          if (clientSecret) profile.naverClientSecret = clientSecret;
        }
        saveWorkState({ ...workState, profile }, { purgePrevious: true });
        return {
          homeAddress: profile.homeAddress ?? '',
          naverClientIdSet: Boolean(profile.naverClientId),
          naverClientSecretSet: Boolean(profile.naverClientSecret),
          naverConsent: profile.naverConsent,
        };
      }, { destructive: true, adminOnly: true, tool: false });

      ctx.registerCommand('calendar.work.holidays.refresh', (_raw, execution) => {
        assertPrivateCalendarAdmin(execution);
        const current = Number(currentSeoulDate().slice(0, 4));
        return {
          ok: true, source: current === 2026 ? 'official-2026-law-and-almanac' : 'local-korean-calendar-rules',
          years: [current, current + 1].map((year) => ({ year, holidays: koreanPublicHolidays(year).length })),
          note: '네트워크로 개인정보를 보내지 않고 Asia/Seoul 기준 공휴일 규칙을 확인했습니다. 2026년은 현행 법령과 월력요항의 날짜를 반영합니다.',
        };
      }, { destructive: false, adminOnly: true, tool: false });

      ctx.registerCommand('calendar.work.route.preview', async (raw, execution) => {
        assertPrivateCalendar(execution);
        const date = assertDateKey((raw as { date?: string } | undefined)?.date);
        if (!workState.profile.naverConsent) throw new Error('주소를 NAVER Maps에 보내는 데 먼저 동의해 주세요.');
        if (!workState.profile.homeAddress || !workState.profile.naverClientId || !workState.profile.naverClientSecret) throw new Error('PC에서 집 주소와 NAVER Maps 인증 정보를 먼저 설정해 주세요.');
        const day = effectiveDay(workState, date, holidayMap(Number(date.slice(0, 4))));
        if (day.status !== 'onsite' || !day.destinationAddress) throw new Error('이 날짜에 경로 계산용 근무지 주소를 먼저 저장해 주세요.');
        return previewNaverRoute({
          startAddress: workState.profile.homeAddress,
          destinationAddress: day.destinationAddress,
          credentials: { clientId: workState.profile.naverClientId, clientSecret: workState.profile.naverClientSecret },
          signal: execution?.signal,
        });
      }, { destructive: false, tool: false });
    },
  };
}
