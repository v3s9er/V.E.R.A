// Synthetic data only. Never contacts an agent, provider, calendar or real file.
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { MrRobotContext } from '../src/state';
import { SchedulesView } from '../src/views/SchedulesView';
import { PluginWorkbench } from '../src/components/PluginWorkbench';
import { RunActivityPanel } from '../src/components/RunActivityPanel';
import type { MrRobotClient } from '../src/rpc';
import type { PluginInfo } from '@mr-robot/shared';
import '../src/styles.css';
const client = {
  isAdmin: true, permissionCap: 'full', on: () => () => {},
  call: async (method: string, input: any) => {
    if (method === 'settings.get') return { safety: { mode: 'full' } };
    if (method === 'scheduler.list') return [];
    if (input?.name === 'calendar.events.list') return [];
    if (input?.name === 'calendar.work.settings.get') return null;
    if (input?.name === 'calendar.work.month') {
      const { year, month } = input.params, count = new Date(Date.UTC(year, month, 0)).getUTCDate();
      const prefix = String(year)+'-'+String(month).padStart(2,'0')+'-';
      return { year, month, configured: true, today: prefix+'13', access: { canEdit: true }, days: Array.from({ length: count }, (_, i) => ({ date: prefix+String(i+1).padStart(2,'0'), status: i%3 ? 'onsite' : 'remote', destinationLabel: '테스트 사무실', source: 'manual', overridden: false })) };
    }
    throw Error('Unmocked fixture call: '+method+' / '+input?.name);
  },
} as unknown as MrRobotClient;
const plugin = { id: 'calendar', name: '캘린더', description: '테스트용 일정', builtin: true, enabled: true, status: 'loaded', commands: ['calendar.status'], capabilities: [], subscriptions: 0, timers: 0, source: 'builtin' } as unknown as PluginInfo;
function Preview() {
  const [mode, setMode] = useState('schedules');
  return <MrRobotContext.Provider value={{ client }}><div className="shell"><main className="content"><header className="topbar"><button onClick={() => setMode('schedules')}>일정 화면</button><button onClick={() => setMode('plugin')}>플러그인 화면</button></header>{mode === 'schedules' ? <SchedulesView /> : <div className="stack"><PluginWorkbench plugin={plugin} client={client} onClose={() => setMode('schedules')} /></div>}</main></div><div hidden><RunActivityPanel phase="completed" busy={false} activity={[{ id:'error', label:'desktop_act', state:'error', startedAt:1, finishedAt:2 }]} /></div></MrRobotContext.Provider>;
}
createRoot(document.getElementById('root')!).render(<Preview />);
