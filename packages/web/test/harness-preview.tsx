// Synthetic fixture only: no provider, user files, actual commands or backend RPC.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { HarnessSettings, SingleHarnessIndicator, type HarnessConfig, type HarnessCandidate } from '../src/components/HarnessSettings';
import { PluginsView } from '../src/views/PluginsView';
import { MrRobotContext } from '../src/state';
import type { MrRobotClient } from '../src/rpc';
import '../src/styles.css';
const parameters = new URLSearchParams(location.search);
const calls: Array<{ method: string; params: any }> = [];
const initial: HarnessConfig = { documents: ['docs/guide.md'], verifiers: [{ id: 'artifact', name: '산출물 계약', kind: 'json-artifact', path: 'result.json', schema: { type: 'object', properties: { ok: { type: 'boolean', const: true } }, required: ['ok'], additionalProperties: false } }], permissionMode: parameters.has('workspace') ? 'workspace' : 'full', capabilities: { workspaceCommand: false, fullHostCommand: true } };
if (parameters.has('workspace')) initial.verifiers.push({ id: 'sandbox_only', name: '명령 실행 제한 확인', kind: 'command', command: { executable: 'C:\\Fixture\\node.exe', args: ['--test'] }, sourcePaths: ['src/main.ts'], timeoutMs: 30000, allowFullHostExecution: true });
const configurations = new Map([['a', structuredClone(initial)], ['b', { ...structuredClone(initial), documents: ['README.md'], verifiers: [] }]]);
let candidates: HarnessCandidate[] = [{ id: 'claim', claim: { subject: 'Fixture', predicate: 'uses', object: 'Deterministic validation' }, status: 'candidate', stale: false, conflictIds: [], evidence: [{ path: 'docs/guide.md', sha256: 'a'.repeat(64), quote: 'Fixture uses deterministic validation.' }] }, { id: 'stale', claim: { subject: 'Old fixture', predicate: 'uses', object: 'Stale rule' }, status: 'candidate', stale: true, conflictIds: [], evidence: [] }];
const mock = { isAdmin: !parameters.has('readonly'), on: () => () => {}, async call(method: string, raw: unknown = {}) {
  const params = raw as any; calls.push({ method, params: structuredClone(params) });
  if (method === 'projects.list') return [{ id: 'a', name: '검증용 프로젝트' }, { id: 'b', name: '다른 프로젝트' }];
  if (method === 'harness.get') { await new Promise(r => setTimeout(r, 20)); return structuredClone(configurations.get(params.workspaceId)); }
  if (method === 'harness.candidates') return params.workspaceId === 'a' ? structuredClone(candidates) : [];
  if (method === 'harness.update') { const current = configurations.get(params.workspaceId)!; const next = { ...current, ...('documents' in params ? { documents: params.documents } : {}), ...('verifiers' in params ? { verifiers: params.verifiers } : {}) }; configurations.set(params.workspaceId, next); return structuredClone(next); }
  if (method === 'harness.search') return { matches: [{ path: 'docs/guide.md', lineStart: 3, lineEnd: 4, snippet: 'Fixture uses deterministic validation.', sha256: 'a'.repeat(64) }], issues: [], partial: false, metrics: { selected: 1, read: 1, cacheHits: 0 } };
  if (method === 'harness.approve') { candidates = candidates.map(c => c.id === params.candidateId ? { ...c, status: 'promoted' } : c); return candidates[0]; }
  if (method === 'harness.retract') { candidates = candidates.map(c => c.id === params.candidateId ? { ...c, status: 'retracted', retraction: { reason: params.reason } } : c); return candidates[0]; }
  if (method === 'harness.verify') return { id: params.verifierId, status: 'passed', exitCode: params.verifierId === 'artifact' ? null : 0, execution: params.verifierId === 'artifact' ? 'none' : 'local-full-not-isolated', durationMs: 42, stdout: 'Synthetic checks passed', stderr: '', stdoutTruncated: false, stderrTruncated: false };
  if (method === 'plugins.list') return [{ id: 'mcp-host', name: 'MCP Tool Connector', version: '1', kind: 'tool', enabled: true, status: 'loaded', description: 'Synthetic MCP fixture', commands: [], capabilities: [], permissions: [], dependencies: [], category: 'development', tools: [] }];
  if (method === 'plugins.call' && params.name === 'mcp.presets.installed') return [{ id: 'context7', version: '4.2.0', installed: true, executablePath: 'C:\\Fixture\\context7\\index.js' }, { id: 'serena', version: '1.7.0', installed: false }];
  if (method === 'plugins.call' && params.name === 'mcp.servers.list') return [];
  throw new Error('Unmocked harness UI method: ' + method);
} };
(window as any).harnessFixture = { calls, configurations };
createRoot(document.getElementById('root')!).render(<MrRobotContext.Provider value={{ client: mock as unknown as MrRobotClient }}><main style={{ maxWidth: 1040, margin: '0 auto', padding: 16, minWidth: 0 }}>{parameters.has('plugins') ? <PluginsView /> : <><SingleHarnessIndicator archivedName="이전 병렬 프리셋" /><HarnessSettings client={mock} /></>}</main></MrRobotContext.Provider>);
