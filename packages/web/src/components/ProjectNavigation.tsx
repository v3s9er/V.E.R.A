import { Fragment, useEffect, useState, type ReactNode } from 'react';
import type { ConversationSummary, WorkspaceInfo } from '@mr-robot/shared';
import { useMrRobot } from '../state';
import { Button, Input, Modal } from './ui';
import './ProjectNavigation.css';

const PREVIEW_COUNT = 5;
const UNASSIGNED_GROUP = '__unassigned__';

function NavigationIcon({ name }: { name: 'search' | 'folder' | 'chevron' | 'plus' | 'more' | 'close' }) {
  return <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {name === 'search' && <><circle cx="8.5" cy="8.5" r="5.5" /><path d="m13 13 4 4" /></>}
    {name === 'folder' && <path d="M2.5 5.5h5l2 2h8v8.5h-15zM2.5 5.5V4h5l2 2h8v1.5" />}
    {name === 'chevron' && <path d="m7.5 5 5 5-5 5" />}
    {name === 'plus' && <path d="M10 4v12M4 10h12" />}
    {name === 'more' && <><circle cx="4" cy="10" r=".7" /><circle cx="10" cy="10" r=".7" /><circle cx="16" cy="10" r=".7" /></>}
    {name === 'close' && <path d="m5 5 10 10M15 5 5 15" />}
  </svg>;
}

export function ProjectNavigation({ projects, conversations, active, running = [], collapsed, selectedId, onToggle, onSelect, onChanged, onNewConversation, renderConversation, space, archived, onToggleArchived, emptyContent, createdConversationId }: {
  projects: WorkspaceInfo[]; conversations: ConversationSummary[]; active: string;
  running?: string[];
  collapsed: string[]; selectedId?: string;
  onToggle: (id: string) => void;
  onSelect: (id: string) => void; onChanged: (projects: WorkspaceInfo[]) => void;
  onNewConversation: (workspaceId?: string) => void;
  renderConversation: (conversation: ConversationSummary) => ReactNode;
  space: 'personal' | 'discord'; archived: boolean; onToggleArchived: () => void;
  emptyContent?: ReactNode; createdConversationId?: string;
}) {
  const { client } = useMrRobot();
  const [search, setSearch] = useState('');
  const [expandedGroups, setExpandedGroups] = useState<string[]>([]);
  useEffect(() => { if (createdConversationId) setSearch(''); }, [createdConversationId]);
  const [editing, setEditing] = useState<WorkspaceInfo | 'new' | null>(null);
  const [name, setName] = useState(''), [path, setPath] = useState(''), [instructions, setInstructions] = useState('');
  const [error, setError] = useState(''), [saving, setSaving] = useState(false), [confirmRemove, setConfirmRemove] = useState(false);
  const open = (project: WorkspaceInfo | 'new') => {
    setEditing(project); setName(project === 'new' ? '' : project.name); setPath(project === 'new' ? '' : project.path);
    setInstructions(project === 'new' ? '' : project.instructions ?? ''); setError(''); setConfirmRemove(false);
  };
  const save = async () => {
    if (!editing || saving) return;
    setSaving(true); setError('');
    try {
      const project = await client.call(editing === 'new' ? 'projects.create' : 'projects.update', { id: editing === 'new' ? undefined : editing.id, name, path, instructions }) as WorkspaceInfo;
      onChanged([...projects.filter(item => item.id !== project.id), project]);
      setEditing(null); setSearch(''); onSelect(project.id);
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setSaving(false); }
  };
  const remove = async () => {
    if (!editing || editing === 'new' || saving) return;
    setSaving(true); setError('');
    try {
      await client.call('projects.delete', { id: editing.id });
      onChanged(projects.filter(item => item.id !== editing.id)); setEditing(null); onSelect('*');
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setSaving(false); }
  };
  const query = search.trim().toLocaleLowerCase();
  const inSpace = conversations.filter(conversation => (conversation.origin === 'discord') === (space === 'discord'));
  const knownProjects = new Set(projects.map(project => project.id));
  const groups: Array<{ id: string; name: string; project?: WorkspaceInfo; conversations: ConversationSummary[] }> = space === 'discord'
    ? [{ id: '__discord__', name: '티켓 대화 기록', conversations: inSpace }]
    : [
      ...projects.map(project => ({ id: project.id, name: project.name, project, conversations: inSpace.filter(conversation => conversation.workspaceId === project.id) })),
      { id: UNASSIGNED_GROUP, name: '일반 대화', conversations: inSpace.filter(conversation => !conversation.workspaceId || !knownProjects.has(conversation.workspaceId)) },
    ].filter(group => group.id !== UNASSIGNED_GROUP || group.conversations.length > 0);
  const matchingGroups = groups.map(group => ({
    ...group,
    conversations: !query || group.name.toLocaleLowerCase().includes(query)
      ? group.conversations
      : group.conversations.filter(conversation => conversation.title.toLocaleLowerCase().includes(query)),
  })).filter(group => !query || group.conversations.length > 0 || group.name.toLocaleLowerCase().includes(query));
  const newConversation = (groupId: string, workspaceId?: string) => {
    setSearch('');
    if (collapsed.includes(groupId)) onToggle(groupId);
    onNewConversation(workspaceId);
  };
  const renderGroupConversations = (group: typeof groups[number]) => {
    const expanded = expandedGroups.includes(group.id);
    const recentIds = new Set([...group.conversations].sort((first, second) => second.updatedAt - first.updatedAt).slice(0, PREVIEW_COUNT).map(conversation => conversation.id));
    const visible = query || expanded ? group.conversations : group.conversations.filter(conversation => (
      recentIds.has(conversation.id) || conversation.id === selectedId || running.includes(conversation.id) || conversation.pinned
    ));
    const hiddenCount = group.conversations.length - visible.length;
    return <>
      {visible.map(conversation => <Fragment key={conversation.id}>{renderConversation(conversation)}</Fragment>)}
      {!query && (hiddenCount > 0 || expanded && group.conversations.length > PREVIEW_COUNT) && <button type="button" className="project-show-more" aria-expanded={expanded} onClick={() => setExpandedGroups(current => expanded ? current.filter(id => id !== group.id) : [...current, group.id])}>
        {expanded ? '대화 접기' : `대화 ${hiddenCount}개 더 보기`}
      </button>}
      {group.conversations.length === 0 && (query || !emptyContent) && <p className="project-empty">{query ? '일치하는 대화가 없습니다.' : archived ? '보관한 대화가 없습니다.' : space === 'discord' ? 'Discord 티켓 대화가 여기에 표시됩니다.' : '아직 대화가 없습니다.'}</p>}
    </>;
  };
  return <section className="project-navigation" aria-label={space === 'personal' ? '프로젝트와 대화' : 'Discord 대화'}>
    <div className="project-search">
      <NavigationIcon name="search" />
      <input type="search" aria-label="대화 검색" placeholder="대화 검색" value={search} onChange={event => setSearch(event.target.value)} />
      {search && <button type="button" className="project-icon-button" aria-label="검색 지우기" onClick={() => setSearch('')}><NavigationIcon name="close" /></button>}
    </div>
    <div className="project-nav-heading">
      <span>{space === 'personal' ? '프로젝트' : '티켓 대화'}</span>
      <div className="project-heading-actions">
        <button type="button" className="project-archive-button" onClick={onToggleArchived}>{archived ? '진행 중' : '보관함'}</button>
        {space === 'personal' && client.isAdmin && <button type="button" className="project-icon-button" title="프로젝트 만들기" aria-label="프로젝트 만들기" onClick={() => open('new')}><NavigationIcon name="plus" /></button>}
      </div>
    </div>
    <div className="conversation-items project-tree">
      {matchingGroups.map(group => space === 'discord'
        ? <div className="project-ticket-list" key={group.id}>{renderGroupConversations(group)}</div>
        : <section className="conversation-project-group" data-project-id={group.id} key={group.id}>
          <div className={`project-tree-heading ${active === group.id || group.conversations.some(conversation => conversation.id === selectedId) ? 'selected' : ''}`}>
            <button type="button" className="project-group-toggle" aria-label={`${group.name} 대화 접기/펼치기`} aria-expanded={Boolean(query) || !collapsed.includes(group.id)} title={group.project?.path ?? group.name} onClick={() => { if (!query) onToggle(group.id); }}>
              <span className={`project-chevron ${query || !collapsed.includes(group.id) ? 'expanded' : ''}`}><NavigationIcon name="chevron" /></span>
              <span className="project-folder-icon"><NavigationIcon name="folder" /></span>
              <span className="project-group-name">{group.name}</span>
              {group.conversations.some(conversation => running.includes(conversation.id)) && <span className="project-running" role="img" aria-label="프로젝트 작업 진행 중" title="작업 진행 중" />}
            </button>
            {group.project && <div className="project-tree-actions">
              <button type="button" className="project-icon-button" title={`${group.name}에서 새 대화`} aria-label={`${group.name}에서 새 대화`} onClick={() => newConversation(group.id, group.project!.id)}><NavigationIcon name="plus" /></button>
              {client.isAdmin && <button type="button" className="project-icon-button project-edit" title={`${group.name} 설정`} aria-label={`${group.name} 프로젝트 설정`} onClick={() => open(group.project!)}><NavigationIcon name="more" /></button>}
            </div>}
          </div>
          {(query || !collapsed.includes(group.id)) && <div className="project-conversations">{renderGroupConversations(group)}</div>}
        </section>)}
      {!query && inSpace.length === 0 && emptyContent}
      {matchingGroups.length === 0 && (query || !emptyContent) && <p className="project-empty" role="status">{query ? '일치하는 대화가 없습니다.' : archived ? '보관한 대화가 없습니다.' : '프로젝트를 만들고 대화를 시작하세요.'}</p>}
    </div>
    <Modal open={editing !== null} onClose={() => { if (!saving) setEditing(null); }} title={editing === 'new' ? '새 프로젝트' : '프로젝트 설정'}>
      <form className="project-form" onSubmit={event => { event.preventDefault(); void save(); }}>
        <p>작업 폴더와 지침을 연결하세요. 각 대화는 자체 세션을 유지하며 다른 대화 내용은 자동으로 합치지 않습니다.</p>
        <label>프로젝트 이름<Input autoFocus value={name} maxLength={80} required onChange={e => setName(e.target.value)} placeholder="예: 앱 리뉴얼" disabled={saving} /></label>
        <label>PC 작업 폴더<Input value={path} onChange={e => setPath(e.target.value)} placeholder="비우면 PC에 새 전용 폴더 생성" disabled={saving || editing !== 'new'} /></label>
        {editing === 'new' && window.mrRobotDesktop?.chooseDirectory && <Button type="button" variant="ghost" disabled={saving} onClick={() => void window.mrRobotDesktop!.chooseDirectory().then(value => { if (value) setPath(value); }).catch(() => setError('폴더 선택을 열지 못했습니다. 경로를 직접 입력하세요.'))}>기존 폴더 선택</Button>}
        <label>프로젝트 지침 <small>선택</small><textarea className="input" rows={4} value={instructions} maxLength={8000} onChange={e => setInstructions(e.target.value)} placeholder="작업 목표, 작성 언어, 검증 방법 등" disabled={saving} /></label>
        <p>프로젝트 구분은 파일 접근 권한이나 OS 샌드박스를 대체하지 않습니다. 현재 권한 설정이 그대로 적용됩니다.</p>
        {error && <div className="inline-error" role="alert">{error}</div>}
        {confirmRemove && <div className="project-remove-confirm"><b>프로젝트 연결만 해제할까요?</b><p>PC 파일과 대화는 남습니다. 기존 대화는 다른 프로젝트를 선택한 후 다시 실행할 수 있습니다.</p><Button type="button" variant="danger" disabled={saving} onClick={() => void remove()}>연결 해제 확인</Button><Button type="button" variant="ghost" onClick={() => setConfirmRemove(false)}>취소</Button></div>}
        <div className="modal-actions">{editing && editing !== 'new' && <Button type="button" variant="ghost" disabled={saving} onClick={() => setConfirmRemove(true)}>연결 해제</Button>}<Button type="button" variant="ghost" disabled={saving} onClick={() => setEditing(null)}>닫기</Button><Button type="submit" disabled={saving || !name.trim()}>{saving ? '저장 중…' : editing === 'new' ? '프로젝트 만들기' : '저장'}</Button></div>
      </form>
    </Modal>
  </section>;
}
