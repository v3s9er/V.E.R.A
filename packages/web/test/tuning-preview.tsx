// Synthetic UI fixture only. No model calls, live files, credentials or backend.
import React from 'react';
import { createRoot } from 'react-dom/client';
import type { ModelTuningCapabilities, ProviderInfo, ProviderTuningSettings } from '@mr-robot/shared';
import type { MrRobotClient } from '../src/rpc';
import { ModelTuningSettings } from '../src/components/ModelTuningSettings';
import '../src/styles.css';

const providers: ProviderInfo[] = [
  { id: 'native', label: 'Codex 구독', model: 'gpt-6-astra', type: 'codex-cli', baseUrl: '', hasKey: false, isDefault: true, source: 'subscription', costTier: 1, supportedReasoning: ['auto', 'low', 'medium', 'high', 'xhigh', 'max'] },
  { id: 'api', label: 'API · 테스트', model: 'gpt-5.2', type: 'openai-compatible', baseUrl: 'https://api.openai.com/v1', hasKey: false, isDefault: false, source: 'api', costTier: 1, supportedReasoning: ['auto', 'none', 'low', 'medium', 'high', 'xhigh'] },
];
const settings = new Map<string, ProviderTuningSettings>([
  ['native', { profiles: [{ id: 'balanced', name: '일반 작업', reasoningEffort: 'medium', responseStyle: 'concise', helperMode: 'auto', maxParallelHelpers: 2 }], activeProfileId: 'balanced' }],
  ['api', { profiles: [{ id: 'review', name: '문서 검토', reasoningEffort: 'none', temperature: 0.2, maxOutputTokens: 2048 }] }],
]);
let datasets = [{ id: 'example', name: '공개 합성 예제 · 화면 테스트', createdAt: 1, counts: { trainRows: 16, evalRows: 4, uniqueRows: 20 } }];
const parameters = new URLSearchParams(location.search);
const mock = {
  isAdmin: !parameters.has('readonly'),
  async call(method: string, args: Record<string, any> = {}): Promise<unknown> {
    if (method === 'providers.tuning.get') {
      await new Promise(resolve => setTimeout(resolve, args.id === 'native' ? 160 : 40));
      const native = args.id === 'native';
      const capabilities: ModelTuningCapabilities = { reasoningEfforts: providers.find(p => p.id === args.id)!.supportedReasoning, maxOutputTokens: !native, temperature: { supported: !native, min: 0, max: 2, ...(!native ? { requiresReasoningNone: true } : {}) }, weightTraining: native ? 'unavailable-subscription' : 'external-only', notes: [] };
      return { settings: structuredClone(settings.get(args.id)), capabilities };
    }
    if (method === 'providers.tuning.set') { await new Promise(resolve => setTimeout(resolve, 80)); settings.set(args.id, structuredClone(args.settings)); return structuredClone(args.settings); }
    if (method === 'telemetry.summary') return { performance: { window: 12, successes: 10, cancelled: 1, firstTextMs: { samples: 8, p50: 1620, p95: 4920 }, completionMs: { samples: 10, p50: 9600, p95: 21000 }, byModel: [
      { model: 'gpt-6-astra', samples: 8, successes: 7, firstTextMs: { samples: 6, p50: 1700, p95: 4920 }, completionMs: { samples: 7, p50: 12100, p95: 21000 }, averageTokens: 1234 },
      { model: 'gpt-5.2', samples: 4, successes: 3, firstTextMs: { samples: 2, p50: 1250, p95: 2500 }, completionMs: { samples: 3, p50: 5500, p95: 9000 }, averageTokens: 820 },
    ] } };
    if (method === 'tuning.datasets.list') return structuredClone(datasets);
    if (method === 'tuning.datasets.validate') return { valid: true, inputRows: 20, uniqueRows: 20, duplicateRows: 0, trainRows: 16, evalRows: 4, credentialRisks: 0, piiRisks: 0, issues: [] };
    if (method === 'tuning.datasets.import') { const dataset = { id: `fixture-${datasets.length}`, name: String(args.name), createdAt: 2, counts: { trainRows: 16, evalRows: 4, uniqueRows: 20 } }; datasets = [dataset, ...datasets]; return dataset; }
    if (method === 'tuning.datasets.export') return { directory: 'C:\\Fixture\\LocalTraining\\Example', manifestPath: 'C:\\Fixture\\LocalTraining\\Example\\manifest.json' };
    throw new Error(`Unmocked UI fixture method: ${method}`);
  },
};
const narrow = parameters.has('mobile390');
createRoot(document.getElementById('root')!).render(<div style={{ height: '100dvh', overflow: 'auto', background: 'var(--bg)', padding: narrow ? 12 : '32px 24px' }}><main style={{ maxWidth: narrow ? 366 : 1040, margin: '0 auto', minWidth: 0 }}><p style={{ color: 'var(--text-dim)', fontSize: 12 }}>합성 데이터 · 실제 설정·사용량과 무관한 UI 검증 화면</p><ModelTuningSettings client={mock as unknown as MrRobotClient} providers={providers} nativeDesktopAdmin={true} /></main></div>);
