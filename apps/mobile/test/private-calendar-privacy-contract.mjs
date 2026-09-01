import { readFileSync } from 'node:fs';

const read = (relativePath) => readFileSync(new URL(`../${relativePath}`, import.meta.url), 'utf8');
const home = read('src/screens/HomeScreen.tsx');
const schedules = read('src/screens/SchedulesScreen.tsx');

function check(description, condition) {
  if (!condition) throw new Error(`PRIVATE CALENDAR PRIVACY CONTRACT FAILED: ${description}`);
}

check(
  'HomeScreen must derive schedule authorization from both live connection state and RPC authentication',
  home.includes("const authenticated = connectionState === 'connected' && client.authed;")
    && home.includes('privateWorkAuthenticated={authenticated}'),
);

const clearStart = schedules.indexOf('const clearPrivateWorkState = useCallback');
const clearEnd = schedules.indexOf('\n  }, []);', clearStart);
const clearBody = clearStart >= 0 && clearEnd > clearStart
  ? schedules.slice(clearStart, clearEnd)
  : '';

for (const requiredClear of [
  'setCalendar(null)',
  "setWorkError('')",
  'setShowWorkEdit(false)',
  "setEditStatus('onsite')",
  "setEditLabel('')",
  "setEditAddress('')",
  'setRouteSummary(null)',
  'setSelected(today.date)',
]) {
  check(`authorization loss must run ${requiredClear}`, clearBody.includes(requiredClear));
}

check(
  'ordinary calendar events must survive private-calendar authorization loss',
  !clearBody.includes('setCalendarEvents(')
    && !clearBody.includes('setShowCalendarAdd(')
    && !clearBody.includes('setCalendarTitle('),
);
check(
  'authorization loss must invalidate the active private session and invoke the clear routine',
  schedules.includes('useLayoutEffect(() => {')
    && schedules.includes('if (!privateWorkAuthenticated) {')
    && schedules.includes('privateWorkSessionGenerationRef.current += 1;')
    && schedules.includes('clearPrivateWorkState();'),
);
check(
  'the rendered work month and edit modal must be authorization-gated before effects run',
  schedules.includes('const visibleCalendar = privateWorkAuthenticated ? calendar : null;')
    && schedules.includes('visible={privateWorkAuthenticated && showWorkEdit && canEditWork}'),
);
check(
  'late private RPC completions must be rejected after session invalidation',
  schedules.includes('privateWorkSessionGenerationRef')
    && (schedules.match(/isCurrentPrivateWorkSession\(sessionGeneration\)/g) ?? []).length >= 8,
);

console.log('PRIVATE CALENDAR PRIVACY CONTRACT PASSED');
