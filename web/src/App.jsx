import { useCallback, useEffect, useRef, useState } from 'react';
import { Calendar, Plus, Sparkles } from 'lucide-react';
import { AgentInput, PageHead } from './components';
import { AccountAvatar, AccountDialog, useWorkbenchSession } from './Auth';
import { ActivityDirectory, chapterFor, chapters, jumpToActivity } from './ActivityNavigation';
import { Dialog, Notice, Toast, Tooltip } from './interactions';
import { Select } from './Select';
import { askModel } from './agentClient';
import { importSource, organizationRequest, sourceAccept } from './memoryClient';
import { Overview } from './Overview';
import { ChangePage, Schedule, Sources } from './Plan';
import { External, ExternalForm, Preparation } from './PrepExternal';
import { Materials, PublicEvent, Registration } from './Attendees';
import { Live, Review } from './LiveReview';
import { activityTypes, checkCandidate, externalRoles, loadEvents, makeChange, moveCandidate, newEvent, planFromText, publishChange } from './model';

const views = { overview: Overview, sources: Sources, schedule: Schedule, prep: Preparation, external: External,
  registration: Registration, materials: Materials, change: ChangePage, live: Live, review: Review };

function routeFromHash() {
  return location.hash.replace(/^#\/?/, '').split('/');
}

function useRoute() {
  const [route, setRoute] = useState(routeFromHash);
  useEffect(() => {
    const refresh = () => setRoute(routeFromHash());
    window.addEventListener('hashchange', refresh);
    return () => window.removeEventListener('hashchange', refresh);
  }, []);
  return route;
}

function ActivitySections(props) {
  return chapters.map(({ id, label, subsections }) => {
    const View = views[id];
    return <section className="activity-chapter" id={'activity-' + id} aria-label={label} key={id}>
      <View {...props} />
      {subsections?.map(section => {
        const Subsection = views[section.id];
        return <section key={section.id} className="activity-subsection" id={'activity-' + section.id} aria-label={section.label}>
          <Subsection {...props} />
        </section>;
      })}
    </section>;
  });
}

function CreateEvent({ draft, create, close }) {
  const defaults = draft?.proposal ?? planFromText(draft?.text ?? '', '行业论坛');
  const importMode = Boolean(draft?.importMode);
  return <Dialog title={importMode ? '导入活动项目' : '新建活动'} close={close}>
    <form className="form-stack" onSubmit={e => {
      e.preventDefault();
      const form = new FormData(e.currentTarget);
      const description = form.get('description').trim();
      const files = form.getAll('projectFiles').filter(file => file.name);
      const suggested = description && !draft?.proposal ? planFromText(description, form.get('type')) : null;
      const type = suggested?.type ?? form.get('type');
      const title = form.get('title').trim() || files[0]?.name.replace(/\.[^.]+$/, '').slice(0, 50) || type + '计划';
      const hasNumber = suggested && /\d+\s*(?:人|位)/.test(description);
      const capacity = hasNumber ? suggested.capacity : Number(form.get('capacity'));
      if (capacity < 1 || capacity > 100000) return;
      create(newEvent({ title, type, capacity, date: form.get('date') }), files, form.get('agentAccess') === 'on');
    }}>
      <label>用一句话描述活动<textarea name="description" defaultValue={draft?.text?.slice(0, 200)} maxLength="200" placeholder="例如：我想办一场 150 人的论坛" /></label>
      <label>活动名称<input name="title" defaultValue={draft?.proposal?.title} maxLength="50" placeholder="可选，留空时生成名称" /></label>
      <div className="form-grid">
        <Select label="活动类型" name="type" defaultValue={defaults.type} options={activityTypes} />
        <label>目标人数<input name="capacity" type="number" min="1" max="100000" defaultValue={defaults.capacity} required /></label>
      </div>
      <label>活动日期<input name="date" type="date" /></label>
      {importMode && <>
        <label>项目资料<input type="file" name="projectFiles" accept={sourceAccept} multiple required /></label>
        <label className="import-access"><input type="checkbox" name="agentAccess" />允许 Agent 引用本批资料</label>
        <p className="muted">导入会建立本机索引。允许引用时，Agent 会将整理所需的文字片段发送给已配置的模型。</p>
      </>}
      <button className="button primary">{importMode ? '创建活动并建立索引' : '生成活动草稿'}</button>
    </form>
  </Dialog>;
}

export function App() {
  const route = useRoute();
  const auth = useWorkbenchSession();
  const [path, eventId, role] = route;
  const guestLink = Boolean(eventId) && (path === 'public' || (path === 'external' && Object.hasOwn(externalRoles, role)));
  const account = auth.session.user;
  return <Workbench key={account?.id ?? (guestLink ? 'guest' : 'signed-out')} route={route} auth={auth}
    canReadEvents={Boolean(account || guestLink)} />;
}

function Workbench({ route, auth, canReadEvents }) {
  const account = auth.session.user;
  const [events, setEvents] = useState(() => canReadEvents ? loadEvents() : []);
  const [activeId, setActiveId] = useState(() => sessionStorage.getItem('huixu.active') ?? 'forum');
  const [modal, setModal] = useState('');
  const [draft, setDraft] = useState(null);
  const [agentRun, setAgentRun] = useState(null);
  const [importRuns, setImportRuns] = useState({});
  const [organizationRuns, setOrganizationRuns] = useState({});
  const organizationRequests = useRef({});
  const agentRequest = useRef(null);
  const importingEvents = useRef(new Set());
  const [toast, setToast] = useState(null);
  const toastId = useRef(0);
  const pendingJump = useRef(null);
  const [path, routeEventId, role] = route;
  const page = Object.hasOwn(views, path) ? path : 'overview';
  const chapter = chapterFor(page);
  const pageLabel = chapter.subsections?.find(section => section.id === page)?.label ?? chapter.label;
  const externalRoute = path === 'external' && Boolean(routeEventId);
  const publicRoute = path === 'public' && Boolean(routeEventId);
  const event = events.find(item => item.id === (externalRoute || publicRoute ? routeEventId : activeId)) ?? events[0];
  const showExternal = externalRoute && event?.id === routeEventId && Object.hasOwn(externalRoles, role);
  const showPublic = publicRoute && event?.id === routeEventId;
  const pageTitle = showExternal || showPublic ? event.title : externalRoute || publicRoute ? '活动链接不可用' : pageLabel;

  useEffect(() => {
    if (!canReadEvents) return;
    try {
      localStorage.setItem('huixu.events.2', JSON.stringify(events));
    } catch {
      // 存储被禁用时，当前标签页仍可操作。
    }
  }, [canReadEvents, events]);
  useEffect(() => {
    if (!canReadEvents) return;
    const sync = e => { if (e.key === 'huixu.events.2') setEvents(loadEvents()); };
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  }, [canReadEvents]);
  useEffect(() => {
    document.title = pageTitle + ' · 会序';
  }, [pageTitle]);
  useEffect(() => {
    setModal('');
  }, [path, routeEventId, role]);
  useEffect(() => {
    const jump = pendingJump.current?.destination === location.hash ? pendingJump.current : null;
    pendingJump.current = null;
    if (jump?.preserveScroll) return;
    const frame = requestAnimationFrame(() => {
      if (publicRoute || externalRoute || !account || !path) window.scrollTo(0, 0);
      else jumpToActivity(route, Boolean(jump));
    });
    return () => cancelAnimationFrame(frame);
  }, [route, event?.id, Boolean(account), externalRoute, publicRoute]);
  useEffect(() => {
    setAgentRun(null);
    return () => agentRequest.current?.abort();
  }, [path, event?.id]);

  const dismissToast = useCallback(() => setToast(null), []);
  function notify(message) {
    toastId.current += 1;
    setToast({ id: toastId.current, text: message });
  }

  function navigate(id, { preserveScroll = false } = {}) {
    setModal('');
    const destination = '#/' + id;
    if (location.hash === destination) {
      if (!preserveScroll && account) jumpToActivity(id.split('/'), true);
      return;
    }
    pendingJump.current = { destination, preserveScroll };
    location.hash = destination;
  }
  function select(id, destination = 'overview') {
    setActiveId(id);
    sessionStorage.setItem('huixu.active', id);
    navigate(destination);
  }
  function update(transform) {
    setEvents(current => current.map(item => item.id === event.id ? transform(item) : item));
  }
  function openChange(change) {
    update(current => ({
      ...current, change,
      draftChanges: current.change ? [current.change, ...(current.draftChanges ?? [])] : (current.draftChanges ?? []),
    }));
    navigate('change');
  }
  function activateChange(change) {
    update(current => ({
      ...current, change,
      draftChanges: [...(current.change ? [current.change] : []), ...(current.draftChanges ?? []).filter(item => item.id !== change.id)],
    }));
  }
  function publish(candidate, recordMessage) {
    if (!event.change || checkCandidate(event, event.change, candidate).length) return false;
    update(current => publishChange(current, candidate, recordMessage));
    notify(recordMessage ? '已发布，并记录演练通知' : '已发布安排');
    return true;
  }
  async function organize(eventId, run = true) {
    const token = (organizationRequests.current[eventId] ?? 0) + 1;
    organizationRequests.current[eventId] = token;
    setOrganizationRuns(current => ({ ...current, [eventId]: { token, pending: run } }));
    if (!run) return;
    try {
      await organizationRequest(eventId, 'POST');
      if (organizationRequests.current[eventId] === token) {
        setOrganizationRuns(current => ({ ...current, [eventId]: { token, pending: false } }));
      }
    } catch (error) {
      if (organizationRequests.current[eventId] === token) {
        setOrganizationRuns(current => ({ ...current, [eventId]: { token, pending: false, error: error.message } }));
      }
    }
  }
  async function importFiles(eventId, files, agentAccess) {
    if (!files.length || importingEvents.current.has(eventId)) return;
    importingEvents.current.add(eventId);
    let progress = { pending: true, total: files.length, done: 0, indexed: 0, duplicates: 0, errors: [] };
    setImportRuns(current => ({ ...current, [eventId]: progress }));
    try {
      for (const file of files) {
        let result;
        try { result = await importSource(eventId, file, agentAccess); } catch (error) {
          progress = { ...progress, errors: [...progress.errors, { name: file.name, reason: error.message }] };
        }
        progress = { ...progress, done: progress.done + 1,
          indexed: progress.indexed + Number(Boolean(result?.source?.chunkCount && !result.duplicate)),
          duplicates: progress.duplicates + Number(Boolean(result?.duplicate)),
        };
        const currentProgress = progress;
        setImportRuns(current => ({ ...current, [eventId]: currentProgress }));
      }
    } finally {
      importingEvents.current.delete(eventId);
      setImportRuns(current => ({ ...current, [eventId]: { ...progress, pending: false } }));
      if (agentAccess && (progress.indexed || progress.duplicates)) void organize(eventId);
    }
  }

  function openImport() {
    setDraft({ importMode: true });
    setModal('create');
  }

  function create(next, files = [], agentAccess = false) {
    setEvents(current => [...current, next]);
    setModal('');
    select(next.id, files.length ? 'sources' : 'overview');
    if (files.length) importFiles(next.id, files, agentAccess);
    notify('已创建可编辑的活动草稿');
  }
  function copy() {
    const next = newEvent({ title: event.title + '（副本）', type: event.type, date: '', capacity: event.capacity });
    next.agenda = event.agenda.map(item => ({ ...item, guest: '待确认' }));
    next.tasks = event.tasks.map(task => ({ ...task, done: false, owner: '待分配' }));
    create(next);
  }
  function askLocal(text) {
    if (/办一?场|新建|创建/.test(text)) {
      setDraft({ text });
      setModal('create');
      return;
    }
    const session = event.agenda.find(item => text.includes(item.title)) ??
      event.agenda.find(item => (text.includes('圆桌') && item.title.includes('圆桌')) || (text.includes('工作坊') && item.title.includes('工作坊')));
    const room = text.match(/([ABC])\s*厅/i)?.[1].toUpperCase();
    const time = text.match(/\b(?:[01]?\d|2[0-3]):[0-5]\d\b/)?.[0].padStart(5, '0') ?? (text.includes('午餐后') ? '13:30' : '');
    if (!session || (!room && !time)) {
      setAgentRun({ question: text, error: '本机演练支持「把圆桌移到午餐后」「把工作坊换到 B 厅」和「我想办一场 150 人的论坛」。', code: 'MODEL_NOT_CONFIGURED' });
      return;
    }
    setModal('');
    openChange(makeChange(session, [moveCandidate(session, room || session.room, time || session.start)], 'Agent 根据本地规则生成的调整建议'));
  }

  async function ask(question) {
    agentRequest.current?.abort();
    const request = new AbortController();
    agentRequest.current = request;
    setModal('agent');
    setAgentRun({ question, pending: true });
    try {
      const result = await askModel(question, event, request.signal);
      if (!request.signal.aborted) setAgentRun({ question, ...result });
    } catch (error) {
      if (!request.signal.aborted) setAgentRun({ question, error: error.message });
    } finally {
      if (agentRequest.current === request) agentRequest.current = null;
    }
  }

  function stopAgent() {
    agentRequest.current?.abort();
    setAgentRun(current => current?.pending ? { question: current.question, stopped: true } : current);
  }

  function reviewProposal() {
    const proposal = agentRun.proposal;
    if (proposal.kind === 'event') {
      setDraft({ text: agentRun.question, proposal });
      setModal('create');
      return;
    }
    const before = proposal.before;
    const session = event.agenda.find(item => item.id === before.id);
    if (proposal.eventId !== event.id || !session || session.start !== before.start || session.end !== before.end || session.room !== before.room) {
      setAgentRun(current => ({ ...current, proposal: null, error: '议程已更新，请重新向 Agent 提出调整。' }));
      return;
    }
    setModal('');
    openChange(makeChange(session, [moveCandidate(session, proposal.room, proposal.start)], '模型提出的调整建议'));
  }

  const sourceIssueId = path === 'sources' && routeEventId === 'issue' ? role : undefined;
  const props = { event, update, navigate, notify, ask, openChange, publish, copy, activateChange, openImport, importFiles, sourceIssueId,
    importRun: importRuns[event?.id], memoryEvidenceId: path === 'sources' && routeEventId !== 'issue' ? routeEventId : undefined,
    organize, organizationRun: organizationRuns[event?.id] };
  if ((publicRoute || externalRoute) && !showPublic && !showExternal) return <main className="unavailable-link">
    <h1>活动链接不可用</h1><p className="muted">请向活动负责人索取当前链接。</p>
  </main>;
  return <>
    {showExternal ? <ExternalForm key={routeEventId + role} {...props} role={role} /> : showPublic ? <PublicEvent key={routeEventId} {...props} /> :
      <div className="activity-shell">
        <a className="skip-link" href="#workbench" onClick={e => { e.preventDefault(); document.getElementById('workbench').focus(); }}>跳转到工作台内容</a>
        <header className="activity-topbar">
          <div className="activity-toolbar">
            <div className="activity-toolbar-context">
              <button type="button" className="activity-brand" aria-label="会序，返回活动概况" onClick={() => navigate('overview')}>
                <Calendar size={25} strokeWidth={1.9} aria-hidden="true" /><span>会序</span>
              </button>
              {account && <Select label="切换活动" compact value={event.id} onChange={select}
                options={events.map(item => ({ value: item.id, label: item.title, detail: item.type }))} />}
            </div>
            <div className="activity-toolbar-actions">
              <ActivityDirectory page={page} followScroll={Boolean(account)} navigate={navigate} />
              {account && <>
                <button type="button" className="button toolbar-action" aria-label="新建活动" onClick={() => { setDraft(null); setModal('create'); }}>
                  <Plus size={18} aria-hidden="true" /><span>新建</span>
                </button>
                <Tooltip text="用自然语言创建活动或调整议程"><button type="button" className="button primary toolbar-action" aria-label="打开 Agent"
                  aria-haspopup="dialog" onClick={() => setModal('agent')}><Sparkles size={18} aria-hidden="true" /><span>Agent</span></button></Tooltip>
              </>}
              <button type="button" className="icon-button activity-account" aria-label={account ? '打开账户设置' : '登录工作台'}
                aria-haspopup="dialog" onClick={() => setModal('account')}><AccountAvatar user={account} /></button>
            </div>
          </div>
        </header>
        <main id="workbench" tabIndex={-1} className="workspace activity-workspace">
          {account ? <ActivitySections key={event.id} {...props} /> :
            <section className="activity-chapter" aria-label={pageLabel}>
              <PageHead title={pageLabel} />
              <Notice announce>{auth.session.loading ? '正在检查登录状态…' : '点击头像登录后查看活动内容。'}</Notice>
            </section>}
        </main>
      </div>}
    {modal === 'create' && <CreateEvent draft={draft} create={create} close={() => setModal('')} />}
    {modal === 'agent' && <Dialog title="活动 Agent" variant="drawer" close={() => { stopAgent(); setModal(''); }}>
      <p className="muted">查询当前议程、筹备状态和允许引用的活动资料，也可以准备活动草稿或议程变更。</p>
      <AgentInput onSubmit={ask} busy={agentRun?.pending} />
      {agentRun?.question && <p className="agent-question">{agentRun.question}</p>}
      {agentRun?.pending && <Notice announce>正在等待模型应答。</Notice>}
      {agentRun?.pending && <button type="button" className="button small" onClick={stopAgent}>停止等待</button>}
      {agentRun?.stopped && <Notice announce>本次请求已停止。</Notice>}
      {agentRun?.error && <Notice tone="warning" announce>{agentRun.error}</Notice>}
      {agentRun?.error && <button type="button" className="button small" onClick={() => ask(agentRun.question)}>重试请求</button>}
      {agentRun?.code === 'MODEL_NOT_CONFIGURED' && <button type="button" className="button small" onClick={() => askLocal(agentRun.question)}>使用本机规则演练</button>}
      {agentRun?.answer && <p className="agent-answer" role="status">{agentRun.answer}</p>}
      {agentRun?.evidence && <p className="muted">已读取 {agentRun.evidence.title} · {agentRun.evidence.version ? '议程 v' + agentRun.evidence.version : '计划草稿'}</p>}
      {agentRun?.statusReads?.length > 0 && <p className="muted">已读取 {agentRun.statusReads.join('、')}</p>}
      {agentRun?.citations?.length > 0 && <div className="memory-results">
        <p className="muted">检索到的原文</p>
        {agentRun.citations.map(item => <button key={item.chunkId} type="button" className="memory-hit" onClick={() => navigate(`sources/${item.chunkId}`)}>
          <strong>{item.name} · v{item.revision}</strong><span>{item.location}</span>
        </button>)}
      </div>}
      {agentRun?.model && <p className="muted">模型 · {agentRun.model}</p>}
      {agentRun?.proposal && <button type="button" className="button primary" onClick={reviewProposal}>{agentRun.proposal.kind === 'event' ? '打开活动草稿' : '打开变更单核对'}</button>}
      <div className="actions">
        <button className="button small" disabled={agentRun?.pending} onClick={() => ask('当前活动的筹备进展怎么样？')}>查看筹备进展</button>
        <button className="button small" disabled={agentRun?.pending} onClick={() => ask('列出当前活动可以引用的导入资料及其版本。')}>查看可引用资料</button>
      </div>
    </Dialog>}
    {modal === 'team' && <Dialog title="活动团队" variant="drawer" close={() => setModal('')}>
      <p className="muted">当前为本机工作台演练。以下为样例分工。</p>
      <ul className="plain-list"><li>林澄 · 活动负责人</li><li>唐悦 · 策划与统筹</li><li>顾言 · 现场总控</li></ul>
    </Dialog>}
    {modal === 'account' && <AccountDialog {...auth} openTeam={() => setModal('team')} close={() => setModal('')} />}
    <Toast feedback={toast} dismiss={dismissToast} />
  </>;
}
