export interface KoreanHoliday {
  date: string;
  /** Stable, non-localized identifier suitable for display layers to translate. */
  id: string;
  substitute?: boolean;
}

export interface SeoulNonWorkingDayOptions {
  /** Additional public dates supplied by a calendar service or local policy. */
  publicHolidayDates?: Iterable<string>;
}

const LEGACY_FIXED_HOLIDAYS: ReadonlyArray<readonly [number, number, string]> = [
  [1, 1, 'new-year'], [3, 1, 'independence-day'], [5, 5, 'children-day'],
  [6, 6, 'memorial-day'], [8, 15, 'liberation-day'],
  [10, 3, 'foundation-day'], [10, 9, 'alphabet-day'], [12, 25, 'christmas'],
];

// The 2026 amendment made Labor Day and every statutory national day,
// including Constitution Day, public holidays. Do not apply it retroactively.
const POST_2026_FIXED_HOLIDAYS: ReadonlyArray<readonly [number, number, string]> = [
  [5, 1, 'labor-day'], [7, 17, 'constitution-day'],
];

// Published 2026 월력요항 (Korea Astronomy and Space Science Institute),
// updated for the 2026-04-30 amendment to 관공서의 공휴일에 관한 규정.
// The amendment added Labor Day and made every statutory national day,
// including Constitution Day, a public holiday from 2026-05-01.
const OFFICIAL_2026: ReadonlyArray<KoreanHoliday> = [
  { date: '2026-01-01', id: 'new-year' },
  { date: '2026-02-16', id: 'lunar-new-year' }, { date: '2026-02-17', id: 'lunar-new-year' }, { date: '2026-02-18', id: 'lunar-new-year' },
  { date: '2026-03-01', id: 'independence-day' }, { date: '2026-03-02', id: 'independence-day-substitute', substitute: true },
  { date: '2026-05-01', id: 'labor-day' },
  { date: '2026-05-05', id: 'children-day' },
  { date: '2026-05-24', id: 'buddha-birthday' }, { date: '2026-05-25', id: 'buddha-birthday-substitute', substitute: true },
  { date: '2026-06-03', id: 'local-election' }, { date: '2026-06-06', id: 'memorial-day' },
  { date: '2026-07-17', id: 'constitution-day' },
  { date: '2026-08-15', id: 'liberation-day' }, { date: '2026-08-17', id: 'liberation-day-substitute', substitute: true },
  { date: '2026-09-24', id: 'harvest-festival' }, { date: '2026-09-25', id: 'harvest-festival' }, { date: '2026-09-26', id: 'harvest-festival' },
  { date: '2026-10-03', id: 'foundation-day' }, { date: '2026-10-05', id: 'foundation-day-substitute', substitute: true },
  { date: '2026-10-09', id: 'alphabet-day' }, { date: '2026-12-25', id: 'christmas' },
];

/** YYYY-MM-DD interpreted as a calendar date, never as an instant in local time. */
export function isSeoulWeekend(date: string): boolean {
  const weekday = weekdayOf(date);
  return weekday === 0 || weekday === 6;
}

/**
 * Base Korean public holidays for a Gregorian year. Lunar holidays are found
 * using ICU's Korean Dangi calendar instead of bundling a private calendar
 * table, so platform locale data remains the source of truth.
 */
export function koreanPublicHolidays(year: number): KoreanHoliday[] {
  validateYear(year);
  if (year === 2026) return OFFICIAL_2026.map((holiday) => ({ ...holiday }));
  const holidays = new Map<string, KoreanHoliday>();
  const add = (date: string, id: string, substitute = false) => {
    if (date.startsWith(`${year}-`) && !holidays.has(date)) holidays.set(date, { date, id, ...(substitute ? { substitute } : {}) });
  };

  const fixedHolidays = year >= 2026
    ? [...LEGACY_FIXED_HOLIDAYS, ...POST_2026_FIXED_HOLIDAYS]
    : LEGACY_FIXED_HOLIDAYS;
  for (const [month, day, id] of fixedHolidays) add(dateKey(year, month, day), id);

  const lunar = scanDangiLunarDates(year);
  for (const date of lunar.newYear) add(date, 'lunar-new-year');
  for (const date of lunar.buddha) add(date, 'buddha-birthday');
  for (const date of lunar.harvest) add(date, 'harvest-festival');

  // Under the current decree, the Seollal and Chuseok periods receive a
  // substitute when one of their dates overlaps Sunday (not merely Saturday).
  const sundaySubstituteGroups = [
    { id: 'lunar-new-year', dates: lunar.newYear },
    { id: 'harvest-festival', dates: lunar.harvest },
  ];
  for (const group of sundaySubstituteGroups) {
    if (!group.dates.some((date) => weekdayOf(date) === 0)) continue;
    let candidate = addDays(group.dates.reduce((latest, date) => date > latest ? date : latest), 1);
    while (isSeoulWeekend(candidate) || holidays.has(candidate)) candidate = addDays(candidate, 1);
    add(candidate, `${group.id}-substitute`, true);
  }
  // Buddha's Birthday receives a substitute for either Saturday or Sunday.
  for (const group of [{ id: 'buddha-birthday', dates: lunar.buddha }]) {
    if (!group.dates.some(isSeoulWeekend)) continue;
    let candidate = addDays(group.dates.reduce((latest, date) => date > latest ? date : latest), 1);
    while (isSeoulWeekend(candidate) || holidays.has(candidate)) candidate = addDays(candidate, 1);
    add(candidate, `${group.id}-substitute`, true);
  }
  const weekendSubstituteGroups = [
    ...fixedHolidays
      .filter(([, , id]) => id !== 'memorial-day' && id !== 'new-year')
      .map(([month, day, id]) => ({ id, dates: [dateKey(year, month, day)] })),
  ];
  for (const group of weekendSubstituteGroups) {
    if (!group.dates.some(isSeoulWeekend)) continue;
    let candidate = addDays(group.dates.reduce((latest, date) => date > latest ? date : latest), 1);
    while (isSeoulWeekend(candidate) || holidays.has(candidate)) candidate = addDays(candidate, 1);
    add(candidate, `${group.id}-substitute`, true);
  }
  return [...holidays.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/** Combines locally-computed holidays with caller-provided public date overrides. */
export function seoulPublicHolidayDates(year: number, options: SeoulNonWorkingDayOptions = {}): Set<string> {
  const dates = new Set(koreanPublicHolidays(year).map((holiday) => holiday.date));
  for (const date of options.publicHolidayDates ?? []) {
    if (isDateKey(date)) dates.add(date);
  }
  return dates;
}

export function isSeoulNonWorkingDay(date: string, options: SeoulNonWorkingDayOptions = {}): boolean {
  if (!isDateKey(date)) throw new Error('Expected a YYYY-MM-DD calendar date');
  return isSeoulWeekend(date) || seoulPublicHolidayDates(Number(date.slice(0, 4)), options).has(date);
}

function scanDangiLunarDates(year: number): { newYear: string[]; buddha: string[]; harvest: string[] } {
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat('ko-KR-u-ca-dangi', {
      timeZone: 'Asia/Seoul', year: 'numeric', month: 'numeric', day: 'numeric',
    });
  } catch {
    // No hard-coded lunar fallback: callers can safely supply official dates.
    return { newYear: [], buddha: [], harvest: [] };
  }
  const result = { newYear: [] as string[], buddha: [] as string[], harvest: [] as string[] };
  for (let utc = Date.UTC(year, 0, 1); utc < Date.UTC(year + 1, 0, 1); utc += 86_400_000) {
    const date = new Date(utc);
    const parts = formatter.formatToParts(date);
    const monthPart = parts.find((part) => part.type === 'month')?.value ?? '';
    // Leap lunar months are not the named public-holiday dates.
    if (/윤/.test(monthPart)) continue;
    const month = integerPart(monthPart);
    const day = integerPart(parts.find((part) => part.type === 'day')?.value ?? '');
    const key = date.toISOString().slice(0, 10);
    if (month === 1 && day === 1) result.newYear.push(addDays(key, -1), key, addDays(key, 1));
    if (month === 4 && day === 8) result.buddha.push(key);
    if (month === 8 && day >= 14 && day <= 16) result.harvest.push(key);
  }
  return result;
}

function integerPart(value: string): number {
  const match = value.match(/\d+/);
  return match ? Number(match[0]) : Number.NaN;
}

function validateYear(year: number): void {
  if (!Number.isInteger(year) || year < 1900 || year > 2200) throw new Error('Calendar year is out of range');
}

function dateKey(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function isDateKey(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  return Number.isInteger(year) && month >= 1 && month <= 12 && day >= 1 && day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function weekdayOf(value: string): number {
  if (!isDateKey(value)) throw new Error('Expected a YYYY-MM-DD calendar date');
  const [year, month, day] = value.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function addDays(value: string, days: number): string {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}
