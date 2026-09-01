import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppSettings, CalendarEvent, PermissionMode, ScheduledJobView, ScheduleJobType } from '@mr-robot/shared';
import { useMrRobot } from '../state';
import { Badge, Button, Card, Field, Input, Modal, Select, Toggle } from '../components/ui';
import { trustedNmapRoute } from '../naver-route-link';

const TYPE_LABEL: Record<ScheduleJobType, string> = { chat: 'AI 작업', shell: '셸 명령', launch: '앱 실행' };
const TYPE_BADGE: Record<ScheduleJobType, 'accent' | 'default' | 'ok'> = { chat: 'accent', shell: 'default', launch: 'ok' };
const DAY_NAMES = ['일', '월', '화', '수', '목', '금', '토'];
const WORK_STATUS_LABEL = { onsite: '출근', remote: '재택', off: '휴무', unknown: '미정' } as const;
const SEOUL_TIME_ZONE = 'Asia/Seoul';

type WorkStatus = keyof typeof WORK_STATUS_LABEL;
type WorkDay = {
  date: string;
  status: WorkStatus;
  destinationLabel?: string;
  destinationAddress?: string;
  source: 'excel' | 'manual' | 'holiday' | 'none';
  overridden: boolean;
  holidayName?: string;
};
type WorkMonth = {
  year: number;
  month: number;
  today: string;
  days: WorkDay[];
  configured: boolean;
  importedAt?: string;
  profile: { homeAddressSet: boolean; naverConfigured: boolean; naverConsent: boolean };
  access: { canEdit: boolean; isAdmin: boolean };
};
type WorkSettings = { homeAddress: string; naverClientIdSet: boolean; naverClientSecretSet: boolean; naverConsent: boolean };
type RoutePreview = { car?: { distanceM: number; durationMin: number }; links: { publicTransit: string; walk: string; car: string }; notice: string };

function dateKey(year: number, month: number, day: number): string {
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function seoulDateParts(at = new Date()): { year: number; month: number; day: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: SEOUL_TIME_ZONE,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  }).formatToParts(at);
  const value = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((part) => part.type === type)?.value);
  return { year: value('year'), month: value('month') - 1, day: value('day') };
}

function shiftMonth(year: number, month: number, amount: number): { year: number; month: number } {
  const absoluteMonth = year * 12 + month + amount;
  return { year: Math.floor(absoluteMonth / 12), month: ((absoluteMonth % 12) + 12) % 12 };
}

function fmtWhen(job: ScheduledJobView): string {
  if (job.when.kind === 'once') {
    const d = new Date(job.when.at);
    if (Number.isNaN(d.getTime())) return '시간 형식 오류';
    return `일회성 · ${d.toLocaleString('ko-KR', { dateStyle: 'medium', timeStyle: 'short' })}`;
  }
  const days = job.when.days && job.when.days.length > 0 ? job.when.days : [0, 1, 2, 3, 4, 5, 6];
  const dayLabel = days.length === 7 ? '매일' : days.map((d) => DAY_NAMES[d]).join('·') + '요일';
  return `반복 · ${dayLabel} ${job.when.at}`;
}

function fmtNext(ts: number | null): string {
  if (ts === null) return '—';
  const diff = ts - Date.now();
  const abs = Math.abs(diff);
  const rel =
    abs < 60_000
      ? diff >= 0
        ? '곧 실행'
        : '방금 전'
      : `${Math.round(abs / 3_600_000 * 10) / 10}시간 ${diff >= 0 ? '후' : '전'}`;
  return `${rel} (${new Date(ts).toLocaleString('ko-KR', { dateStyle: 'short', timeStyle: 'short' })})`;
}

export function SchedulesView() {
  const { client } = useMrRobot();
  const canManageJobs = client.isAdmin;
  const [jobs, setJobs] = useState<ScheduledJobView[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [openResult, setOpenResult] = useState<string | null>(null);

  // form state
  const [type, setType] = useState<ScheduleJobType>('chat');
  const [name, setName] = useState('');
  const [whenKind, setWhenKind] = useState<'once' | 'daily'>('once');
  const [onceAt, setOnceAt] = useState('');
  const [dailyAt, setDailyAt] = useState('09:00');
  const [days, setDays] = useState<number[]>([]);
  const [prompt, setPrompt] = useState('');
  const [command, setCommand] = useState('');
  const [shellKind, setShellKind] = useState<'powershell' | 'cmd'>('powershell');
  const [target, setTarget] = useState('');
  const [args, setArgs] = useState('');
  const [allowDestructive, setAllowDestructive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [calendarEvents, setCalendarEvents] = useState<CalendarEvent[]>([]);
  const [calendarTitle, setCalendarTitle] = useState('');
  const [calendarStart, setCalendarStart] = useState('');
  const [calendarEnd, setCalendarEnd] = useState('');
  const [globalPermission, setGlobalPermission] = useState<PermissionMode>('read-only');
  const initialSeoulDate = seoulDateParts();
  const [workYear, setWorkYear] = useState(initialSeoulDate.year);
  const [workMonthNumber, setWorkMonthNumber] = useState(initialSeoulDate.month);
  const [workMonth, setWorkMonth] = useState<WorkMonth | null>(null);
  const [selectedDate, setSelectedDate] = useState<string | null>(null);
  const selectedDateRef = useRef<string | null>(null);
  const [workStatus, setWorkStatus] = useState<WorkStatus>('unknown');
  const [destinationLabel, setDestinationLabel] = useState('');
  const [destinationAddress, setDestinationAddress] = useState('');
  const [importPerson, setImportPerson] = useState('');
  const [importTeam, setImportTeam] = useState('');
  const [workSettings, setWorkSettings] = useState<WorkSettings | null>(null);
  const [homeAddress, setHomeAddress] = useState('');
  const [naverClientId, setNaverClientId] = useState('');
  const [naverClientSecret, setNaverClientSecret] = useState('');
  const [naverConsent, setNaverConsent] = useState(false);
  const [routePreview, setRoutePreview] = useState<RoutePreview | null>(null);
  const [workNotice, setWorkNotice] = useState('');
  const [clearNaverConfirmOpen, setClearNaverConfirmOpen] = useState(false);
  const canWriteCalendar = canManageJobs || (client.permissionCap === 'full' && globalPermission === 'full');
  const canWriteWorkCalendar = canManageJobs || workMonth?.access.canEdit === true;

  const calendarCall = useCallback(<T,>(name: string, params: Record<string, unknown>): Promise<T> => (
    client.call('plugins.call', { name, params }) as Promise<T>
  ), [client]);

  useEffect(() => {
    selectedDateRef.current = selectedDate;
  }, [selectedDate]);

  const refresh = useCallback(async (): Promise<WorkMonth | null> => {
    const [calendarResult, settingsResult, jobsResult, workMonthResult, workSettingsResult] = await Promise.allSettled([
      client.call('plugins.call', { name: 'calendar.events.list', params: {} }) as Promise<CalendarEvent[]>,
      client.call('settings.get', {}) as Promise<AppSettings>,
      canManageJobs ? client.call('scheduler.list', {}) as Promise<ScheduledJobView[]> : Promise.resolve([]),
      calendarCall<WorkMonth>('calendar.work.month', { year: workYear, month: workMonthNumber + 1 }),
      canManageJobs ? calendarCall<WorkSettings>('calendar.work.settings.get', {}) : Promise.resolve(null),
    ]);
    if (calendarResult.status === 'fulfilled') setCalendarEvents(calendarResult.value);
    else setError(calendarResult.reason instanceof Error ? calendarResult.reason.message : String(calendarResult.reason));
    if (settingsResult.status === 'fulfilled') setGlobalPermission(settingsResult.value.safety.mode);
    if (jobsResult.status === 'fulfilled') setJobs(jobsResult.value);
    else if (canManageJobs) setError(jobsResult.reason instanceof Error ? jobsResult.reason.message : String(jobsResult.reason));
    const refreshedWorkMonth = workMonthResult.status === 'fulfilled' ? workMonthResult.value : null;
    if (refreshedWorkMonth) {
      setWorkMonth(refreshedWorkMonth);
      setSelectedDate((current) => current && refreshedWorkMonth.days.some((day) => day.date === current) ? current : null);
    } else {
      // Do not leave previously authorized private data visible after a device
      // capability is revoked or a different PC cannot authorize this view.
      setWorkMonth(null);
      setSelectedDate(null);
      setRoutePreview(null);
      setDestinationLabel('');
      setDestinationAddress('');
      setWorkNotice('근무 캘린더를 불러오지 못했습니다. PC 연결과 이 기기의 개인 캘린더 권한을 확인하세요.');
    }
    if (workSettingsResult.status === 'fulfilled' && workSettingsResult.value) {
      setWorkSettings(workSettingsResult.value);
      setHomeAddress(workSettingsResult.value.homeAddress);
      setNaverConsent(workSettingsResult.value.naverConsent);
    } else if (!canManageJobs) {
      setWorkSettings(null);
      setHomeAddress('');
      setNaverClientId('');
      setNaverClientSecret('');
      setNaverConsent(false);
    }
    return refreshedWorkMonth;
  }, [calendarCall, canManageJobs, client, workMonthNumber, workYear]);

  const refreshSelectedWorkDay = useCallback(async (): Promise<void> => {
    const currentDate = selectedDateRef.current;
    const refreshedWorkMonth = await refresh();
    if (!currentDate || !refreshedWorkMonth) return;
    const refreshedDay = refreshedWorkMonth.days.find((day) => day.date === currentDate);
    if (!refreshedDay) {
      setSelectedDate(null);
      setRoutePreview(null);
      setDestinationLabel('');
      setDestinationAddress('');
      return;
    }
    setWorkStatus(refreshedDay.status);
    setDestinationLabel(refreshedDay.destinationLabel ?? '');
    setDestinationAddress(refreshedDay.destinationAddress ?? '');
    setRoutePreview(null);
  }, [refresh]);

  const addCalendarEvent = async (): Promise<void> => {
    if (!canWriteCalendar || !calendarTitle.trim() || !calendarStart) return;
    setBusy(true); setError('');
    try {
      if (calendarEnd && new Date(calendarEnd).getTime() < new Date(calendarStart).getTime()) throw new Error('종료 시각은 시작 시각보다 빠를 수 없습니다.');
      await client.call('plugins.call', { name: 'calendar.events.add', params: { title: calendarTitle.trim(), startAt: calendarStart, endAt: calendarEnd || calendarStart, allDay: false } });
      setCalendarTitle(''); setCalendarStart(''); setCalendarEnd(''); await refresh();
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  };

  const removeCalendarEvent = async (id: string): Promise<void> => {
    if (!canWriteCalendar) return;
    try { await client.call('plugins.call', { name: 'calendar.events.remove', params: { id } }); await refresh(); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  };

  const selectWorkDay = (day: WorkDay): void => {
    setSelectedDate(day.date);
    setWorkStatus(day.status);
    setDestinationLabel(day.destinationLabel ?? '');
    setDestinationAddress(day.destinationAddress ?? '');
    setRoutePreview(null);
  };

  const updateWorkDay = async (): Promise<void> => {
    if (!selectedDate || !canWriteWorkCalendar) return;
    setBusy(true); setError('');
    try {
      await calendarCall('calendar.work.override.set', {
        date: selectedDate,
        status: workStatus,
        destinationLabel: destinationLabel.trim() || undefined,
        destinationAddress: destinationAddress.trim() || undefined,
      });
      setWorkNotice('선택한 날짜의 근무 정보를 저장했습니다.');
      await refreshSelectedWorkDay();
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  };

  const removeWorkOverride = async (): Promise<void> => {
    if (!selectedDate || !canWriteWorkCalendar) return;
    setBusy(true); setError('');
    try {
      await calendarCall('calendar.work.override.remove', { date: selectedDate });
      setWorkNotice('수동 변경을 지우고 원본 일정으로 되돌렸습니다.');
      await refreshSelectedWorkDay();
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  };

  const importWorkbook = async (): Promise<void> => {
    const desktop = (window as Window & { mrRobotDesktop?: { chooseCalendarWorkbook?: () => Promise<string | null> } }).mrRobotDesktop;
    if (!desktop?.chooseCalendarWorkbook) {
      setWorkNotice('엑셀 가져오기는 파일 선택기를 제공하는 PC 앱에서만 사용할 수 있습니다.');
      return;
    }
    setBusy(true); setError('');
    try {
      const path = await desktop.chooseCalendarWorkbook();
      if (!path) return;
      await calendarCall('calendar.work.import', { path, person: importPerson.trim(), team: importTeam.trim(), year: workYear });
      setImportPerson(''); setImportTeam(''); setWorkNotice('선택한 파일을 PC에서 가져왔습니다.');
      await refreshSelectedWorkDay();
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  };

  const saveWorkSettings = async (): Promise<void> => {
    setBusy(true); setError('');
    try {
      const saved = await calendarCall<WorkSettings>('calendar.work.settings.set', {
        homeAddress: homeAddress.trim(),
        naverClientId: naverClientId || undefined,
        naverClientSecret: naverClientSecret || undefined,
        naverConsent,
      });
      setWorkSettings(saved);
      setHomeAddress(saved.homeAddress);
      setNaverClientId(''); setNaverClientSecret(''); setRoutePreview(null);
      setWorkNotice('경로 설정을 이 PC에 저장했습니다.');
      await refresh();
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  };

  const clearNaverCredentials = async (): Promise<void> => {
    if (busy || (!workSettings?.naverClientIdSet && !workSettings?.naverClientSecretSet)) return;
    setBusy(true); setError('');
    try {
      const saved = await calendarCall<WorkSettings>('calendar.work.settings.set', { clearNaverCredentials: true });
      setWorkSettings(saved);
      setHomeAddress(saved.homeAddress);
      setNaverClientId(''); setNaverClientSecret(''); setNaverConsent(false); setRoutePreview(null);
      setWorkNotice('NAVER 지도 인증정보와 주소 전송 동의를 삭제했습니다.');
      setClearNaverConfirmOpen(false);
      await refresh();
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  };

  const refreshHolidays = async (): Promise<void> => {
    setBusy(true); setError('');
    try { await calendarCall('calendar.work.holidays.refresh', {}); setWorkNotice('공휴일 정보를 새로 고쳤습니다.'); await refreshSelectedWorkDay(); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  };

  const previewRoute = async (): Promise<void> => {
    if (!selectedDate) return;
    setBusy(true); setError('');
    try { setRoutePreview(await calendarCall<RoutePreview>('calendar.work.route.preview', { date: selectedDate })); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  };

  useEffect(() => {
    void refresh();
    const off1 = canManageJobs ? client.on('scheduler.changed', (d) => setJobs(d as ScheduledJobView[])) : () => undefined;
    const off2 = canManageJobs ? client.on('scheduler.ran', (d) => setJobs(d as ScheduledJobView[])) : () => undefined;
    const off3 = client.on('settings.changed', (data) => {
      setGlobalPermission((data as AppSettings).safety.mode);
      void refresh();
    });
    const off4 = client.on('calendar.work.changed', () => void refreshSelectedWorkDay());
    const tick = setInterval(() => setJobs((j) => [...j]), 30000); // refresh relative times
    const calendarTick = setInterval(() => void refresh(), 5 * 60_000); // keep Asia/Seoul today/holidays current
    return () => {
      off1();
      off2();
      off3();
      off4();
      clearInterval(tick);
      clearInterval(calendarTick);
    };
  }, [canManageJobs, client, refresh, refreshSelectedWorkDay]);

  const add = async (): Promise<void> => {
    if (!canManageJobs || busy) return;
    setBusy(true);
    setError('');
    try {
      const when =
        whenKind === 'once' ? { kind: 'once', at: onceAt } : { kind: 'daily', at: dailyAt, days };
      await client.call('scheduler.add', {
        name: name.trim() || TYPE_LABEL[type],
        type,
        prompt: type === 'chat' ? prompt.trim() : undefined,
        command: type === 'shell' ? command : undefined,
        shellKind,
        target: type === 'launch' ? target.trim() : undefined,
        args: type === 'launch' && args.trim() ? args.split(',').map((s) => s.trim()).filter(Boolean) : undefined,
        whenKind: when.kind,
        at: when.at,
        days,
        allowDestructive,
      });
      setShowAdd(false);
      setName('');
      setPrompt('');
      setCommand('');
      setTarget('');
      setArgs('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string): Promise<void> => {
    if (!canManageJobs) return;
    try {
      await client.call('scheduler.remove', { id });
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  };

  const setEnabled = async (id: string, enabled: boolean): Promise<void> => {
    if (!canManageJobs) return;
    try {
      await client.call('scheduler.setEnabled', { id, enabled });
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  };

  const toggleDay = (d: number): void => {
    setDays((cur) => (cur.includes(d) ? cur.filter((x) => x !== d) : [...cur, d].sort()));
  };

  const validJobPayload = type === 'chat' ? Boolean(prompt.trim()) : type === 'shell' ? Boolean(command.trim()) : Boolean(target.trim());
  const enabledJobs = jobs.filter((job) => job.enabled).length;
  const nextJob = jobs.filter((job) => job.nextRun !== null).sort((a, b) => (a.nextRun ?? Infinity) - (b.nextRun ?? Infinity))[0];
  const monthFirstDay = new Date(Date.UTC(workYear, workMonthNumber, 1)).getUTCDay();
  const daysInMonth = new Date(Date.UTC(workYear, workMonthNumber + 1, 0)).getUTCDate();
  const workDaysByDate = new Map((workMonth?.days ?? []).map((day) => [day.date, day]));
  const selectedWorkDay = selectedDate ? workDaysByDate.get(selectedDate) ?? { date: selectedDate, status: 'unknown' as WorkStatus, source: 'none' as const, overridden: false } : undefined;
  const seoulToday = seoulDateParts();
  const todayKey = workMonth?.today ?? dateKey(seoulToday.year, seoulToday.month, seoulToday.day);
  const monthLabel = new Intl.DateTimeFormat('ko-KR', { year: 'numeric', month: 'long', timeZone: SEOUL_TIME_ZONE }).format(new Date(Date.UTC(workYear, workMonthNumber, 1)));
  const goMonth = (amount: number): void => {
    const moved = shiftMonth(workYear, workMonthNumber, amount);
    setWorkYear(moved.year); setWorkMonthNumber(moved.month); setSelectedDate(null); setRoutePreview(null);
  };
  const openRoute = (kind: keyof RoutePreview['links']): void => {
    const target = trustedNmapRoute(routePreview?.links[kind], kind);
    if (!target) {
      setWorkNotice('안전한 지도 경로 링크를 준비하지 못했습니다.');
      return;
    }
    window.open(target, '_blank', 'noopener,noreferrer');
  };

  return (
    <div className="stack">
      <section className="automation-hero panel"><div><span className="eyebrow">LOCAL AUTOMATION</span><h2>일정과 에이전트 작업을 한곳에서</h2><p>로컬 캘린더는 토큰 없이 저장되고, 예약 작업은 정해진 시각에 선택한 PC에서 실행됩니다.</p></div><div className="automation-metrics"><span><b>{calendarEvents.length}</b> 일정</span><span><b>{enabledJobs}</b> 활성 작업</span><span><b>{nextJob ? fmtNext(nextJob.nextRun).split(' (')[0] : '없음'}</b> 다음 실행</span></div></section>
      {error && <div className="page-error"><span>!</span><div><b>작업을 완료하지 못했습니다.</b><small>{error}</small></div><button type="button" onClick={() => setError('')} aria-label="오류 닫기">×</button></div>}
      <Card className="panel work-calendar-panel">
        <div className="panel-head"><div><span className="eyebrow">WORK CALENDAR</span><h3>근무 일정</h3></div><Badge tone={workMonth?.configured ? 'ok' : 'warn'}>{workMonth?.configured ? 'PC 설정됨' : '가져오기 필요'}</Badge></div>
        <p className="panel-hint">엑셀 원본과 수동 변경은 이 PC에서만 처리됩니다. 아래 날짜를 선택해 근무지와 경로를 확인하세요.</p>
        <div className="work-calendar-toolbar">
          <div className="month-nav" aria-label="월 이동"><Button variant="ghost" onClick={() => goMonth(-1)} aria-label="이전 달">‹</Button><h4 aria-live="polite">{monthLabel}</h4><Button variant="ghost" onClick={() => goMonth(1)} aria-label="다음 달">›</Button><Button variant="ghost" onClick={() => { const current = seoulDateParts(); setWorkYear(current.year); setWorkMonthNumber(current.month); setSelectedDate(null); }}>오늘</Button></div>
          <div className="work-calendar-actions">{canManageJobs && <Button variant="ghost" onClick={() => void refreshHolidays()} disabled={busy}>공휴일 새로고침</Button>}<span>{workMonth?.importedAt ? '엑셀 가져오기 완료' : '엑셀 미가져옴'}</span></div>
        </div>
        {workNotice && <div className="work-notice" role="status">{workNotice}<button type="button" aria-label="안내 닫기" onClick={() => setWorkNotice('')}>×</button></div>}
        <div className="work-calendar-weekdays" aria-hidden="true">{DAY_NAMES.map((name, index) => <span key={name} className={index === 0 || index === 6 ? 'weekend' : ''}>{name}</span>)}</div>
        <div className="work-calendar-grid" role="grid" aria-label={`${monthLabel} 근무 달력`}>
          {Array.from({ length: monthFirstDay }, (_, index) => <span className="work-calendar-blank" key={`blank-${index}`} aria-hidden="true" />)}
          {Array.from({ length: daysInMonth }, (_, index) => {
            const dayNumber = index + 1;
            const key = dateKey(workYear, workMonthNumber, dayNumber);
            const day = workDaysByDate.get(key) ?? { date: key, status: 'unknown' as WorkStatus, source: 'none' as const, overridden: false };
            const weekend = new Date(Date.UTC(workYear, workMonthNumber, dayNumber)).getUTCDay() % 6 === 0;
            const isHoliday = Boolean(day.holidayName);
            return <button key={key} type="button" role="gridcell" aria-label={`${key}, ${WORK_STATUS_LABEL[day.status]}${day.holidayName ? `, ${day.holidayName}` : ''}`} aria-selected={selectedDate === key} onClick={() => selectWorkDay(day)} className={`work-calendar-day status-${day.status} ${weekend || isHoliday ? 'is-red-day' : ''} ${key === todayKey ? 'is-today' : ''} ${selectedDate === key ? 'is-selected' : ''}`}><span className="work-day-number">{dayNumber}</span>{day.holidayName && <span className="work-holiday">{day.holidayName}</span>}<span className="work-status">{WORK_STATUS_LABEL[day.status]}</span>{day.destinationLabel && <span className="work-destination">{day.destinationLabel}</span>}{day.overridden && <span className="work-override" title="수동 변경됨">수정</span>}</button>;
          })}
        </div>
        {selectedWorkDay && <section className="work-day-drawer" aria-label={`${selectedWorkDay.date} 근무 상세`}>
          <div className="work-drawer-head"><div><span className="eyebrow">SELECTED DAY</span><h4>{selectedWorkDay.date} · {WORK_STATUS_LABEL[selectedWorkDay.status]}</h4><small>{selectedWorkDay.holidayName || (selectedWorkDay.source === 'excel' ? '엑셀에서 가져온 일정' : selectedWorkDay.source === 'manual' ? '수동으로 변경한 일정' : '근무 정보 없음')}</small></div><button type="button" aria-label="선택한 날짜 닫기" onClick={() => { setSelectedDate(null); setRoutePreview(null); }}>×</button></div>
          {!canWriteWorkCalendar && <div className="access-inline"><b>근무 일정 보기 모드</b><span>이 기기 또는 PC의 현재 권한에서는 수동 변경을 저장할 수 없습니다.</span></div>}
          <div className="work-edit-grid"><Field label="근무 형태"><Select value={workStatus} disabled={!canWriteWorkCalendar} onChange={(event) => setWorkStatus(event.target.value as WorkStatus)}><option value="onsite">출근</option><option value="remote">재택</option><option value="off">휴무</option><option value="unknown">미정</option></Select></Field><Field label="근무지 이름"><Input value={destinationLabel} disabled={!canWriteWorkCalendar} onChange={(event) => setDestinationLabel(event.target.value)} placeholder="근무지 별칭" /></Field><Field label="근무지 주소"><Input value={destinationAddress} disabled={!canWriteWorkCalendar} onChange={(event) => { setDestinationAddress(event.target.value); setRoutePreview(null); }} placeholder="경로 계산에 사용할 주소" /></Field></div>
          <div className="work-drawer-actions"><Button onClick={() => void updateWorkDay()} disabled={busy || !canWriteWorkCalendar}>이 날짜 저장</Button><Button variant="ghost" onClick={() => void removeWorkOverride()} disabled={busy || !canWriteWorkCalendar || !selectedWorkDay.overridden}>수동 변경 지우기</Button><Button variant="accent" onClick={() => void previewRoute()} disabled={busy || !selectedWorkDay.destinationAddress}>경로 미리보기</Button></div>
          {routePreview && <div className="route-preview"><div><b>차량 {routePreview.car ? `${(routePreview.car.distanceM / 1000).toFixed(1)} km · 약 ${routePreview.car.durationMin}분` : '정보 없음'}</b><small>{routePreview.notice}</small></div><div className="route-actions"><Button variant="ghost" onClick={() => openRoute('publicTransit')}>대중교통</Button><Button variant="ghost" onClick={() => openRoute('walk')}>도보</Button><Button variant="ghost" onClick={() => openRoute('car')}>차량</Button></div></div>}
        </section>}
        {canManageJobs ? <div className="work-config-grid">
          <section className="work-config"><h4>엑셀 근무표 가져오기</h4><p>이름과 선택 입력인 팀은 이번 가져오기 요청에만 사용되며 브라우저 저장소에 기록하지 않습니다.</p><div className="work-edit-grid"><Field label="이름"><Input value={importPerson} onChange={(event) => setImportPerson(event.target.value)} autoComplete="off" placeholder="파일에서 찾을 이름" /></Field><Field label="팀 (선택)"><Input value={importTeam} onChange={(event) => setImportTeam(event.target.value)} autoComplete="off" placeholder="동명이인 구분이 필요할 때 입력" /></Field></div><div className="privacy-warning"><b>개인정보 안내</b><span>선택한 엑셀 파일과 입력값은 이 PC의 근무표 처리에만 사용됩니다. 실제 값은 화면 로그나 브라우저 저장소에 남기지 않습니다.</span></div><Button onClick={() => void importWorkbook()} disabled={busy || !importPerson.trim()}>PC에서 엑셀 선택</Button></section>
          <section className="work-config"><h4>집·경로 설정</h4><p>경로 계산을 위한 주소와 지도 API 설정은 PC에만 저장됩니다.</p><Field label="집 주소"><Input value={homeAddress} onChange={(event) => setHomeAddress(event.target.value)} autoComplete="street-address" placeholder="출발지 주소" /></Field><div className="work-edit-grid"><Field label={`Naver Client ID${workSettings?.naverClientIdSet ? ' (설정됨)' : ''}`}><Input type="password" value={naverClientId} onChange={(event) => setNaverClientId(event.target.value)} autoComplete="off" placeholder="새 값 입력 시에만 변경" /></Field><Field label={`Naver Client Secret${workSettings?.naverClientSecretSet ? ' (설정됨)' : ''}`}><Input type="password" value={naverClientSecret} onChange={(event) => setNaverClientSecret(event.target.value)} autoComplete="off" placeholder="새 값 입력 시에만 변경" /></Field></div><div className="consent-row"><Toggle checked={naverConsent} onChange={setNaverConsent} label="경로 계산을 위해 Naver 지도 API 사용에 동의" /><small>동의하면 선택한 날짜의 출발지·근무지 주소가 경로 계산 요청에 사용됩니다. 근무지 이름 필드는 보내지 않지만 주소 칸의 내용은 그대로 전송됩니다.</small></div><div className="work-drawer-actions"><Button onClick={() => void saveWorkSettings()} disabled={busy}>경로 설정 저장</Button><Button variant="danger" onClick={() => setClearNaverConfirmOpen(true)} disabled={busy || (!workSettings?.naverClientIdSet && !workSettings?.naverClientSecretSet)}>인증정보 삭제</Button></div></section>
        </div> : <div className="access-inline"><b>PC 전용 설정</b><span>엑셀 원본과 집·지도 인증정보는 로컬 PC 관리자 화면에서만 설정할 수 있습니다.</span></div>}
      </Card>
      <Card className="panel calendar-panel">
        <div className="panel-head"><div><span className="eyebrow">PERSONAL EVENTS</span><h3>일반 일정</h3></div><Badge tone="ok">로컬 우선 · AI 토큰 0</Badge></div>
        {!canWriteCalendar && <div className="access-inline"><b>일정 보기 모드</b><span>이 연결에서는 일정 조회만 가능합니다.</span></div>}
        <fieldset className="form-grid calendar-add permission-fieldset" disabled={!canWriteCalendar}><Field label="일정 이름"><Input value={calendarTitle} onChange={(event) => setCalendarTitle(event.target.value)} placeholder="예: 프로젝트 회의" /></Field><Field label="시작"><Input type="datetime-local" value={calendarStart} onChange={(event) => setCalendarStart(event.target.value)} /></Field><Field label="종료"><Input type="datetime-local" value={calendarEnd} onChange={(event) => setCalendarEnd(event.target.value)} /></Field><Button onClick={() => void addCalendarEvent()} disabled={busy || !calendarTitle.trim() || !calendarStart}>일정 추가</Button></fieldset>
        <div className="calendar-list">{calendarEvents.length === 0 && <div className="muted">등록된 일정이 없습니다.</div>}{calendarEvents.map((event) => <article key={event.id} className="calendar-event"><div className="calendar-date"><b>{new Date(event.startAt).toLocaleDateString('ko-KR', { month: 'short', day: 'numeric' })}</b><span>{new Date(event.startAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}</span></div><div><b>{event.title}</b><small>{new Date(event.startAt).toLocaleString('ko-KR')} – {new Date(event.endAt).toLocaleString('ko-KR')}</small></div><Button variant="danger" disabled={!canWriteCalendar} onClick={() => void removeCalendarEvent(event.id)}>삭제</Button></article>)}</div>
      </Card>
      {canManageJobs ? <Card className="panel">
        <div className="panel-head">
          <h3>예약 작업</h3>
          <Button variant="accent" onClick={() => setShowAdd((s) => !s)}>
            {showAdd ? '닫기' : '＋ 예약 추가'}
          </Button>
        </div>
        <p className="panel-hint">
          정해진 시간에 PC에서 자동 실행됩니다 (PC가 켜져 있으면 됩니다). AI 작업은 대화처럼 AI에게 시킬 일을 예약하는
          기능이에요.
        </p>

        {showAdd && (
          <div className="schedule-add">
            <div className="form-grid">
              <Field label="작업 종류">
                <Select value={type} onChange={(e) => setType(e.target.value as ScheduleJobType)}>
                  <option value="chat">AI 작업 (대화 보내기)</option>
                  <option value="shell">셸 명령</option>
                  <option value="launch">앱 실행</option>
                </Select>
              </Field>
              <Field label="이름">
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="예: 아침 브리핑" />
              </Field>
              <Field label="반복">
                <Select value={whenKind} onChange={(e) => setWhenKind(e.target.value as 'once' | 'daily')}>
                  <option value="once">일회성</option>
                  <option value="daily">반복 (매일/요일)</option>
                </Select>
              </Field>
              {whenKind === 'once' ? (
                <Field label="실행 시각">
                  <Input type="datetime-local" value={onceAt} onChange={(e) => setOnceAt(e.target.value)} />
                </Field>
              ) : (
                <Field label="실행 시각 (매일)">
                  <Input type="time" value={dailyAt} onChange={(e) => setDailyAt(e.target.value)} />
                </Field>
              )}
            </div>

            {whenKind === 'daily' && (
              <div className="day-picker">
                {DAY_NAMES.map((label, i) => (
                  <button
                    key={i}
                    type="button"
                    className={`day-chip ${days.includes(i) ? 'on' : ''}`}
                    onClick={() => toggleDay(i)}
                  >
                    {label}
                  </button>
                ))}
                <span className="panel-hint">{days.length === 0 ? '아무것도 선택하지 않으면 매일 실행' : '선택한 요일에만 실행'}</span>
              </div>
            )}

            {type === 'chat' && (
              <Field label="AI에게 시킬 일" hint="예: '시스템 상태 요약해서 저장해줘' — 위험한 작업은 실행 전 승인이 필요해요">
                <textarea
                  className="chat-input"
                  rows={3}
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  placeholder="오전 9시 뉴스 헤드라인을 요약해 바탕화면에 저장해줘"
                />
              </Field>
            )}
            {type === 'shell' && (
              <div className="form-grid">
                <Field label="명령어">
                  <Input value={command} onChange={(e) => setCommand(e.target.value)} placeholder="Get-Process | Select-Object -First 10" />
                </Field>
                <Field label="셸">
                  <Select value={shellKind} onChange={(e) => setShellKind(e.target.value as 'powershell' | 'cmd')}>
                    <option value="powershell">PowerShell</option>
                    <option value="cmd">CMD</option>
                  </Select>
                </Field>
              </div>
            )}
            {type === 'launch' && (
              <div className="form-grid">
                <Field label="대상 (앱/파일/URL)">
                  <Input value={target} onChange={(e) => setTarget(e.target.value)} placeholder="notepad 또는 https://…" />
                </Field>
                <Field label="인자 (쉼표 구분, 선택)">
                  <Input value={args} onChange={(e) => setArgs(e.target.value)} placeholder="C:\메모.txt" />
                </Field>
              </div>
            )}

            {type === 'chat' && (
              <Toggle
                checked={allowDestructive}
                onChange={setAllowDestructive}
                label="위험한 작업도 자동 승인 (예약 실행 시)"
              />
            )}

            <div className="chat-actions">
              <Button onClick={() => void add()} disabled={busy || !validJobPayload || (whenKind === 'once' && !onceAt)}>
                {busy ? '추가 중…' : '예약 추가'}
              </Button>
            </div>
          </div>
        )}
      </Card> : <Card className="panel access-locked-card"><div className="access-lock-mark">🔒</div><div><h3>예약 에이전트 작업은 PC에서 관리합니다</h3><p>자동 실행은 PC의 파일·앱·셸 권한을 사용하므로 데스크톱 관리자 연결에서만 추가·중지·삭제할 수 있습니다. 위의 일반 일정 조회는 계속 사용할 수 있습니다.</p></div></Card>}

      {canManageJobs && jobs.length === 0 && (
        <Card className="panel empty">
          <p>예약된 작업이 없습니다.</p>
        </Card>
      )}

      {canManageJobs && jobs.map((job) => (
        <Card key={job.id} className={`panel schedule-card ${!job.enabled ? 'off' : ''}`}>
          <div className="schedule-row">
            <div className="schedule-main">
              <div className="schedule-title">
                <Badge tone={TYPE_BADGE[job.type]}>{TYPE_LABEL[job.type]}</Badge>
                <span className="schedule-name">{job.name}</span>
                {!job.enabled && <Badge tone="warn">꺼짐</Badge>}
              </div>
              <div className="schedule-when">{fmtWhen(job)}</div>
              <div className="schedule-next">
                다음 실행: <b>{fmtNext(job.nextRun)}</b>
              </div>
              {job.lastRun && (
                <button className="schedule-lastrun" onClick={() => setOpenResult(openResult === job.id ? null : job.id)}>
                  마지막 실행 {new Date(job.lastRun).toLocaleString('ko-KR')} {openResult === job.id ? '▲' : '▼'}
                </button>
              )}
            </div>
            <div className="schedule-actions">
              <Toggle checked={job.enabled} onChange={(v) => void setEnabled(job.id, v)} />
              <Button variant="danger" onClick={() => void remove(job.id)}>
                삭제
              </Button>
            </div>
          </div>
          {openResult === job.id && <pre className="shell-out">{job.lastResult ?? '(결과 없음)'}</pre>}
        </Card>
      ))}
      <Modal open={clearNaverConfirmOpen} onClose={() => { if (!busy) setClearNaverConfirmOpen(false); }} title="NAVER 인증정보를 삭제할까요?">
        <div className="delete-dialog"><div className="delete-dialog-icon">!</div><div><b>다시 입력하기 전까지 경로를 조회할 수 없습니다.</b><p>이 PC에 저장된 NAVER Client ID와 Secret, 주소 전송 동의를 삭제합니다. 집 주소와 근무 일정은 유지됩니다.</p></div><div className="modal-actions"><Button variant="ghost" disabled={busy} onClick={() => setClearNaverConfirmOpen(false)}>취소</Button><Button variant="danger" disabled={busy} onClick={() => void clearNaverCredentials()}>{busy ? '삭제 중…' : '인증정보 삭제'}</Button></div></div>
      </Modal>
    </div>
  );
}
