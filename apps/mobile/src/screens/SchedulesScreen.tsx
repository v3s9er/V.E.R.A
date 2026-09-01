import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  KeyboardAvoidingView,
  Linking,
  Modal,
  Platform,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { MrRobotClient } from '../rpc';
import type { CalendarEvent, ScheduledJobView } from '../types';
import { colors, radius } from '../theme';
import { trustedNmapRoute } from '../naver-route-link';

const TYPE_LABEL: Record<string, string> = { chat: 'AI 작업', shell: '셸 명령', launch: '앱 실행' };
const DAYS = ['일', '월', '화', '수', '목', '금', '토'];

type WorkStatus = 'onsite' | 'remote' | 'off' | 'unknown';
type AdminState = 'checking' | 'admin' | 'paired' | 'error';
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
  access: { canEdit: boolean; isAdmin: boolean };
};
type RoutePreview = {
  car?: { distanceM: number; durationMin: number };
  links: { publicTransit?: string; walk?: string; car?: string };
  notice?: string;
};
type RouteSummary = Pick<RoutePreview, 'car' | 'notice'> & { date: string };

const dateKey = (year: number, month: number, day: number): string => (
  `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
);

function seoulToday(value = new Date()): { year: number; month: number; date: string } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(value);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(values.year),
    month: Number(values.month),
    date: `${values.year}-${values.month}-${values.day}`,
  };
}

function eventDateKey(value: string): string | null {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : seoulToday(parsed).date;
}

function formatSeoulDateTime(value: string): string {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? value
    : parsed.toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
}

function statusText(status: WorkStatus): string {
  return ({ onsite: '출근', remote: '재택', off: '휴무', unknown: '미정' } as const)[status];
}

function workText(day: WorkDay): string {
  return day.holidayName || (day.status === 'onsite' ? day.destinationLabel || '출근' : statusText(day.status));
}

function fmtWhen(job: ScheduledJobView): string {
  if (job.when.kind === 'once') return `일회성 · ${job.when.at}`;
  const days = job.when.days?.length ? job.when.days : [0, 1, 2, 3, 4, 5, 6];
  return `반복 · ${days.length === 7 ? '매일' : `${days.map((day) => DAYS[day]).join('·')}요일`} ${job.when.at}`;
}

function fmtNext(ts: number | null): string {
  if (ts === null) return '—';
  const diff = ts - Date.now();
  const hours = Math.round((diff / 3_600_000) * 10) / 10;
  return `${hours >= 0 ? '' : '-'}${Math.abs(hours)}시간 ${diff >= 0 ? '후' : '전'}`;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

function isAdminError(message: string): boolean {
  return /관리자 권한/.test(message);
}

function isWritePermissionError(message: string): boolean {
  return /읽기 전용|전체 허용|변경형 플러그인|권한이 없습니다|허용해 주세요/.test(message);
}

export function SchedulesScreen({
  client,
  privateWorkAuthenticated,
}: {
  client: MrRobotClient;
  privateWorkAuthenticated: boolean;
}) {
  const insets = useSafeAreaInsets();
  const initial = useMemo(seoulToday, []);
  const [seoulNow, setSeoulNow] = useState(initial);
  const [month, setMonth] = useState({ year: initial.year, month: initial.month });
  const [selected, setSelected] = useState(initial.date);
  const [calendar, setCalendar] = useState<WorkMonth | null>(null);
  const [workError, setWorkError] = useState('');
  const [showWorkEdit, setShowWorkEdit] = useState(false);
  const [editStatus, setEditStatus] = useState<WorkStatus>('onsite');
  const [editLabel, setEditLabel] = useState('');
  const [editAddress, setEditAddress] = useState('');
  const [routeSummary, setRouteSummary] = useState<RouteSummary | null>(null);

  const [calendarEvents, setCalendarEvents] = useState<CalendarEvent[]>([]);
  const [calendarWriteBlocked, setCalendarWriteBlocked] = useState(false);
  const [showCalendarAdd, setShowCalendarAdd] = useState(false);
  const [calendarTitle, setCalendarTitle] = useState('');
  const [calendarStart, setCalendarStart] = useState('');
  const [calendarEnd, setCalendarEnd] = useState('');

  const [adminState, setAdminState] = useState<AdminState>('checking');
  const [jobs, setJobs] = useState<ScheduledJobView[]>([]);
  const [showAdd, setShowAdd] = useState(false);
  const [openResult, setOpenResult] = useState<string | null>(null);
  const [type, setType] = useState<'chat' | 'shell' | 'launch'>('chat');
  const [name, setName] = useState('');
  const [whenKind, setWhenKind] = useState<'once' | 'daily'>('once');
  const [onceAt, setOnceAt] = useState('');
  const [dailyAt, setDailyAt] = useState('09:00');
  const [repeatDays, setRepeatDays] = useState<number[]>([]);
  const [prompt, setPrompt] = useState('');
  const [command, setCommand] = useState('');
  const [target, setTarget] = useState('');
  const [allowDestructive, setAllowDestructive] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState('');
  const privateWorkAuthenticatedRef = useRef(privateWorkAuthenticated);
  const privateWorkSessionGenerationRef = useRef(0);
  privateWorkAuthenticatedRef.current = privateWorkAuthenticated;

  const isCurrentPrivateWorkSession = useCallback((generation: number): boolean => (
    privateWorkAuthenticatedRef.current
      && privateWorkSessionGenerationRef.current === generation
  ), []);

  const clearPrivateWorkState = useCallback((): void => {
    const today = seoulToday();
    setCalendar(null);
    setWorkError('');
    setShowWorkEdit(false);
    setEditStatus('onsite');
    setEditLabel('');
    setEditAddress('');
    setRouteSummary(null);
    setMonth({ year: today.year, month: today.month });
    setSelected(today.date);
    setActionError('');
  }, []);

  const loadJobs = useCallback(async (): Promise<void> => {
    try {
      setJobs(await client.call('scheduler.list', {}) as ScheduledJobView[]);
      setAdminState('admin');
    } catch (error) {
      setJobs([]);
      const message = errorMessage(error, '관리자 권한을 확인하지 못했습니다.');
      setAdminState(isAdminError(message) ? 'paired' : 'error');
    }
  }, [client]);

  const loadEvents = useCallback(async (): Promise<void> => {
    try {
      setCalendarEvents(await client.call('plugins.call', {
        name: 'calendar.events.list', params: {},
      }) as CalendarEvent[]);
    } catch (error) {
      setActionError(errorMessage(error, '일반 일정을 불러오지 못했습니다.'));
    }
  }, [client]);

  const loadMonth = useCallback(async (
    year: number,
    targetMonth: number,
    sessionGeneration: number,
  ): Promise<void> => {
    if (!isCurrentPrivateWorkSession(sessionGeneration)) return;
    try {
      const next = await client.call('plugins.call', {
        name: 'calendar.work.month', params: { year, month: targetMonth },
      }) as WorkMonth;
      if (!isCurrentPrivateWorkSession(sessionGeneration)) return;
      setCalendar(next);
      setWorkError('');
    } catch (error) {
      if (!isCurrentPrivateWorkSession(sessionGeneration)) return;
      setCalendar(null);
      setWorkError(errorMessage(error, '근무 일정을 불러오지 못했습니다.'));
    }
  }, [client, isCurrentPrivateWorkSession]);

  useEffect(() => {
    void loadJobs();
    void loadEvents();
    const schedulerChanged = client.on('scheduler.changed', () => { void loadJobs(); });
    const schedulerRan = client.on('scheduler.ran', () => { void loadJobs(); });
    const calendarChanged = client.on('calendar.changed', () => { void loadEvents(); });
    return () => {
      schedulerChanged();
      schedulerRan();
      calendarChanged();
    };
  }, [client, loadEvents, loadJobs]);

  useLayoutEffect(() => {
    if (!privateWorkAuthenticated) {
      privateWorkSessionGenerationRef.current += 1;
      clearPrivateWorkState();
    }
  }, [clearPrivateWorkState, privateWorkAuthenticated]);

  useEffect(() => {
    if (!privateWorkAuthenticated) return undefined;
    const sessionGeneration = ++privateWorkSessionGenerationRef.current;

    void loadMonth(month.year, month.month, sessionGeneration);
    const refresh = setInterval(() => {
      void loadMonth(month.year, month.month, sessionGeneration);
    }, 5 * 60_000);
    const calendarChanged = client.on('calendar.work.changed', () => {
      void loadMonth(month.year, month.month, sessionGeneration);
    });
    return () => {
      clearInterval(refresh);
      calendarChanged();
      if (privateWorkSessionGenerationRef.current === sessionGeneration) {
        privateWorkSessionGenerationRef.current += 1;
      }
    };
  }, [
    client,
    loadMonth,
    month.month,
    month.year,
    privateWorkAuthenticated,
  ]);

  useEffect(() => {
    const clock = setInterval(() => setSeoulNow(seoulToday()), 60_000);
    return () => clearInterval(clock);
  }, []);

  const visibleCalendar = privateWorkAuthenticated ? calendar : null;
  const visibleWorkError = privateWorkAuthenticated ? workError : '';
  const byDate = useMemo(() => new Map((visibleCalendar?.days ?? []).map((day) => [day.date, day])), [visibleCalendar]);
  const selectedDay = byDate.get(selected);
  const isAdmin = adminState === 'admin';
  const canEditWork = privateWorkAuthenticated && visibleCalendar?.access.canEdit === true;

  const eventCounts = useMemo(() => {
    const result = new Map<string, number>();
    for (const event of calendarEvents) {
      const key = eventDateKey(event.startAt);
      if (key) result.set(key, (result.get(key) ?? 0) + 1);
    }
    return result;
  }, [calendarEvents]);

  const grid = useMemo(() => {
    const first = new Date(Date.UTC(month.year, month.month - 1, 1)).getUTCDay();
    const count = new Date(Date.UTC(month.year, month.month, 0)).getUTCDate();
    const cells = Math.ceil((first + count) / 7) * 7;
    return Array.from({ length: cells }, (_, index) => {
      const day = index - first + 1;
      return day < 1 || day > count ? null : dateKey(month.year, month.month, day);
    });
  }, [month.month, month.year]);

  const changeMonth = (delta: number): void => {
    const date = new Date(Date.UTC(month.year, month.month - 1 + delta, 1));
    const next = { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1 };
    setMonth(next);
    setSelected(dateKey(next.year, next.month, 1));
    setActionError('');
    setRouteSummary(null);
  };

  const goToday = (): void => {
    const today = seoulToday();
    setSeoulNow(today);
    setMonth({ year: today.year, month: today.month });
    setSelected(today.date);
    setActionError('');
    setRouteSummary(null);
  };

  const selectDate = (date: string): void => {
    setSelected(date);
    setActionError('');
    setRouteSummary(null);
  };

  const editWork = (): void => {
    if (!privateWorkAuthenticatedRef.current || !canEditWork) return;
    setEditStatus(selectedDay?.status === 'unknown' ? 'onsite' : selectedDay?.status ?? 'onsite');
    setEditLabel(selectedDay?.destinationLabel ?? '');
    setEditAddress(selectedDay?.destinationAddress ?? '');
    setActionError('');
    setShowWorkEdit(true);
  };

  const markWorkReadOnly = (): void => {
    if (!privateWorkAuthenticatedRef.current) return;
    setCalendar((current) => current ? {
      ...current,
      access: { ...current.access, canEdit: false },
    } : current);
  };

  const saveWork = async (): Promise<void> => {
    if (busy || !canEditWork) return;
    const sessionGeneration = privateWorkSessionGenerationRef.current;
    if (!isCurrentPrivateWorkSession(sessionGeneration)) return;
    setBusy(true);
    setActionError('');
    try {
      await client.call('plugins.call', {
        name: 'calendar.work.override.set',
        params: {
          date: selected,
          status: editStatus,
          destinationLabel: editStatus === 'onsite' ? editLabel.trim() || undefined : undefined,
          destinationAddress: editStatus === 'onsite' ? editAddress.trim() || undefined : undefined,
        },
      });
      if (!isCurrentPrivateWorkSession(sessionGeneration)) return;
      setShowWorkEdit(false);
      await loadMonth(month.year, month.month, sessionGeneration);
    } catch (error) {
      if (!isCurrentPrivateWorkSession(sessionGeneration)) return;
      const message = errorMessage(error, '수동 변경을 저장하지 못했습니다.');
      if (isWritePermissionError(message)) markWorkReadOnly();
      setActionError(message);
    } finally {
      setBusy(false);
    }
  };

  const restoreWork = async (): Promise<void> => {
    if (busy || !canEditWork) return;
    const sessionGeneration = privateWorkSessionGenerationRef.current;
    if (!isCurrentPrivateWorkSession(sessionGeneration)) return;
    setBusy(true);
    setActionError('');
    try {
      await client.call('plugins.call', {
        name: 'calendar.work.override.remove', params: { date: selected },
      });
      if (!isCurrentPrivateWorkSession(sessionGeneration)) return;
      setShowWorkEdit(false);
      await loadMonth(month.year, month.month, sessionGeneration);
    } catch (error) {
      if (!isCurrentPrivateWorkSession(sessionGeneration)) return;
      const message = errorMessage(error, '기본값을 복원하지 못했습니다.');
      if (isWritePermissionError(message)) markWorkReadOnly();
      setActionError(message);
    } finally {
      setBusy(false);
    }
  };

  const openRoute = async (mode: 'publicTransit' | 'walk' | 'car'): Promise<void> => {
    if (busy || selectedDay?.status !== 'onsite') return;
    const sessionGeneration = privateWorkSessionGenerationRef.current;
    if (!isCurrentPrivateWorkSession(sessionGeneration)) return;
    setBusy(true);
    setActionError('');
    try {
      const preview = await client.call('plugins.call', {
        name: 'calendar.work.route.preview', params: { date: selected },
      }) as RoutePreview;
      if (!isCurrentPrivateWorkSession(sessionGeneration)) return;
      setRouteSummary({ date: selected, car: preview.car, notice: preview.notice });
      const url = trustedNmapRoute(preview.links[mode], mode);
      if (!url) {
        throw new Error('네이버 지도 경로 링크를 준비하지 못했습니다.');
      }
      if (!isCurrentPrivateWorkSession(sessionGeneration)) return;
      await Linking.openURL(url);
    } catch (error) {
      if (!isCurrentPrivateWorkSession(sessionGeneration)) return;
      setActionError(errorMessage(error, '경로를 열지 못했습니다.'));
    } finally {
      setBusy(false);
    }
  };

  const openCalendarAdd = (): void => {
    setCalendarStart(`${selected} 09:00`);
    setCalendarEnd(`${selected} 10:00`);
    setActionError('');
    setShowCalendarAdd(true);
  };

  const addCalendar = async (): Promise<void> => {
    if (busy || calendarWriteBlocked || !calendarTitle.trim() || !calendarStart.trim()) return;
    setBusy(true);
    setActionError('');
    try {
      await client.call('plugins.call', {
        name: 'calendar.events.add',
        params: {
          title: calendarTitle.trim(),
          startAt: calendarStart.trim(),
          endAt: calendarEnd.trim() || calendarStart.trim(),
          allDay: false,
        },
      });
      setShowCalendarAdd(false);
      setCalendarTitle('');
      setCalendarStart('');
      setCalendarEnd('');
      await loadEvents();
    } catch (error) {
      const message = errorMessage(error, '일정을 추가하지 못했습니다.');
      if (isWritePermissionError(message)) setCalendarWriteBlocked(true);
      setActionError(message);
    } finally {
      setBusy(false);
    }
  };

  const removeCalendar = async (id: string): Promise<void> => {
    if (busy || calendarWriteBlocked) return;
    setBusy(true);
    setActionError('');
    try {
      await client.call('plugins.call', { name: 'calendar.events.remove', params: { id } });
      await loadEvents();
    } catch (error) {
      const message = errorMessage(error, '일정을 삭제하지 못했습니다.');
      if (isWritePermissionError(message)) setCalendarWriteBlocked(true);
      setActionError(message);
    } finally {
      setBusy(false);
    }
  };

  const addJob = async (): Promise<void> => {
    if (busy || !isAdmin) return;
    setBusy(true);
    setActionError('');
    try {
      await client.call('scheduler.add', {
        name: name.trim() || TYPE_LABEL[type],
        type,
        prompt: type === 'chat' ? prompt.trim() : undefined,
        command: type === 'shell' ? command : undefined,
        target: type === 'launch' ? target.trim() : undefined,
        whenKind,
        at: whenKind === 'once' ? onceAt : dailyAt,
        days: repeatDays,
        allowDestructive,
      });
      setShowAdd(false);
      setName('');
      setPrompt('');
      setCommand('');
      setTarget('');
      await loadJobs();
    } catch (error) {
      setActionError(errorMessage(error, '예약을 추가하지 못했습니다.'));
    } finally {
      setBusy(false);
    }
  };

  const removeJob = async (id: string): Promise<void> => {
    if (busy || !isAdmin) return;
    setBusy(true);
    setActionError('');
    try {
      await client.call('scheduler.remove', { id });
      await loadJobs();
    } catch (error) {
      setActionError(errorMessage(error, '예약을 삭제하지 못했습니다.'));
    } finally {
      setBusy(false);
    }
  };

  const setJobEnabled = async (id: string, enabled: boolean): Promise<void> => {
    if (busy || !isAdmin) return;
    setBusy(true);
    setActionError('');
    try {
      await client.call('scheduler.setEnabled', { id, enabled });
      await loadJobs();
    } catch (error) {
      setActionError(errorMessage(error, '예약 상태를 변경하지 못했습니다.'));
    } finally {
      setBusy(false);
    }
  };

  const toggleRepeatDay = (day: number): void => {
    setRepeatDays((current) => (
      current.includes(day) ? current.filter((item) => item !== day) : [...current, day].sort()
    ));
  };

  return (
    <View style={styles.root}>
      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: Math.max(insets.bottom, 20) + 12 }]}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.calendarCard}>
          <View style={styles.calendarHead}>
            <View>
              <Text style={styles.eyebrow}>WORK CALENDAR</Text>
              <Text style={styles.title} accessibilityRole="header">근무 일정</Text>
            </View>
            <TouchableOpacity
              style={styles.todayButton}
              onPress={goToday}
              accessibilityRole="button"
              accessibilityLabel="오늘 날짜로 이동"
            >
              <Text style={styles.todayText}>오늘</Text>
            </TouchableOpacity>
          </View>
          <Text style={styles.privacy}>원본 엑셀은 모바일에 전송하지 않습니다. PC에서 만든 암호화 파생 일정만 조회합니다.</Text>
          <View style={styles.monthNav}>
            <TouchableOpacity style={styles.arrow} accessibilityRole="button" accessibilityLabel="이전 달" onPress={() => changeMonth(-1)}>
              <Text style={styles.arrowText}>‹</Text>
            </TouchableOpacity>
            <Text style={styles.monthTitle} accessibilityRole="header">{month.year}년 {month.month}월</Text>
            <TouchableOpacity style={styles.arrow} accessibilityRole="button" accessibilityLabel="다음 달" onPress={() => changeMonth(1)}>
              <Text style={styles.arrowText}>›</Text>
            </TouchableOpacity>
          </View>
          <View style={styles.weekRow}>
            {DAYS.map((day, index) => (
              <Text key={day} style={[styles.weekName, index === 0 && styles.sun, index === 6 && styles.sat]}>{day}</Text>
            ))}
          </View>
          <View style={styles.grid}>
            {grid.map((date, index) => {
              if (!date) return <View key={`blank-${index}`} style={styles.dayCell} accessibilityElementsHidden />;
              const day = byDate.get(date);
              const weekday = index % 7;
              const eventCount = eventCounts.get(date) ?? 0;
              const isSelected = selected === date;
              const label = [
                `${month.year}년 ${month.month}월 ${Number(date.slice(-2))}일 ${DAYS[weekday]}요일`,
                day ? workText(day) : '근무 일정 없음',
                eventCount ? `일반 일정 ${eventCount}개` : '',
              ].filter(Boolean).join(', ');
              return (
                <TouchableOpacity
                  key={date}
                  style={[styles.dayCell, isSelected && styles.selectedCell]}
                  onPress={() => selectDate(date)}
                  accessibilityRole="button"
                  accessibilityLabel={label}
                  accessibilityHint="선택한 날짜의 상세 일정을 표시합니다"
                  accessibilityState={{ selected: isSelected }}
                >
                  <Text style={[
                    styles.number,
                    weekday === 0 && styles.sun,
                    weekday === 6 && styles.sat,
                    day?.holidayName && styles.sun,
                    date === (visibleCalendar?.today ?? seoulNow.date) && styles.todayNumber,
                  ]}>
                    {Number(date.slice(-2))}
                  </Text>
                  <Text numberOfLines={1} style={[
                    styles.workName,
                    day?.status === 'onsite' && styles.onsite,
                    day?.status === 'remote' && styles.remote,
                  ]}>
                    {day ? workText(day) : ''}
                  </Text>
                  {eventCount > 0 && <Text style={styles.eventCount}>+{eventCount}</Text>}
                  {day && (day.status === 'onsite' || day.status === 'remote') && (
                    <View style={[styles.dot, day.status === 'onsite' ? styles.onsiteDot : styles.remoteDot]} />
                  )}
                </TouchableOpacity>
              );
            })}
          </View>
          {!privateWorkAuthenticated ? (
            <Text style={styles.permissionNote}>PC 인증 연결이 복구되면 근무 일정을 다시 불러옵니다.</Text>
          ) : !visibleCalendar?.configured && !visibleWorkError ? (
            <Text style={styles.configure}>PC에서 근무 일정 연동을 설정하면 표시됩니다. 설정과 엑셀 가져오기는 PC에서만 할 수 있습니다.</Text>
          ) : null}
          {visibleWorkError ? (
            <Text style={styles.permissionNote} accessibilityRole="alert">{visibleWorkError}</Text>
          ) : visibleCalendar && !canEditWork ? (
            <Text style={styles.permissionNote}>이 기기는 근무 일정을 조회만 할 수 있습니다. 수정 권한은 PC의 연결 기기 설정에서 변경할 수 있습니다.</Text>
          ) : null}
        </View>

        <View style={styles.detail}>
          <View style={styles.detailHeader}>
            <View>
              <Text style={styles.detailDate} accessibilityRole="header">{selected}</Text>
              <Text style={styles.detailStatus}>
                {selectedDay ? statusText(selectedDay.status) : '일정 없음'}{selectedDay?.overridden ? ' · 수동 변경됨' : ''}
              </Text>
            </View>
            {canEditWork && (
              <TouchableOpacity
                style={styles.edit}
                onPress={editWork}
                accessibilityRole="button"
                accessibilityLabel={`${selected} 근무 일정 수동 변경`}
              >
                <Text style={styles.editText}>수동 변경</Text>
              </TouchableOpacity>
            )}
          </View>
          {selectedDay?.holidayName ? <Text style={styles.holiday}>{selectedDay.holidayName}</Text> : null}
          {selectedDay?.status === 'onsite' ? (
            <>
              <Text style={styles.destination}>{selectedDay.destinationLabel || '출근지 미정'}</Text>
              {selectedDay.destinationAddress && <Text style={styles.address}>{selectedDay.destinationAddress}</Text>}
              <View style={styles.routeRow}>
                {([['publicTransit', '대중교통'], ['walk', '도보'], ['car', '자동차']] as const).map(([mode, text]) => (
                  <TouchableOpacity
                    key={mode}
                    style={[styles.route, busy && styles.dim]}
                    onPress={() => { void openRoute(mode); }}
                    disabled={busy}
                    accessibilityRole="button"
                    accessibilityLabel={`네이버 지도에서 ${text} 경로 열기`}
                    accessibilityState={{ disabled: busy }}
                  >
                    <Text style={styles.routeText}>{text}</Text>
                  </TouchableOpacity>
                ))}
              </View>
              {routeSummary?.date === selected && routeSummary.car && (
                <Text style={styles.routeSummary}>
                  자동차 약 {(routeSummary.car.distanceM / 1000).toFixed(1)}km · {routeSummary.car.durationMin}분
                </Text>
              )}
              <Text style={styles.hint}>
                {routeSummary?.date === selected && routeSummary.notice
                  ? routeSummary.notice
                  : '네이버 지도 앱의 공식 경로 링크로 엽니다. 조회 결과는 저장하지 않습니다.'}
              </Text>
            </>
          ) : (
            <Text style={styles.detailEmpty}>{selectedDay ? workText(selectedDay) : '이 날짜의 근무 일정이 없습니다.'}</Text>
          )}
        </View>

        <View style={styles.generalCard}>
          <View style={styles.calendarHead}>
            <View>
              <Text style={styles.eyebrow}>LOCAL CALENDAR</Text>
              <Text style={styles.sectionTitle} accessibilityRole="header">일반 일정</Text>
            </View>
            {!calendarWriteBlocked && (
              <TouchableOpacity style={styles.secondaryAdd} onPress={openCalendarAdd} accessibilityRole="button" accessibilityLabel="일반 일정 추가">
                <Text style={styles.secondaryAddText}>＋ 일정</Text>
              </TouchableOpacity>
            )}
          </View>
          <Text style={styles.privacy}>PC에 로컬 저장되는 개인 약속입니다. 근무표와 별도로 관리됩니다.</Text>
          {calendarWriteBlocked && (
            <Text style={styles.permissionNote}>이 연결 기기는 일반 일정을 조회만 할 수 있습니다. PC에서 기기 권한을 변경해 주세요.</Text>
          )}
          {calendarEvents.length === 0 ? (
            <Text style={styles.detailEmpty}>등록된 일반 일정이 없습니다.</Text>
          ) : calendarEvents.slice(0, 12).map((event) => (
            <View key={event.id} style={styles.calendarRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.jobName}>{event.title}</Text>
                <Text style={styles.jobWhen}>{formatSeoulDateTime(event.startAt)}</Text>
              </View>
              {!calendarWriteBlocked && (
                <TouchableOpacity
                  onPress={() => { void removeCalendar(event.id); }}
                  disabled={busy}
                  accessibilityRole="button"
                  accessibilityLabel={`${event.title} 일정 삭제`}
                  accessibilityState={{ disabled: busy }}
                >
                  <Text style={styles.deleteText}>삭제</Text>
                </TouchableOpacity>
              )}
            </View>
          ))}
        </View>

        <View style={styles.schedulerHead}>
          <View>
            <Text style={styles.eyebrow}>AUTOMATION</Text>
            <Text style={styles.sectionTitle} accessibilityRole="header">자동 예약 작업</Text>
          </View>
          {isAdmin && (
            <TouchableOpacity
              style={styles.addBtn}
              onPress={() => { setActionError(''); setShowAdd(true); }}
              accessibilityRole="button"
              accessibilityLabel="자동 예약 작업 추가"
            >
              <Text style={styles.addText}>＋ 예약</Text>
            </TouchableOpacity>
          )}
        </View>
        {adminState === 'checking' && <Text style={styles.permissionNote}>관리자 권한을 확인하는 중입니다.</Text>}
        {adminState === 'paired' && <Text style={styles.permissionNote}>자동 예약 작업은 PC 관리자 연결에서만 추가·변경·삭제할 수 있습니다.</Text>}
        {adminState === 'error' && (
          <Text style={styles.permissionNote} accessibilityRole="alert">자동 예약 작업의 관리자 권한을 확인하지 못했습니다. 연결을 확인해 주세요.</Text>
        )}
        {isAdmin && jobs.length === 0 && <Text style={styles.empty}>예약된 작업이 없습니다.</Text>}
        {isAdmin && jobs.map((job) => (
          <View key={job.id} style={[styles.card, !job.enabled && styles.off]}>
            <View style={styles.cardHead}>
              <View style={{ flex: 1 }}>
                <Text style={styles.jobName}>{TYPE_LABEL[job.type]} · {job.name}</Text>
                <Text style={styles.jobWhen}>{fmtWhen(job)}</Text>
                <Text style={styles.jobNext}>다음 실행: {fmtNext(job.nextRun)}</Text>
              </View>
              <Switch
                value={job.enabled}
                onValueChange={(enabled) => { void setJobEnabled(job.id, enabled); }}
                disabled={busy}
                trackColor={{ true: colors.accent, false: colors.border }}
                thumbColor="#fff"
                accessibilityLabel={`${job.name} 예약 ${job.enabled ? '끄기' : '켜기'}`}
                accessibilityState={{ checked: job.enabled, disabled: busy }}
              />
            </View>
            {job.lastRun && (
              <TouchableOpacity
                onPress={() => setOpenResult(openResult === job.id ? null : job.id)}
                accessibilityRole="button"
                accessibilityState={{ expanded: openResult === job.id }}
                accessibilityLabel={`${job.name} 마지막 실행 결과 ${openResult === job.id ? '접기' : '펼치기'}`}
              >
                <Text style={styles.lastRun}>
                  마지막 실행 {new Date(job.lastRun).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })} {openResult === job.id ? '▲' : '▼'}
                </Text>
              </TouchableOpacity>
            )}
            {openResult === job.id && <Text style={styles.result}>{job.lastResult ?? '(결과 없음)'}</Text>}
            <TouchableOpacity
              style={styles.delete}
              onPress={() => { void removeJob(job.id); }}
              disabled={busy}
              accessibilityRole="button"
              accessibilityLabel={`${job.name} 예약 삭제`}
              accessibilityState={{ disabled: busy }}
            >
              <Text style={styles.deleteText}>삭제</Text>
            </TouchableOpacity>
          </View>
        ))}
        {actionError ? <Text style={styles.error} accessibilityRole="alert">{actionError}</Text> : null}
      </ScrollView>

      <Modal visible={privateWorkAuthenticated && showWorkEdit && canEditWork} animationType="slide" transparent onRequestClose={() => setShowWorkEdit(false)} accessibilityViewIsModal>
        <Sheet insets={insets}>
          <Text style={styles.modalTitle} accessibilityRole="header">{selected} 수동 변경</Text>
          <Text style={styles.hint}>PC의 기본 일정은 유지하고, 이 날짜만 덮어씁니다.</Text>
          <View style={styles.chips}>
            {(['onsite', 'remote', 'off', 'unknown'] as WorkStatus[]).map((status) => (
              <Chip key={status} label={statusText(status)} active={editStatus === status} onPress={() => setEditStatus(status)} />
            ))}
          </View>
          {editStatus === 'onsite' && (
            <>
              <Text style={styles.label}>출근지 이름</Text>
              <TextInput style={styles.input} value={editLabel} onChangeText={setEditLabel} placeholder="예: 업무 장소" placeholderTextColor={colors.faint} accessibilityLabel="출근지 이름" />
              <Text style={styles.label}>주소</Text>
              <TextInput style={styles.input} value={editAddress} onChangeText={setEditAddress} placeholder="도로명 또는 지번 주소" placeholderTextColor={colors.faint} accessibilityLabel="출근지 주소" />
            </>
          )}
          {actionError ? <Text style={styles.error} accessibilityRole="alert">{actionError}</Text> : null}
          <View style={styles.actions}>
            {selectedDay?.overridden && (
              <TouchableOpacity style={[styles.action, styles.restore, busy && styles.dim]} onPress={() => { void restoreWork(); }} disabled={busy || !canEditWork} accessibilityRole="button" accessibilityLabel="기본 일정으로 복원">
                <Text style={styles.addText}>복원</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity style={[styles.action, styles.cancel]} onPress={() => setShowWorkEdit(false)} accessibilityRole="button">
              <Text style={styles.addText}>취소</Text>
            </TouchableOpacity>
            <TouchableOpacity style={[styles.action, (busy || !canEditWork) && styles.dim]} onPress={() => { void saveWork(); }} disabled={busy || !canEditWork} accessibilityRole="button">
              <Text style={styles.addText}>{busy ? '저장 중…' : '저장'}</Text>
            </TouchableOpacity>
          </View>
        </Sheet>
      </Modal>

      <Modal visible={showCalendarAdd && !calendarWriteBlocked} animationType="slide" transparent onRequestClose={() => setShowCalendarAdd(false)} accessibilityViewIsModal>
        <Sheet insets={insets}>
          <Text style={styles.modalTitle} accessibilityRole="header">일정 추가</Text>
          <Text style={styles.label}>이름</Text>
          <TextInput style={styles.input} value={calendarTitle} onChangeText={setCalendarTitle} placeholder="예: 프로젝트 회의" placeholderTextColor={colors.faint} accessibilityLabel="일정 이름" />
          <Text style={styles.label}>시작 (YYYY-MM-DD HH:MM)</Text>
          <TextInput style={styles.input} value={calendarStart} onChangeText={setCalendarStart} placeholder="2026-09-01 09:00" placeholderTextColor={colors.faint} accessibilityLabel="일정 시작 시각" />
          <Text style={styles.label}>종료</Text>
          <TextInput style={styles.input} value={calendarEnd} onChangeText={setCalendarEnd} placeholder="2026-09-01 10:00" placeholderTextColor={colors.faint} accessibilityLabel="일정 종료 시각" />
          {actionError ? <Text style={styles.error} accessibilityRole="alert">{actionError}</Text> : null}
          <View style={styles.actions}>
            <TouchableOpacity style={[styles.action, styles.cancel]} onPress={() => setShowCalendarAdd(false)} accessibilityRole="button">
              <Text style={styles.addText}>취소</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.action, (busy || !calendarTitle.trim() || !calendarStart.trim()) && styles.dim]}
              onPress={() => { void addCalendar(); }}
              disabled={busy || !calendarTitle.trim() || !calendarStart.trim()}
              accessibilityRole="button"
            >
              <Text style={styles.addText}>{busy ? '추가 중…' : '추가'}</Text>
            </TouchableOpacity>
          </View>
        </Sheet>
      </Modal>

      <Modal visible={showAdd && isAdmin} animationType="slide" transparent onRequestClose={() => setShowAdd(false)} accessibilityViewIsModal>
        <Sheet insets={insets}>
          <Text style={styles.modalTitle} accessibilityRole="header">예약 추가</Text>
          <View style={styles.chips}>
            {(['chat', 'shell', 'launch'] as const).map((item) => (
              <Chip key={item} label={TYPE_LABEL[item]} active={type === item} onPress={() => setType(item)} />
            ))}
          </View>
          <Text style={styles.label}>이름</Text>
          <TextInput style={styles.input} value={name} onChangeText={setName} placeholder="예: 아침 브리핑" placeholderTextColor={colors.faint} accessibilityLabel="예약 이름" />
          <View style={styles.chips}>
            {(['once', 'daily'] as const).map((item) => (
              <Chip key={item} label={item === 'once' ? '일회성' : '반복'} active={whenKind === item} onPress={() => setWhenKind(item)} />
            ))}
          </View>
          {whenKind === 'once' ? (
            <>
              <Text style={styles.label}>실행 시각 (YYYY-MM-DD HH:MM)</Text>
              <TextInput style={styles.input} value={onceAt} onChangeText={setOnceAt} placeholder="2026-09-01 09:00" placeholderTextColor={colors.faint} accessibilityLabel="일회성 예약 실행 시각" />
            </>
          ) : (
            <>
              <Text style={styles.label}>실행 시각 (HH:MM)</Text>
              <TextInput style={styles.input} value={dailyAt} onChangeText={setDailyAt} placeholder="09:00" placeholderTextColor={colors.faint} accessibilityLabel="반복 예약 실행 시각" />
              <View style={styles.chips}>
                {DAYS.map((label, day) => (
                  <Chip key={label} label={label} active={repeatDays.includes(day)} compact onPress={() => toggleRepeatDay(day)} />
                ))}
              </View>
              <Text style={styles.hint}>요일을 선택하지 않으면 매일 실행</Text>
            </>
          )}
          {type === 'chat' && (
            <>
              <Text style={styles.label}>AI에게 시킬 일</Text>
              <TextInput style={[styles.input, { minHeight: 70 }]} value={prompt} onChangeText={setPrompt} multiline placeholder="오전 9시 뉴스 요약해서 바탕화면에 저장해줘" placeholderTextColor={colors.faint} accessibilityLabel="AI 예약 작업 내용" />
              <View style={styles.switchRow}>
                <Text style={styles.label}>위험한 작업 자동 승인</Text>
                <Switch value={allowDestructive} onValueChange={setAllowDestructive} trackColor={{ true: colors.accent, false: colors.border }} thumbColor="#fff" accessibilityLabel="위험한 작업 자동 승인" />
              </View>
            </>
          )}
          {type === 'shell' && (
            <>
              <Text style={styles.label}>명령어</Text>
              <TextInput style={styles.input} value={command} onChangeText={setCommand} autoCapitalize="none" placeholder="Get-Process | Select-Object -First 10" placeholderTextColor={colors.faint} accessibilityLabel="셸 예약 명령어" />
            </>
          )}
          {type === 'launch' && (
            <>
              <Text style={styles.label}>앱/파일/URL</Text>
              <TextInput style={styles.input} value={target} onChangeText={setTarget} autoCapitalize="none" placeholder="notepad 또는 https://…" placeholderTextColor={colors.faint} accessibilityLabel="예약 실행 대상" />
            </>
          )}
          {actionError ? <Text style={styles.error} accessibilityRole="alert">{actionError}</Text> : null}
          <View style={styles.actions}>
            <TouchableOpacity style={[styles.action, styles.cancel]} onPress={() => setShowAdd(false)} accessibilityRole="button">
              <Text style={styles.addText}>취소</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.action, (busy || (whenKind === 'once' && !onceAt.trim())) && styles.dim]}
              onPress={() => { void addJob(); }}
              disabled={busy || (whenKind === 'once' && !onceAt.trim())}
              accessibilityRole="button"
            >
              <Text style={styles.addText}>{busy ? '추가 중…' : '예약 추가'}</Text>
            </TouchableOpacity>
          </View>
        </Sheet>
      </Modal>
    </View>
  );
}

function Chip({ label, active, compact, onPress }: {
  label: string;
  active: boolean;
  compact?: boolean;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity
      style={[styles.chip, compact && styles.compactChip, active && styles.chipOn]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: active }}
    >
      <Text style={[styles.chipText, active && styles.chipTextOn]}>{label}</Text>
    </TouchableOpacity>
  );
}

function Sheet({ children, insets }: { children: ReactNode; insets: { bottom: number } }) {
  return (
    <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === 'ios' ? 'padding' : 'height'}>
      <View style={[styles.backdrop, { paddingBottom: Math.max(insets.bottom, 8) }]}>
        <ScrollView style={styles.sheet} contentContainerStyle={styles.sheetContent} keyboardShouldPersistTaps="handled">
          {children}
        </ScrollView>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: { padding: 14, gap: 12 },
  calendarCard: { backgroundColor: colors.card, borderWidth: 1, borderColor: 'rgba(124,92,255,.45)', borderRadius: radius.md, padding: 14, gap: 9 },
  calendarHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  eyebrow: { color: colors.accent2, fontSize: 10, fontWeight: '800', letterSpacing: 1.2 },
  title: { color: colors.text, fontSize: 19, fontWeight: '800', marginTop: 2 },
  sectionTitle: { color: colors.text, fontSize: 17, fontWeight: '800', marginTop: 2 },
  todayButton: { borderColor: colors.accent, borderWidth: 1, borderRadius: radius.sm, paddingHorizontal: 11, paddingVertical: 7 },
  todayText: { color: colors.text, fontSize: 12, fontWeight: '700' },
  privacy: { color: colors.faint, fontSize: 11.5, lineHeight: 16 },
  monthNav: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  arrow: { width: 36, height: 32, borderRadius: radius.sm, backgroundColor: colors.inputBg, alignItems: 'center', justifyContent: 'center' },
  arrowText: { color: colors.text, fontSize: 25, lineHeight: 27 },
  monthTitle: { color: colors.text, fontSize: 16, fontWeight: '800' },
  weekRow: { flexDirection: 'row' },
  weekName: { width: '14.2857%', color: colors.dim, textAlign: 'center', fontSize: 11, fontWeight: '700' },
  sun: { color: '#f87171' },
  sat: { color: '#79b8ff' },
  grid: { flexDirection: 'row', flexWrap: 'wrap' },
  dayCell: { width: '14.2857%', minHeight: 62, alignItems: 'center', paddingTop: 5, borderRadius: radius.sm },
  selectedCell: { borderWidth: 1, borderColor: colors.accent, backgroundColor: 'rgba(124,92,255,.26)' },
  number: { color: colors.text, fontSize: 12, fontWeight: '700' },
  todayNumber: { color: '#fff', backgroundColor: colors.accent, borderRadius: 12, overflow: 'hidden', paddingHorizontal: 5, paddingVertical: 1 },
  workName: { maxWidth: '100%', paddingHorizontal: 2, marginTop: 4, color: colors.faint, fontSize: 9.5 },
  onsite: { color: '#b9e8b0' },
  remote: { color: '#9fd3ff' },
  eventCount: { color: colors.accent2, fontSize: 8.5, fontWeight: '800', marginTop: 1 },
  dot: { width: 4, height: 4, borderRadius: 2, marginTop: 2 },
  onsiteDot: { backgroundColor: '#73d66c' },
  remoteDot: { backgroundColor: '#6eb8ff' },
  configure: { backgroundColor: colors.inputBg, borderRadius: radius.sm, color: colors.faint, fontSize: 11.5, lineHeight: 16, padding: 9 },
  permissionNote: { backgroundColor: 'rgba(251,191,36,.10)', borderColor: 'rgba(251,191,36,.28)', borderWidth: 1, borderRadius: radius.sm, color: colors.warn, fontSize: 11.5, lineHeight: 16, padding: 9 },
  error: { color: colors.err, fontSize: 12.5, lineHeight: 17 },
  detail: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: 14, gap: 7 },
  detailHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
  detailDate: { color: colors.text, fontSize: 15, fontWeight: '800' },
  detailStatus: { color: colors.dim, fontSize: 12, marginTop: 2 },
  edit: { borderWidth: 1, borderColor: colors.border, backgroundColor: colors.inputBg, borderRadius: radius.sm, paddingHorizontal: 10, paddingVertical: 7 },
  editText: { color: colors.text, fontWeight: '700', fontSize: 12 },
  holiday: { color: '#f87171', fontSize: 12.5, fontWeight: '700' },
  destination: { color: colors.text, fontSize: 15, fontWeight: '700' },
  address: { color: colors.dim, fontSize: 12 },
  detailEmpty: { color: colors.faint, fontSize: 12.5 },
  routeRow: { flexDirection: 'row', gap: 7, marginTop: 3 },
  route: { flex: 1, alignItems: 'center', backgroundColor: 'rgba(55,196,135,.14)', borderWidth: 1, borderColor: 'rgba(55,196,135,.45)', borderRadius: radius.sm, paddingVertical: 9 },
  routeText: { color: '#b9e8b0', fontWeight: '700', fontSize: 12 },
  routeSummary: { color: '#b9e8b0', fontSize: 12.5, fontWeight: '700' },
  hint: { color: colors.faint, fontSize: 11.5, lineHeight: 16 },
  generalCard: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: 14, gap: 8 },
  secondaryAdd: { backgroundColor: 'rgba(124,92,255,.22)', borderWidth: 1, borderColor: colors.accent, borderRadius: radius.sm, paddingHorizontal: 11, paddingVertical: 7 },
  secondaryAddText: { color: colors.text, fontSize: 12, fontWeight: '700' },
  calendarRow: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingTop: 8, borderTopWidth: 1, borderTopColor: colors.border },
  schedulerHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8, marginTop: 2 },
  addBtn: { backgroundColor: colors.accent, borderRadius: radius.sm, paddingHorizontal: 12, paddingVertical: 9, alignItems: 'center' },
  addText: { color: '#fff', fontSize: 14, fontWeight: '700' },
  empty: { color: colors.faint, textAlign: 'center', paddingVertical: 12 },
  card: { backgroundColor: colors.card, borderWidth: 1, borderColor: colors.border, borderRadius: radius.md, padding: 14, gap: 8 },
  off: { opacity: 0.6 },
  cardHead: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  jobName: { color: colors.text, fontSize: 14.5, fontWeight: '700' },
  jobWhen: { color: colors.dim, fontSize: 12.5, marginTop: 2 },
  jobNext: { color: colors.faint, fontSize: 12, marginTop: 2 },
  lastRun: { color: colors.faint, fontSize: 12 },
  result: { color: '#b9e8b0', backgroundColor: colors.inputBg, borderRadius: radius.sm, padding: 8, fontSize: 11.5, lineHeight: 17 },
  delete: { alignSelf: 'flex-start', backgroundColor: 'rgba(248,113,113,.15)', borderRadius: radius.sm, paddingHorizontal: 12, paddingVertical: 7 },
  deleteText: { color: colors.err, fontSize: 12.5, fontWeight: '700' },
  backdrop: { flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(4,6,12,.7)' },
  sheet: { maxHeight: '92%', backgroundColor: colors.card, borderTopLeftRadius: radius.lg, borderTopRightRadius: radius.lg, borderWidth: 1, borderColor: colors.border },
  sheetContent: { padding: 20, gap: 8 },
  modalTitle: { color: colors.text, fontSize: 18, fontWeight: '700' },
  label: { color: colors.dim, fontSize: 13, fontWeight: '600', marginTop: 4 },
  input: { backgroundColor: colors.inputBg, borderColor: colors.border, borderWidth: 1, borderRadius: radius.sm, color: colors.text, paddingHorizontal: 13, paddingVertical: 10, fontSize: 14 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 3 },
  chip: { borderWidth: 1, borderColor: colors.border, borderRadius: 999, paddingHorizontal: 14, paddingVertical: 8, backgroundColor: colors.inputBg },
  compactChip: { width: 40, alignItems: 'center', paddingHorizontal: 0 },
  chipOn: { backgroundColor: 'rgba(124,92,255,.3)', borderColor: colors.accent },
  chipText: { color: colors.dim, fontSize: 13, fontWeight: '600' },
  chipTextOn: { color: '#fff' },
  switchRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  actions: { flexDirection: 'row', gap: 8, marginTop: 10 },
  action: { flex: 1, alignItems: 'center', borderRadius: radius.md, backgroundColor: colors.accent, paddingVertical: 13 },
  cancel: { backgroundColor: colors.inputBg },
  restore: { backgroundColor: 'rgba(248,113,113,.18)' },
  dim: { opacity: 0.5 },
});
