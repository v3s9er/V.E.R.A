import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import type { ModelRole, ProviderInfo, RoutingEdge, RoutingGraph, RoutingGroup, RoutingGroupMode, RoutingNode, RoutingNodeKind } from '@mr-robot/shared';
import { Button, Input, Modal, Select } from './ui';

const ROLES: Array<{ id: ModelRole; label: string; description: string; icon: string }> = [
  { id: 'router', label: '요청 분석·분배', description: '작업을 판별하고 다음 모델을 선택', icon: '⌘' },
  { id: 'fast', label: '빠른 처리', description: '짧고 단순한 요청을 저비용으로 처리', icon: 'ϟ' },
  { id: 'general', label: '일반 실행', description: '대부분의 일상 작업을 수행', icon: '✦' },
  { id: 'reasoning', label: '심층 사고', description: '복잡한 분석과 의사결정을 담당', icon: '◇' },
  { id: 'coding', label: '코딩', description: '구현·디버깅·리팩터링 담당', icon: '</>' },
  { id: 'vision', label: '시각', description: '이미지와 화면 이해 담당', icon: '◉' },
  { id: 'critic', label: '검토·검증', description: '회의 투표와 근거를 검증해 최종 결과를 판정', icon: '✓' },
  { id: 'summarizer', label: '요약·집계', description: '의견을 집계하고 최종 결과를 정리', icon: '∑' },
];
const GROUP_COLORS = ['#8b74ff', '#22d3ee', '#34d399', '#ffb454', '#ff5fa2', '#60a5fa'];
const GROUP_MODE_LABEL: Record<RoutingGroupMode, string> = { collaborative: '협업 회의', competitive: '경쟁 토론', review: '상호 검증' };
const NODE_WIDTH = 142;
const NODE_HEIGHT = 82;
const GROUP_MIN_WIDTH = 190;
const GROUP_MIN_HEIGHT = 130;
const uid = (): string => globalThis.crypto?.randomUUID?.() ?? `node-${Date.now()}-${Math.random().toString(36).slice(2)}`;

type GroupBounds = { x: number; y: number; width: number; height: number };
type GroupInteraction = {
  id: string;
  mode: 'move' | 'resize';
  startX: number;
  startY: number;
  bounds: GroupBounds;
  memberPositions: Array<{ id: string; x: number; y: number }>;
};

function boundsAroundMembers(group: RoutingGroup, nodes: RoutingNode[]): GroupBounds {
  const members = nodes.filter((node) => node.groupId === group.id);
  if (!members.length) return { x: group.x ?? 90, y: group.y ?? 60, width: group.width ?? 250, height: group.height ?? 150 };
  const xs = members.map((node) => node.x), ys = members.map((node) => node.y);
  const x = Math.max(6, Math.min(...xs) - 22), y = Math.max(6, Math.min(...ys) - 34);
  return { x, y, width: Math.max(GROUP_MIN_WIDTH, Math.max(...xs) + NODE_WIDTH - x + 22), height: Math.max(GROUP_MIN_HEIGHT, Math.max(...ys) + NODE_HEIGHT - y + 22) };
}

function roleForLegacyKind(kind: RoutingNodeKind): ModelRole {
  if (kind === 'input' || kind === 'classifier') return 'router';
  if (kind === 'executor') return 'coding';
  if (kind === 'critic') return 'critic';
  if (kind === 'memory' || kind === 'output') return 'summarizer';
  return 'general';
}

function normalizeGraph(graph: RoutingGraph, providers: ProviderInfo[]): RoutingGraph {
  const hadLegacyNodes = graph.nodes.some((node) => node.kind !== 'model');
  let nodes = graph.nodes.map((node) => {
    const provider = providers.find((item) => item.id === node.providerId);
    return {
      ...node,
      kind: 'model' as const,
      role: node.role ?? roleForLegacyKind(node.kind),
      ...(provider && !node.providerModel ? { providerModel: provider.model } : {}),
    };
  });
  const overlaps = nodes.some((node, index) => nodes.slice(index + 1).some((other) => Math.abs(node.x - other.x) < NODE_WIDTH + 12 && Math.abs(node.y - other.y) < NODE_HEIGHT + 14));
  if (hadLegacyNodes || overlaps) {
    const counters = [0, 0, 0];
    nodes = nodes.map((node) => {
      const column = node.role === 'router' ? 0 : node.role === 'critic' || node.role === 'summarizer' ? 2 : 1;
      const y = 38 + counters[column]++ * 108;
      return { ...node, x: 28 + column * 245, y };
    });
  }
  const groups = [...(graph.groups ?? [])];
  for (const groupId of [...new Set(nodes.map((node) => node.groupId?.trim()).filter(Boolean) as string[])]) {
    if (!groups.some((group) => group.id === groupId)) groups.push({ id: groupId, name: groupId, color: GROUP_COLORS[groups.length % GROUP_COLORS.length], discussionMode: 'collaborative' });
  }
  const normalizedGroups = groups.map((group) => {
    if ([group.x, group.y, group.width, group.height].every((value) => typeof value === 'number' && Number.isFinite(value))) return group;
    return { ...group, ...boundsAroundMembers(group, nodes) };
  });
  return { ...graph, nodes, groups: normalizedGroups };
}

export function RoutingGraphEditor({ graph, providers, providerModels, onSave, readOnly = false }: {
  graph: RoutingGraph;
  providers: ProviderInfo[];
  providerModels: Record<string, string[]>;
  onSave?: (graph: RoutingGraph) => void;
  readOnly?: boolean;
}) {
  const [draft, setDraft] = useState(() => normalizeGraph(graph, providers));
  const draftRef = useRef(draft);
  const [drag, setDrag] = useState<{ id: string; dx: number; dy: number } | null>(null);
  const moved = useRef(false);
  const [groupInteraction, setGroupInteraction] = useState<GroupInteraction | null>(null);
  const groupMoved = useRef(false);
  const [connectFrom, setConnectFrom] = useState<string | null>(null);
  const [connectPointer, setConnectPointer] = useState<{ x: number; y: number } | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [editingEdgeId, setEditingEdgeId] = useState<string | null>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const [canvasWidth, setCanvasWidth] = useState(0);
  const previewColumns = useMemo(() => [...new Set(draft.nodes.map((node) => node.x))].sort((a, b) => a - b), [draft.nodes]);
  const previewColumnStep = previewColumns.length > 1
    ? Math.max(NODE_WIDTH + 16, (Math.max(0, canvasWidth - NODE_WIDTH - 48)) / (previewColumns.length - 1))
    : 0;
  const previewContentWidth = Math.max(canvasWidth, 48 + NODE_WIDTH + previewColumnStep * Math.max(0, previewColumns.length - 1));
  const svgId = useRef(uid().replace(/[^a-z0-9]/gi, '')).current;

  const replaceDraft = (next: RoutingGraph, save = true): void => {
    draftRef.current = next;
    setDraft(next);
    if (save) onSave?.(next);
  };

  useEffect(() => {
    const normalized = normalizeGraph(graph, providers);
    draftRef.current = normalized;
    setDraft(normalized);
    if (!readOnly && JSON.stringify(normalized) !== JSON.stringify(graph)) onSave?.(normalized);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph, providers]);

  useEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const update = (): void => setCanvasWidth(element.clientWidth);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const displayPosition = (node: RoutingNode): { x: number; y: number } => {
    if (!readOnly || canvasWidth <= 0 || draft.nodes.length < 2) return { x: node.x, y: node.y };
    const column = previewColumns.indexOf(node.x);
    return { x: previewColumns.length > 1 ? 24 + Math.max(0, column) * previewColumnStep : Math.max(24, (canvasWidth - NODE_WIDTH) / 2), y: node.y };
  };

  const updateNode = (id: string, patch: Partial<RoutingNode>, save = true): void => replaceDraft({ ...draftRef.current, nodes: draftRef.current.nodes.map((node) => node.id === id ? { ...node, ...patch } : node) }, save);
  const addNode = (): void => {
    const provider = providers[0];
    const node: RoutingNode = { id: uid(), kind: 'model', label: '새 모델 역할', role: 'general', x: 285 + Math.random() * 160, y: 100 + Math.random() * 220, providerId: provider?.id, providerModel: provider?.model };
    replaceDraft({ ...draftRef.current, nodes: [...draftRef.current.nodes, node] });
    setEditingId(node.id);
  };
  const removeNode = (id: string): void => {
    replaceDraft({ ...draftRef.current, nodes: draftRef.current.nodes.filter((node) => node.id !== id), edges: draftRef.current.edges.filter((edge) => edge.from !== id && edge.to !== id) });
    setEditingId(null);
  };
  const addGroup = (nodeId?: string): void => {
    const groups = draftRef.current.groups ?? [];
    const group: RoutingGroup = { id: uid(), name: `새 회의 그룹 ${groups.length + 1}`, color: GROUP_COLORS[groups.length % GROUP_COLORS.length], discussionMode: 'collaborative', x: 180 + groups.length * 24, y: 70 + groups.length * 20, width: 250, height: 150 };
    replaceDraft({ ...draftRef.current, groups: [...groups, group], nodes: draftRef.current.nodes.map((node) => node.id === nodeId ? { ...node, groupId: group.id } : node) });
    setEditingId(null);
    setEditingGroupId(group.id);
  };
  const updateGroup = (id: string, patch: Partial<RoutingGroup>): void => replaceDraft({ ...draftRef.current, groups: (draftRef.current.groups ?? []).map((group) => group.id === id ? { ...group, ...patch } : group) });
  const removeGroup = (id: string): void => {
    replaceDraft({ ...draftRef.current, groups: (draftRef.current.groups ?? []).filter((group) => group.id !== id), nodes: draftRef.current.nodes.map((node) => node.groupId === id ? { ...node, groupId: undefined } : node) });
    setEditingGroupId(null);
  };
  const syncGroupMembership = (id: string): void => {
    const current = draftRef.current;
    const group = (current.groups ?? []).find((item) => item.id === id);
    if (!group) return;
    const bounds = boundsAroundMembers({ ...group, x: group.x ?? 90, y: group.y ?? 60, width: group.width ?? 250, height: group.height ?? 150 }, []);
    const nodes = current.nodes.map((node) => {
      const centerX = node.x + NODE_WIDTH / 2, centerY = node.y + NODE_HEIGHT / 2;
      const inside = centerX >= bounds.x && centerX <= bounds.x + bounds.width && centerY >= bounds.y && centerY <= bounds.y + bounds.height;
      if (node.groupId === id) return inside ? node : { ...node, groupId: undefined };
      if (!node.groupId && inside) return { ...node, groupId: id };
      return node;
    });
    replaceDraft({ ...current, nodes });
  };
  const moveGroupBy = (id: string, dx: number, dy: number): void => {
    const element = canvas.current;
    const current = draftRef.current;
    const group = (current.groups ?? []).find((item) => item.id === id);
    if (!element || !group) return;
    const bounds = { x: group.x ?? 90, y: group.y ?? 60, width: group.width ?? 250, height: group.height ?? 150 };
    const x = Math.max(6, Math.min(element.clientWidth - bounds.width - 6, bounds.x + dx));
    const y = Math.max(6, Math.min(element.clientHeight - bounds.height - 6, bounds.y + dy));
    const appliedX = x - bounds.x, appliedY = y - bounds.y;
    replaceDraft({
      ...current,
      groups: (current.groups ?? []).map((item) => item.id === id ? { ...item, x, y } : item),
      nodes: current.nodes.map((node) => node.groupId === id ? { ...node, x: node.x + appliedX, y: node.y + appliedY } : node),
    }, false);
    syncGroupMembership(id);
  };
  const resizeGroupBy = (id: string, deltaWidth: number, deltaHeight: number): void => {
    const element = canvas.current;
    const current = draftRef.current;
    const group = (current.groups ?? []).find((item) => item.id === id);
    if (!element || !group) return;
    const x = group.x ?? 90, y = group.y ?? 60;
    const width = Math.max(GROUP_MIN_WIDTH, Math.min(element.clientWidth - x - 6, (group.width ?? 250) + deltaWidth));
    const height = Math.max(GROUP_MIN_HEIGHT, Math.min(element.clientHeight - y - 6, (group.height ?? 150) + deltaHeight));
    replaceDraft({ ...current, groups: (current.groups ?? []).map((item) => item.id === id ? { ...item, width, height } : item) }, false);
    syncGroupMembership(id);
  };
  const addEdge = (from: string, to: string): void => {
    if (from === to) return;
    const existing = draftRef.current.edges.find((edge) => edge.from === from && edge.to === to);
    if (existing) { setSelectedEdgeId(existing.id); return; }
    const edge: RoutingEdge = { id: uid(), from, to };
    replaceDraft({ ...draftRef.current, edges: [...draftRef.current.edges, edge] });
    setSelectedEdgeId(edge.id);
  };
  const finishConnection = (targetId: string): void => {
    if (connectFrom) addEdge(connectFrom, targetId);
    setConnectFrom(null);
    setConnectPointer(null);
  };
  const removeEdge = (id: string): void => {
    replaceDraft({ ...draftRef.current, edges: draftRef.current.edges.filter((edge) => edge.id !== id) });
    setSelectedEdgeId(null);
    setEditingEdgeId(null);
  };
  const updateEdge = (id: string, patch: Partial<RoutingEdge>): void => replaceDraft({ ...draftRef.current, edges: draftRef.current.edges.map((edge) => edge.id === id ? { ...edge, ...patch } : edge) });
  const reverseEdge = (id: string): void => {
    const edge = draftRef.current.edges.find((item) => item.id === id);
    if (edge) updateEdge(id, { from: edge.to, to: edge.from });
  };

  const pointerDown = (event: ReactPointerEvent, node: RoutingNode): void => {
    if (readOnly) return;
    const rect = canvas.current?.getBoundingClientRect();
    if (!rect) return;
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    moved.current = false;
    setSelectedEdgeId(null);
    setDrag({ id: node.id, dx: event.clientX - rect.left - node.x, dy: event.clientY - rect.top - node.y });
  };
  const startGroupInteraction = (event: ReactPointerEvent, group: RoutingGroup, mode: GroupInteraction['mode']): void => {
    if (readOnly) return;
    const rect = canvas.current?.getBoundingClientRect();
    if (!rect) return;
    event.stopPropagation();
    try { (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId); } catch { /* synthetic accessibility/test events may not own capture */ }
    groupMoved.current = false;
    setSelectedEdgeId(null);
    const bounds = { x: group.x ?? 90, y: group.y ?? 60, width: group.width ?? 250, height: group.height ?? 150 };
    setGroupInteraction({
      id: group.id,
      mode,
      startX: event.clientX,
      startY: event.clientY,
      bounds,
      memberPositions: draftRef.current.nodes.filter((node) => node.groupId === group.id).map((node) => ({ id: node.id, x: node.x, y: node.y })),
    });
  };
  const pointerMove = (event: ReactPointerEvent): void => {
    const rect = canvas.current?.getBoundingClientRect();
    if (!rect) return;
    if (connectFrom) setConnectPointer({ x: event.clientX - rect.left, y: event.clientY - rect.top });
    if (groupInteraction) {
      const rawDx = event.clientX - groupInteraction.startX, rawDy = event.clientY - groupInteraction.startY;
      if (Math.abs(rawDx) + Math.abs(rawDy) > 2) groupMoved.current = true;
      const current = draftRef.current;
      if (groupInteraction.mode === 'move') {
        const nextX = Math.max(6, Math.min(rect.width - groupInteraction.bounds.width - 6, groupInteraction.bounds.x + rawDx));
        const nextY = Math.max(6, Math.min(rect.height - groupInteraction.bounds.height - 6, groupInteraction.bounds.y + rawDy));
        const dx = nextX - groupInteraction.bounds.x, dy = nextY - groupInteraction.bounds.y;
        replaceDraft({
          ...current,
          groups: (current.groups ?? []).map((group) => group.id === groupInteraction.id ? { ...group, x: nextX, y: nextY } : group),
          nodes: current.nodes.map((node) => {
            const origin = groupInteraction.memberPositions.find((item) => item.id === node.id);
            return origin ? { ...node, x: origin.x + dx, y: origin.y + dy } : node;
          }),
        }, false);
      } else {
        const width = Math.max(GROUP_MIN_WIDTH, Math.min(rect.width - groupInteraction.bounds.x - 6, groupInteraction.bounds.width + rawDx));
        const height = Math.max(GROUP_MIN_HEIGHT, Math.min(rect.height - groupInteraction.bounds.y - 6, groupInteraction.bounds.height + rawDy));
        replaceDraft({ ...current, groups: (current.groups ?? []).map((group) => group.id === groupInteraction.id ? { ...group, width, height } : group) }, false);
      }
      return;
    }
    if (!drag) return;
    moved.current = true;
    updateNode(drag.id, { x: Math.max(0, Math.min(rect.width - NODE_WIDTH - 12, event.clientX - rect.left - drag.dx)), y: Math.max(0, Math.min(430, event.clientY - rect.top - drag.dy)) }, false);
  };
  const pointerUp = (): void => {
    if (groupInteraction) {
      const id = groupInteraction.id;
      setGroupInteraction(null);
      if (groupMoved.current) syncGroupMembership(id);
      else onSave?.(draftRef.current);
      return;
    }
    if (!drag) return;
    if (moved.current) {
      const node = draftRef.current.nodes.find((item) => item.id === drag.id);
      if (node) {
        const targetGroup = (draftRef.current.groups ?? []).find((group) => {
          const bounds = { x: group.x ?? 90, y: group.y ?? 60, width: group.width ?? 250, height: group.height ?? 150 };
          const centerX = node.x + NODE_WIDTH / 2, centerY = node.y + NODE_HEIGHT / 2;
          return centerX >= bounds.x && centerX <= bounds.x + bounds.width && centerY >= bounds.y && centerY <= bounds.y + bounds.height;
        });
        if (node.groupId !== targetGroup?.id) updateNode(node.id, { groupId: targetGroup?.id }, false);
      }
      onSave?.(draftRef.current);
    } else setEditingId(drag.id);
    setDrag(null);
  };

  const groups = draft.groups ?? [];
  const groupById = useMemo(() => new Map(groups.map((group) => [group.id, group])), [groups]);
  const groupBounds = (group: RoutingGroup): GroupBounds => {
    const members = draft.nodes.filter((node) => node.groupId === group.id).map(displayPosition);
    if (!readOnly || !members.length) return { x: group.x ?? 90, y: group.y ?? 60, width: group.width ?? 250, height: group.height ?? 150 };
    const xs = members.map((position) => position.x), ys = members.map((position) => position.y);
    const x = Math.max(6, Math.min(...xs) - 22), y = Math.max(6, Math.min(...ys) - 34);
    return { x, y, width: Math.max(GROUP_MIN_WIDTH, Math.max(...xs) + NODE_WIDTH - x + 22), height: Math.max(GROUP_MIN_HEIGHT, Math.max(...ys) + NODE_HEIGHT - y + 22) };
  };
  const edgePath = (edge: RoutingEdge): { d: string; mx: number; my: number } | null => {
    const from = draft.nodes.find((node) => node.id === edge.from), to = draft.nodes.find((node) => node.id === edge.to);
    if (!from || !to) return null;
    const a = displayPosition(from), b = displayPosition(to), x1 = a.x + NODE_WIDTH, y1 = a.y + NODE_HEIGHT / 2, x2 = b.x, y2 = b.y + NODE_HEIGHT / 2, bend = Math.max(42, Math.abs(x2 - x1) * .48);
    return { d: `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`, mx: (x1 + x2) / 2, my: (y1 + y2) / 2 - 8 };
  };

  const editing = draft.nodes.find((node) => node.id === editingId);
  const editingRole = ROLES.find((item) => item.id === (editing?.role ?? 'general')) ?? ROLES[2];
  const editingProvider = providers.find((item) => item.id === editing?.providerId);
  const editingModels = editingProvider ? [...new Set([editingProvider.model, ...(providerModels[editingProvider.id] ?? [])])] : [];
  const editingGroup = groups.find((group) => group.id === editingGroupId);
  const selectedEdge = draft.edges.find((edge) => edge.id === selectedEdgeId);
  const editingEdge = draft.edges.find((edge) => edge.id === editingEdgeId);
  const connectionFromNode = draft.nodes.find((node) => node.id === connectFrom);
  const nodeIds = new Set(draft.nodes.map((node) => node.id));
  const validEdges = draft.edges.filter((edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to));
  const connectedNodeIds = new Set(validEdges.flatMap((edge) => [edge.from, edge.to]));
  const orphanNodes = draft.nodes.length > 1 ? draft.nodes.filter((node) => !connectedNodeIds.has(node.id)) : [];
  const invalidEdgeCount = draft.edges.length - validEdges.length;
  const graphHasIssues = orphanNodes.length > 0 || invalidEdgeCount > 0;

  return <div className="graph-editor modern-graph-editor">
    <div className="graph-toolbar">
      <div><b>{readOnly ? '프리셋 구조 미리보기' : '모델 시나리오 빌더'}</b><span>{readOnly ? '화살표는 실행·정보 전달 방향, 색 영역은 서로 의견을 공유하는 회의 그룹입니다.' : '출력 ○에서 입력 ○로 끌어 연결하고, 그룹 이름을 끌어 이동하거나 오른쪽 아래 손잡이로 크기를 바꾸세요.'}</span><span className={`graph-health ${graphHasIssues ? 'warn' : 'ok'}`}>{graphHasIssues ? `주의 · 미연결 노드 ${orphanNodes.length}개${invalidEdgeCount ? ` · 잘못된 선 ${invalidEdgeCount}개` : ''}` : `정상 연결 · 노드 ${draft.nodes.length}개 · 선 ${validEdges.length}개`}</span></div>
      {!readOnly && <div className="graph-toolbar-actions"><Button variant="ghost" onClick={() => addGroup()}>＋ 회의 그룹</Button><Button variant="accent" onClick={addNode}>＋ 모델 노드</Button></div>}
    </div>
    {!readOnly && <div className={`graph-guide ${connectFrom ? 'active' : ''}`}>{connectFrom ? <><span className="guide-pulse" /><b>{connectionFromNode?.label}</b>에서 연결 중 · 대상 노드의 왼쪽 입력점에 놓으세요.<button onClick={() => { setConnectFrom(null); setConnectPointer(null); }}>취소</button></> : <><span>1</span> 오른쪽 출력점 누르기<i>→</i><span>2</span> 대상 왼쪽 입력점에 놓기<i>→</i><span>3</span> 선 클릭으로 수정·삭제</>}</div>}
    <div ref={canvas} className={`graph-canvas compact ${connectFrom ? 'is-connecting' : ''}`} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={pointerUp} onPointerDown={() => setSelectedEdgeId(null)} tabIndex={readOnly ? -1 : 0} onKeyDown={(event) => {
      if (event.key === 'Escape') { setConnectFrom(null); setConnectPointer(null); setSelectedEdgeId(null); }
      if ((event.key === 'Delete' || event.key === 'Backspace') && selectedEdgeId) removeEdge(selectedEdgeId);
    }}>
      {readOnly && <div className="graph-content-sizer" style={{ width: previewContentWidth }} aria-hidden="true" />}
      <div className="routing-group-layer">{groups.map((group) => {
        const bounds = groupBounds(group), members = draft.nodes.filter((node) => node.groupId === group.id).length;
        const interacting = groupInteraction?.id === group.id ? groupInteraction.mode : null;
        return <div key={group.id} className={`routing-group-bubble ${interacting ? `is-${interacting}` : ''}`} style={{ left: bounds.x, top: bounds.y, width: bounds.width, height: bounds.height, borderColor: group.color ?? GROUP_COLORS[0], background: `color-mix(in srgb, ${group.color ?? GROUP_COLORS[0]} 7%, transparent)` }}>
          <button type="button" className="group-drag-handle" disabled={readOnly} aria-label={`${group.name} 그룹 이동 및 설정`} title={readOnly ? group.name : '끌어서 그룹과 구성원을 함께 이동 · 방향키로 미세 이동 · 클릭해서 설정'} onPointerDown={(event) => startGroupInteraction(event, group, 'move')} onKeyDown={(event) => { const step = event.shiftKey ? 24 : 8; const delta = event.key === 'ArrowLeft' ? [-step, 0] : event.key === 'ArrowRight' ? [step, 0] : event.key === 'ArrowUp' ? [0, -step] : event.key === 'ArrowDown' ? [0, step] : null; if (delta) { event.preventDefault(); event.stopPropagation(); moveGroupBy(group.id, delta[0], delta[1]); } }} onClick={(event) => { event.stopPropagation(); if (groupMoved.current) { groupMoved.current = false; return; } setEditingGroupId(group.id); }}><i style={{ background: group.color ?? GROUP_COLORS[0] }} /><b>{group.name}</b><span>{GROUP_MODE_LABEL[group.discussionMode ?? 'collaborative']} · {members}명</span>{!readOnly && <em>{interacting === 'move' ? '이동 중' : '⋮⋮ 이동'}</em>}</button>
          {!readOnly && <button type="button" className="group-resize-handle" aria-label={`${group.name} 그룹 크기 조절`} title="끌어서 그룹 크기 조절 · 방향키로 미세 조절 · 안에 들어온 노드는 자동 포함" onPointerDown={(event) => startGroupInteraction(event, group, 'resize')} onKeyDown={(event) => { const step = event.shiftKey ? 24 : 8; const delta = event.key === 'ArrowLeft' ? [-step, 0] : event.key === 'ArrowRight' ? [step, 0] : event.key === 'ArrowUp' ? [0, -step] : event.key === 'ArrowDown' ? [0, step] : null; if (delta) { event.preventDefault(); event.stopPropagation(); resizeGroupBy(group.id, delta[0], delta[1]); } }} onClick={(event) => event.stopPropagation()}>↘</button>}
        </div>;
      })}</div>
      <svg className="graph-lines" width="100%" height="100%"><defs><linearGradient id={`routing-gradient-${svgId}`} x1="0" y1="0" x2="1" y2="0"><stop offset="0" stopColor="#8b74ff" /><stop offset="1" stopColor="#22d3ee" /></linearGradient><marker id={`routing-arrow-${svgId}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" /></marker></defs>
        {draft.edges.map((edge) => { const geometry = edgePath(edge); if (!geometry) return null; return <g key={edge.id} className={`graph-edge ${selectedEdgeId === edge.id ? 'selected' : ''}`} onPointerDown={(event) => { if (!readOnly) { event.stopPropagation(); setSelectedEdgeId(edge.id); } }}><path className="edge-visible" d={geometry.d} stroke={`url(#routing-gradient-${svgId})`} markerEnd={`url(#routing-arrow-${svgId})`} />{!readOnly && <path className="edge-hit" d={geometry.d} />}{edge.label && <text x={geometry.mx} y={geometry.my} textAnchor="middle"><tspan>{edge.label}</tspan></text>}</g>; })}
        {connectFrom && connectPointer && connectionFromNode && (() => { const from = displayPosition(connectionFromNode), x1 = from.x + NODE_WIDTH, y1 = from.y + NODE_HEIGHT / 2, bend = Math.max(36, Math.abs(connectPointer.x - x1) * .45); return <path className="edge-preview" d={`M ${x1} ${y1} C ${x1 + bend} ${y1}, ${connectPointer.x - bend} ${connectPointer.y}, ${connectPointer.x} ${connectPointer.y}`} markerEnd={`url(#routing-arrow-${svgId})`} />; })()}
      </svg>
      {draft.nodes.map((node) => {
        const role = ROLES.find((item) => item.id === (node.role ?? 'general')) ?? ROLES[2], position = displayPosition(node), group = node.groupId ? groupById.get(node.groupId) : undefined;
        return <div key={node.id} className={`graph-node compact-node ${connectFrom === node.id ? 'connecting' : ''} ${group ? 'grouped' : ''}`} style={{ transform: `translate(${position.x}px, ${position.y}px)`, borderColor: group?.color }} onPointerDown={(event) => pointerDown(event, node)}>
          {!readOnly && <button className="graph-port graph-port-in" aria-label={`${node.label} 입력 연결`} title="이 노드로 연결" onPointerDown={(event) => event.stopPropagation()} onPointerUp={(event) => { event.stopPropagation(); finishConnection(node.id); }} onClick={(event) => { event.stopPropagation(); finishConnection(node.id); }} />}
          <div className="compact-node-icon">{role.icon}</div><div className="compact-node-copy"><b>{node.label}</b><span>{role.label}</span>{group && <small><i style={{ background: group.color }} />{group.name}</small>}</div>
          {!readOnly && <button className="graph-port graph-port-out" aria-label={`${node.label} 출력 연결`} title="여기서 연결 시작" onPointerDown={(event) => { event.stopPropagation(); const rect = canvas.current?.getBoundingClientRect(); setConnectFrom(node.id); if (rect) setConnectPointer({ x: event.clientX - rect.left, y: event.clientY - rect.top }); }} onClick={(event) => { event.stopPropagation(); setConnectFrom(node.id); }} />}
        </div>;
      })}
      {selectedEdge && !readOnly && <div className="edge-inspector" onPointerDown={(event) => event.stopPropagation()}><span>선택한 연결</span><b>{draft.nodes.find((node) => node.id === selectedEdge.from)?.label} → {draft.nodes.find((node) => node.id === selectedEdge.to)?.label}</b><button onClick={() => setEditingEdgeId(selectedEdge.id)}>수정</button><button className="danger" onClick={() => removeEdge(selectedEdge.id)}>삭제</button></div>}
    </div>

    <Modal open={Boolean(editing)} onClose={() => setEditingId(null)} title="모델 노드 설정">{editing && <div className="node-settings-dialog">
      <div className="node-settings-hero"><div className="node-settings-icon">{editingRole.icon}</div><div><b>{editingRole.label}</b><p>{editingRole.description}</p></div></div>
      <label><span>노드 이름</span><Input aria-label="노드 이름" value={editing.label} onChange={(event) => updateNode(editing.id, { label: event.target.value })} /></label>
      <label><span>역할·목적</span><Select aria-label={`${editing.label} 역할`} value={editing.role ?? 'general'} onChange={(event) => updateNode(editing.id, { role: event.target.value as ModelRole })}>{ROLES.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</Select></label>
      <label><span>모델 공급자</span><Select aria-label={`${editing.label} 공급자`} value={editing.providerId ?? ''} onChange={(event) => { const nextProvider = providers.find((item) => item.id === event.target.value); updateNode(editing.id, { providerId: nextProvider?.id, providerModel: nextProvider?.model }); }}><option value="">기본 공급자 자동 사용</option>{providers.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</Select></label>
      <label><span>사용 모델</span><Select aria-label={`${editing.label} 모델`} value={editing.providerModel ?? editingProvider?.model ?? ''} disabled={!editingProvider} onChange={(event) => updateNode(editing.id, { providerModel: event.target.value })}>{!editingProvider && <option value="">공급자 기본 모델</option>}{editingModels.map((model) => <option key={model} value={model}>{model}</option>)}</Select></label>
      <label><span>회의 그룹 · 같은 색 원의 모델끼리 의견을 공유합니다</span><div className="group-dot-picker"><button type="button" className={!editing.groupId ? 'active none' : 'none'} onClick={() => updateNode(editing.id, { groupId: undefined })}><i />그룹 없음</button>{groups.map((group) => <button type="button" key={group.id} className={editing.groupId === group.id ? 'active' : ''} onClick={() => updateNode(editing.id, { groupId: group.id })}><i style={{ background: group.color }} />{group.name}</button>)}<button type="button" className="add" onClick={() => addGroup(editing.id)}>＋ 새 그룹</button></div></label>
      <div className="node-settings-actions"><Button variant="danger" onClick={() => removeNode(editing.id)}>노드 삭제</Button><Button onClick={() => setEditingId(null)}>완료</Button></div>
    </div>}</Modal>

    <Modal open={Boolean(editingGroup)} onClose={() => setEditingGroupId(null)} title="회의 그룹 설정">{editingGroup && <div className="node-settings-dialog group-settings-dialog"><div className="node-settings-hero"><div className="node-settings-icon group-icon" style={{ background: editingGroup.color }}>◎</div><div><b>{editingGroup.name}</b><p>같은 그룹의 모델은 독립 의견을 낸 뒤 서로의 결과를 읽고 토론·투표합니다.</p></div></div><label><span>그룹 이름</span><Input value={editingGroup.name} onChange={(event) => updateGroup(editingGroup.id, { name: event.target.value.slice(0, 60) })} /></label><label><span>회의 방식</span><Select value={editingGroup.discussionMode ?? 'collaborative'} onChange={(event) => updateGroup(editingGroup.id, { discussionMode: event.target.value as RoutingGroupMode })}><option value="collaborative">협업 회의 · 장점을 합쳐 하나의 안으로</option><option value="competitive">경쟁 토론 · 각자 풀고 증거로 승부</option><option value="review">상호 검증 · 약점과 오류를 집중 점검</option></Select></label><label><span>그룹 색상</span><div className="group-color-picker">{GROUP_COLORS.map((color) => <button key={color} type="button" className={editingGroup.color === color ? 'active' : ''} style={{ background: color }} aria-label={`${color} 색상`} onClick={() => updateGroup(editingGroup.id, { color })} />)}</div></label><p className="panel-hint">현재 구성원 {draft.nodes.filter((node) => node.groupId === editingGroup.id).length}명 · 그룹을 삭제해도 노드는 삭제되지 않고 그룹 지정만 해제됩니다.</p><div className="node-settings-actions"><Button variant="danger" onClick={() => removeGroup(editingGroup.id)}>그룹 삭제</Button><Button onClick={() => setEditingGroupId(null)}>완료</Button></div></div>}</Modal>

    <Modal open={Boolean(editingEdge)} onClose={() => setEditingEdgeId(null)} title="연결선 설정">{editingEdge && <div className="node-settings-dialog edge-settings-dialog"><div className="edge-direction-card"><span>{draft.nodes.find((node) => node.id === editingEdge.from)?.label}</span><i>→</i><span>{draft.nodes.find((node) => node.id === editingEdge.to)?.label}</span></div><label><span>연결 이름·전달 조건</span><Input value={editingEdge.label ?? ''} placeholder="예: 검증 통과 시 · 후보 풀이" onChange={(event) => updateEdge(editingEdge.id, { label: event.target.value.slice(0, 50) || undefined })} /></label><div className="node-settings-actions"><Button variant="danger" onClick={() => removeEdge(editingEdge.id)}>연결 삭제</Button><div className="type-row"><Button variant="ghost" onClick={() => reverseEdge(editingEdge.id)}>방향 뒤집기</Button><Button onClick={() => setEditingEdgeId(null)}>완료</Button></div></div></div>}</Modal>
  </div>;
}
