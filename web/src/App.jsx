import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { Calendar, Plus, Settings, Sparkles } from 'lucide-react';
import { AgentWorkspace } from './AgentWorkspace';
import { AccountAvatar, AccountDialog, useWorkbenchSession } from './Auth';
import { ActivityDirectory, chapterFor, chapters, jumpToActivity } from './ActivityNavigation';
import { Dialog, mobileLayoutQuery, Toast, Tooltip } from './interactions';
import { Tabs } from './components';
import { TopicPlanForm } from './TopicPlanForm';
import { Select } from './Select';
import { askModel } from './agentClient';
import { rememberTurn } from './agentConversation';
import { describeRescueImpact } from './changeImpact';
import { importSource, organizationRequest, sourceAccept } from './memoryClient';
import { Overview } from './Overview';
import { ModelSettings } from './ModelSettings';
import { WorkspaceDraftDialog } from './WorkspaceDraftDialog';
import { TeamBoard } from './TeamBoard';
import { draftChanged, restoreWorkspaceDraft } from './workspaceDraft';
import { ChangePage, Schedule, Sources } from './Plan';
import { External, ExternalForm, Preparation } from './PrepExternal';
import { GuestConfirmation } from './GuestCollaboration';
import { TaskHandoff } from './TaskHandoff';
import { Materials, PublicEvent, Registration } from './Attendees';
import { AttendancePage, PublishedEvent } from './RegistrationPublic';
import { ownerRegistration, useRegistrationWorkspace } from './registrationClient';
import { rescueOperations, signupSnapshot } from './registrationRules';
import { analyzeRescue, rescueSummary, rescueTitle, validateRescuePlan } from './rescueScheduling';
import { Live, Review } from './LiveReview';
import { activityTypes, externalRoles, initialEvents, loadEvents, makeMoveChange, manualPlan, minutes, newEvent, planFromText, publishChange, uid } from './model';

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

function useMediaQuery(query) {
  const [matches, setMatches] = useState(() => matchMedia(query).matches);
  useEffect(() => {
    const media = matchMedia(query);
    const sync = () => setMatches(media.matches);
    sync();
    media.addEventListener('change', sync);
    return () => media.removeEventListener('change', sync);
  }, [query]);
  return matches;
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

function CreateEvent({ draft, events, create, close, ownerId }) {
  const defaults = draft?.proposal ?? planFromText(draft?.text ?? '', '行业论坛');
  const importMode = Boolean(draft?.importMode);
  const [mode, setMode] = useState(draft?.proposal || importMode ? '手动创建' : '从主题生成');
  return <Dialog title={importMode ? '导入活动项目' : '新建活动'} close={close}>
    {!importMode && <div className="create-event-tabs"><Tabs label="创建方式" items={['从主题生成', '手动创建']} value={mode} onChange={setMode} /></div>}
    {mode === '从主题生成' ? <TopicPlanForm events={events} initialTopic={draft?.text} create={create} ownerId={ownerId} /> :
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
      const next = newEvent({ title, type, capacity, date: form.get('date') });
      if (!files.length) next.organizedPlan = manualPlan(next);
      create(next, files, form.get('agentAccess') === 'on');
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
    </form>}
  </Dialog>;
}

export function App() {
  const route = useRoute();
  const [path, id] = route;
  if (path === 'attendance') return <AttendancePage key={id} token={id} />;
  if (path === 'guest') return <GuestConfirmation key={id} token={id} />;
  if (path === 'tasks') return <TaskHandoff key={id} token={id} />;
  if (path === 'public') return <PublishedEvent key={id} publicId={id} />;
  return <WorkspaceApp route={route} />;
}

function WorkspaceApp({ route }) {
  const auth = useWorkbenchSession();
  const [path, eventId, role] = route;
  const guestLink = Boolean(eventId) && path === 'external' && Object.hasOwn(externalRoles, role);
  const account = auth.session.user;
  return <Workbench key={account?.id ?? (guestLink ? 'guest-link' : 'preview')} route={route} auth={auth}
    useStoredEvents={Boolean(account || guestLink)} />;
}

function Workbench({ route, auth, useStoredEvents }) {
  const account = auth.session.user;
  const readOnly = !useStoredEvents;
  const [events, setEvents] = useState(() => useStoredEvents ? loadEvents() : initialEvents());
  const [activeId, setActiveId] = useState(() => useStoredEvents ? sessionStorage.getItem('huixu.active') ?? 'forum' : 'forum');
  const [modal, setModal] = useState('');
  const [draft, setDraft] = useState(null);
  const [agentRun, setAgentRun] = useState(null);
  const conversation = useRef(new Map());
  const [agentDockOpen, setAgentDockOpen] = useState(true);
  const [agentDrawerOpen, setAgentDrawerOpen] = useState(false);
  const directoryId = useId();
  const agentId = useId();
  const agentToggle = useRef(null);
  const mobile = useMediaQuery(mobileLayoutQuery);
  const wide = useMediaQuery('(min-width: 1000px)');
  const dockAgent = wide && !mobile;
  const agentOpen = dockAgent ? agentDockOpen : agentDrawerOpen;
  const [importRuns, setImportRuns] = useState({});
  const [organizationRuns, setOrganizationRuns] = useState({});
  const organizationRequests = useRef({});
  const agentRequest = useRef(null);
  const importingEvents = useRef(new Set());
  const [toast, setToast] = useState(null);
  const toastId = useRef(0);
  const pendingJump = useRef(null);
  const sourceReturn = useRef(null);
  const [path, routeEventId, role] = route;
  const page = Object.hasOwn(views, path) ? path : 'overview';
  const chapter = chapterFor(page);
  const pageLabel = chapter.subsections?.find(section => section.id === page)?.label ?? chapter.label;
  const externalRoute = path === 'external' && Boolean(routeEventId);
  const publicRoute = path === 'preview-event' && Boolean(routeEventId);
  const localEvent = events.find(item => item.id === (externalRoute || publicRoute ? routeEventId : activeId)) ?? events[0];
  const registration = useRegistrationWorkspace(Boolean(account), localEvent);
  const shared = registration.current;
  let event = account ? { ...localEvent, checkins: shared?.checkins ?? [] } : localEvent;
  if (shared) {
    event = { ...event, attendees: shared.people, formOpen: shared.event.formOpen };
    const received = new Set((shared.guestRequests ?? []).filter(item => item.taskId && item.filename).map(item => item.taskId));
    if (received.size) event.tasks = event.tasks.map(task => received.has(String(task.id)) ? { ...task, done: true } : task);
    if (shared.operations) {
      const actual = { ...localEvent.actual, ...shared.operations.actual };
      const replies = new Map(shared.operations.replies.map(reply => [reply.id, reply]));
      for (const reply of localEvent.replies) {
        if (!replies.get(reply.id)?.guestConfirmed) replies.set(reply.id, reply);
      }
      event = { ...event, actual, replies: [...replies.values()], onsite: event.onsite || Object.values(actual).some(item => item.started) };
    }
    if (shared.event.version > 0 && shared.event.version >= localEvent.version) {
      event = { ...event, ...shared.event, agenda: shared.event.agenda.map(session => ({
        ...localEvent.agenda.find(item => item.id === session.id), ...session,
      })) };
    }
    const releases = shared.rescueReleases ?? [];
    if (releases.length) {
      const ids = new Set(releases.map(item => item.id));
      const history = [...releases, ...localEvent.history.filter(item => !ids.has(item.id))].sort((a, b) => b.version - a.version);
      const messages = releases.flatMap(release => release.notices.map((notice, index) => ({
        id: release.id + '-' + index, channel: '救场通知草稿', subject: release.title + ' · ' + notice.role, body: notice.body,
        count: notice.recipients.length, version: release.version, date: release.date,
      })));
      event = { ...event, history, messages: [...messages, ...event.messages], change: ids.has(event.change?.id) ? null : event.change,
        draftChanges: (event.draftChanges ?? []).filter(item => !ids.has(item.id)) };
    }
  }
  const showExternal = externalRoute && event?.id === routeEventId && Object.hasOwn(externalRoles, role);
  const showPublic = publicRoute && Boolean(account) && event?.id === routeEventId;
  const pageTitle = showExternal || showPublic ? event.title : externalRoute || publicRoute ? '活动链接不可用' : pageLabel;

  useEffect(() => {
    const remote = shared?.workspaceRevision ?? 0;
    if (!account || localEvent.draftRevision == null || localEvent.draftDirty || remote <= localEvent.draftRevision) return;
    const request = new AbortController();
    ownerRegistration('/' + localEvent.id + '/draft', 'GET', undefined, request.signal).then(saved => {
      if (request.signal.aborted || !saved.data) return;
      setEvents(list => list.map(item => item.id === localEvent.id && !item.draftDirty && saved.revision > item.draftRevision
        ? restoreWorkspaceDraft(item, saved) : item));
    }).catch(error => { if (!request.signal.aborted) notify(error.message); });
    return () => request.abort();
  }, [account?.id, shared?.workspaceRevision, localEvent.id, localEvent.draftRevision, localEvent.draftDirty]);

  useEffect(() => {
    if (!useStoredEvents) return;
    try {
      localStorage.setItem('huixu.events.2', JSON.stringify(events));
    } catch {
      // 存储被禁用时，当前标签页仍可操作。
    }
  }, [useStoredEvents, events]);
  useEffect(() => {
    if (!useStoredEvents) return;
    const sync = e => { if (e.key === 'huixu.events.2') setEvents(loadEvents()); };
    window.addEventListener('storage', sync);
    return () => window.removeEventListener('storage', sync);
  }, [useStoredEvents]);
  useEffect(() => {
    if (!account) return;
    const controller = new AbortController();
    ownerRegistration('', 'GET', undefined, controller.signal).then(({ events: saved }) => {
      if (controller.signal.aborted) return;
      setEvents(current => {
        const loaded = saved.filter(item => !current.some(local => local.id === item.id));
        if (!loaded.length) return current;
        return [...current, ...loaded.map(({ savedDraft, ...item }) => {
          const local = { ...newEvent(item, item.id), ...item };
          return savedDraft ? restoreWorkspaceDraft(local, savedDraft) : local;
        })];
      });
    }).catch(() => {});
    return () => controller.abort();
  }, [account?.id]);
  useEffect(() => {
    document.title = pageTitle + ' · 会序';
  }, [pageTitle]);
  useEffect(() => {
    setModal('');
    setAgentDrawerOpen(false);
  }, [path, routeEventId, role]);
  useEffect(() => {
    if (dockAgent) setAgentDrawerOpen(false);
  }, [dockAgent]);
  useEffect(() => {
    const jump = pendingJump.current?.destination === location.hash ? pendingJump.current : null;
    pendingJump.current = null;
    const origin = sourceReturn.current;
    if (origin && origin.eventId !== event?.id) sourceReturn.current = null;
    if (origin?.eventId === event?.id && origin.hash === (location.hash || '#/overview')) {
      sourceReturn.current = null;
      const frame = requestAnimationFrame(() => {
        window.scrollTo({ top: origin.y, behavior: 'instant' });
        if (origin.agentOpen) setAgentDrawerOpen(true);
        if (origin.onReturn) origin.onReturn();
        else requestAnimationFrame(() => {
          const target = origin.element?.isConnected ? origin.element : document.getElementById(origin.elementId);
          target?.focus({ preventScroll: true });
        });
      });
      return () => cancelAnimationFrame(frame);
    }
    if (jump?.preserveScroll) return;
    const frame = requestAnimationFrame(() => {
      if (publicRoute || externalRoute || !path) window.scrollTo(0, 0);
      else jumpToActivity(route, Boolean(jump));
    });
    return () => cancelAnimationFrame(frame);
  }, [route, event?.id, externalRoute, publicRoute]);
  useEffect(() => {
    setAgentRun(conversation.current.get(event?.id)?.at(-1) ?? null);
    return () => agentRequest.current?.abort();
  }, [event?.id, publicRoute, externalRoute]);

  const dismissToast = useCallback(() => setToast(null), []);
  function notify(message) {
    toastId.current += 1;
    setToast({ id: toastId.current, text: message });
  }

  function navigate(id, { preserveScroll = false, onReturn, returnFocus, returnLabel } = {}) {
    // 原文只是一段临时查看路径，保留进入前的位置、抽屉与未保存的编辑上下文。
    if (/^sources\/\d+$/.test(id) && !/^#\/sources\/\d+$/.test(location.hash)) {
      const element = returnFocus ?? document.activeElement;
      sourceReturn.current = { hash: location.hash || '#/overview', y: window.scrollY, element, elementId: element?.id,
        eventId: event.id, agentOpen: agentDrawerOpen, onReturn, label: returnLabel ?? (agentDrawerOpen || element?.closest('.activity-agent') ? '返回 Agent 引用' : '返回查看位置') };
    } else if (!/^sources\/\d+$/.test(id) && '#/' + id !== sourceReturn.current?.hash) {
      sourceReturn.current = null;
    }
    setModal('');
    setAgentDrawerOpen(false);
    const destination = '#/' + id;
    if (location.hash === destination) {
      if (!preserveScroll) jumpToActivity(id.split('/'), true);
      return;
    }
    pendingJump.current = { destination, preserveScroll };
    location.hash = destination;
  }
  function closeSource() {
    navigate((sourceReturn.current?.hash ?? '#/sources').replace(/^#\/?/, ''), { preserveScroll: true });
  }
  function showModal(name) {
    setAgentDrawerOpen(false);
    setModal(name);
  }
  function closeAgent() {
    if (dockAgent) {
      setAgentDockOpen(false);
      agentToggle.current?.focus({ preventScroll: true });
    } else setAgentDrawerOpen(false);
  }
  function toggleAgent() {
    if (agentOpen) {
      closeAgent();
      return;
    }
    if (!dockAgent) {
      setAgentDrawerOpen(true);
      return;
    }
    setAgentDockOpen(true);
    requestAnimationFrame(() => {
      const panel = document.getElementById(agentId);
      (panel?.querySelector('textarea') ?? panel)?.focus({ preventScroll: true });
    });
  }
  function select(id, destination = 'overview') {
    setActiveId(id);
    if (useStoredEvents) sessionStorage.setItem('huixu.active', id);
    navigate(destination);
  }
  function update(transform, { syncing = false } = {}) {
    // 访客可预览 Agent 草稿，持久化仍由登录后的活动存储流程负责。
    setEvents(current => current.map(item => {
      if (item.id !== event.id) return item;
      const next = transform(item);
      if (syncing || item.draftRevision == null || !draftChanged(item, next)) return next;
      return { ...next, draftDirty: true };
    }));
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
  async function publish(candidate, recordMessage, reviewed) {
    const next = publishChange(event, candidate, recordMessage, reviewed);
    if (!account || !shared || next === event) return false;
    await registration.change('/schedule', 'PATCH', { revision: shared.revision, event: signupSnapshot(next) });
    update(current => ({ ...current, agenda: next.agenda, version: next.version, change: next.change, history: next.history, messages: next.messages }));
    notify(recordMessage ? '已发布，并记录演练通知' : '已发布安排');
    return true;
  }
  async function prepareRescue(incident, previous, preferred) {
    if (!account) {
      const analysis = analyzeRescue(event, incident);
      if (analysis.error) throw new Error(analysis.error);
      const issues = preferred ? validateRescuePlan(event, analysis.incident, preferred) : [];
      let preferredIndex = 0;
      if (preferred && !issues.length) {
        preferredIndex = analysis.plans.findIndex(plan => JSON.stringify(plan.moves) === JSON.stringify(preferred.moves));
        if (preferredIndex === -1) {
          analysis.plans.push(preferred);
          preferredIndex = analysis.plans.length - 1;
        }
      }
      analysis.plans = analysis.plans.map(plan => ({ ...plan, proof: JSON.stringify(plan.moves), impact: describeRescueImpact(event, plan) }));
      openChange({ id: previous?.id ?? uid(), kind: 'rescue', title: rescueTitle(analysis.incident),
        reason: rescueSummary(analysis), analysis, version: event.version, operationsKey: JSON.stringify(rescueOperations(event)),
        preferredIndex: issues.length ? -1 : preferredIndex, invalidatedSelection: issues.length ? { moves: preferred.moves, issues } : null });
      return;
    }
    if (!account || !shared) throw new Error('活动服务正在读取议程，请稍后重试。');
    const operations = rescueOperations(event);
    const result = await registration.change('/rescue/preview', 'POST', {
      revision: shared.revision, incident, operations, preferredMoves: preferred?.moves,
    });
    const { analysis, state, preferredIndex, invalidatedSelection } = result;
    const change = { id: previous?.id ?? uid(), kind: 'rescue', title: rescueTitle(analysis.incident),
      reason: rescueSummary(analysis), analysis, revision: state.revision, version: state.event.version,
      operationsKey: JSON.stringify(operations), preferredIndex, invalidatedSelection };
    if (previous) update(current => current.change?.id === previous.id ? { ...current, change } : current);
    else openChange(change);
    const run = { eventId: event.id, question: change.title, answer: change.reason,
      evidence: { title: event.title, version: change.version }, reviewChangeId: change.id };
    const context = rememberTurn(event, change.title, { ...run, proposal: { kind: 'rescue', analysis } });
    context.selected = preferredIndex >= 0 ? preferredIndex + 1 : undefined;
    run.context = context;
    const turns = (conversation.current.get(event.id) ?? []).filter(item => item.reviewChangeId !== change.id);
    conversation.current.set(event.id, [...turns, run].slice(-4));
    setAgentRun(run);
  }
  async function releaseRescue(change, option) {
    if (!account || !shared) throw new Error('活动服务暂不可用。');
    if (change.operationsKey !== JSON.stringify(rescueOperations(event))) throw new Error('现场或人员资料有更新，请重新计算。');
    const updated = await registration.change('/rescue/publish', 'POST', {
      changeId: change.id, revision: change.revision, incident: change.analysis.incident, moves: option.moves, proof: option.proof,
    });
    update(current => ({ ...current, change: current.change?.id === change.id ? null : current.change }));
    notify('整场调整已发布 · v' + updated.event.version + '，已生成通知草稿');
    navigate('change/released/' + change.id);
  }
  function refreshMoveChange() {
    const change = event.change;
    const session = event.agenda.find(item => item.id === change?.sessionId);
    if (!session || !change.moveRequest) return;
    const refreshed = makeMoveChange(event, session, change.moveRequest, change.reason);
    update(current => current.change?.id === change.id ? { ...current, change: { ...refreshed, id: change.id } } : current);
  }
  async function organize(eventId, run = true) {
    const token = (organizationRequests.current[eventId] ?? 0) + 1;
    organizationRequests.current[eventId] = token;
    setOrganizationRuns(current => ({ ...current, [eventId]: { token, pending: run } }));
    if (!run) return;
    try {
      await organizationRequest(eventId, 'POST', undefined, account?.id);
      if (organizationRequests.current[eventId] === token) {
        setOrganizationRuns(current => ({ ...current, [eventId]: { token, pending: false } }));
      }
    } catch (error) {
      if (organizationRequests.current[eventId] === token) {
        setOrganizationRuns(current => ({ ...current, [eventId]: { token, pending: false, error: error.message } }));
      }
    }
  }
  async function importFiles(eventId, files, agentAccess, replacementId) {
    if (!files.length || importingEvents.current.has(eventId)) return;
    importingEvents.current.add(eventId);
    let progress = {
      pending: true, total: files.length, done: 0, indexed: 0, duplicates: 0, errors: [],
      files: files.map((file, index) => ({ name: file.name, state: index === 0 ? '处理中' : '等待处理' })),
    };
    setImportRuns(current => ({ ...current, [eventId]: progress }));
    try {
      for (const [index, file] of files.entries()) {
        let result;
        let outcome;
        try { result = await importSource(eventId, file, agentAccess, replacementId); } catch (error) {
          outcome = { state: '导入失败', note: error.message, tone: 'rose' };
          progress = { ...progress, errors: [...progress.errors, { name: file.name, reason: error.message }] };
        }
        if (!outcome) {
          const { source, duplicate } = result;
          const tone = duplicate ? 'neutral' : source.state === '已索引' ? 'success' : 'amber';
          outcome = { state: duplicate ? '重复文件' : source.state, note: source.note, tone };
        }
        progress = { ...progress, done: progress.done + 1,
          indexed: progress.indexed + Number(Boolean(result?.source?.chunkCount && !result.duplicate)),
          duplicates: progress.duplicates + Number(Boolean(result?.duplicate)),
          files: progress.files.map((item, position) => {
            if (position === index) return { ...item, ...outcome };
            if (position === index + 1) return { ...item, state: '处理中' };
            return item;
          }),
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

  function create(next, files = [], agentAccess = false, message = '已创建可编辑的活动草稿') {
    setEvents(current => [...current, next]);
    setModal('');
    select(next.id, files.length ? 'sources' : next.organizedPlan?.topicPlan ? 'schedule/plan' : 'overview');
    if (files.length) importFiles(next.id, files, agentAccess);
    notify(message);
  }
  function copy() {
    const next = newEvent({ title: event.title + '（副本）', type: event.type, date: '', capacity: event.capacity });
    next.organizedPlan = { id: uid(), manual: true, topicPlan: true, event: { title: next.title, target: String(next.capacity || '') },
      agenda: (event.agenda.length ? event.agenda : event.organizedPlan?.agenda ?? []).map(row => ({
        id: uid(), name: row.title ?? row.name, duration: row.start && row.end ? String(minutes(row.end) - minutes(row.start)) : row.duration })),
      tasks: (event.tasks.length ? event.tasks : event.organizedPlan?.tasks ?? []).map(task => ({ id: uid(), name: task.name, offset: task.offset })),
      roles: [], supplies: [], venues: [], roster: [], budgetItems: [] };
    create(next);
  }
  function askLocal(text) {
    if (/办一?场|新建|创建/.test(text)) {
      setDraft({ text });
      showModal('create');
      return;
    }
    if (requestWholeClosure(text)) return;
    const session = event.agenda.find(item => text.includes(item.title)) ??
      event.agenda.find(item => (text.includes('圆桌') && item.title.includes('圆桌')) || (text.includes('工作坊') && item.title.includes('工作坊')));
    const closedRoom = text.match(/([ABC])\s*厅\s*(?:临时)?(?:关闭|不可用)/i)?.[1].toUpperCase();
    const room = [...text.matchAll(/([ABC])\s*厅/gi)].map(match => match[1].toUpperCase()).find(item => item !== closedRoom);
    const time = text.match(/\b(?:[01]?\d|2[0-3]):[0-5]\d\b/)?.[0].padStart(5, '0') ?? (text.includes('午餐后') ? '13:30' : '');
    if (!session || (!room && !time)) {
      setAgentRun({ eventId: event.id, question: text, error: '本机演练支持「把圆桌移到午餐后」「把工作坊换到 B 厅」和「我想办一场 150 人的论坛」。', code: 'MODEL_NOT_CONFIGURED' });
      return;
    }
    setAgentRun(null);
    openChange(makeMoveChange(event, session, { room: room || session.room, start: time || session.start, closedRoom }, 'Agent 根据本地规则生成的调整建议'));
  }

  function requestWholeClosure(question) {
    if (!account || !/(整场|全场|多环节|两个环节|2\s*个环节)/.test(question) || !/(关闭|停用|不可用)/.test(question)) return false;
    const explicitRoom = event.rooms.find(item => question.includes(item.id + '厅') || question.includes(item.id + ' 厅'));
    const sampleMainRoom = event.isSample && question.includes('主会场') && event.rooms.find(item => item.id === 'A');
    const room = explicitRoom || sampleMainRoom;
    const times = [...question.matchAll(/\b(?:[01]\d|2[0-3]):[0-5]\d\b/g)].map(match => match[0]);
    if (!room || times.length !== 2) return false;
    void prepareRescue({ kind: 'closure', room: room.id, at: times[0], until: times[1] }).catch(error =>
      setAgentRun({ eventId: event.id, question, error: error.message }));
    return true;
  }

  async function ask(question) {
    agentRequest.current?.abort();
    if (requestWholeClosure(question)) return;
    const request = new AbortController();
    agentRequest.current = request;
    setAgentRun({ eventId: event.id, question, pending: true });
    try {
      const previous = conversation.current.get(event.id) ?? [];
      const result = await askModel(question, event, request.signal, account?.id, previous.map(entry => entry.context));
      if (!request.signal.aborted) {
        const run = { ...result, eventId: event.id, question };
        if (!result.error) {
          run.context = rememberTurn(event, question, result);
          conversation.current.set(event.id, [...previous, run].slice(-4));
        }
        setAgentRun(run);
      }
    } catch (error) {
      if (!request.signal.aborted) setAgentRun({ eventId: event.id, question, error: error.message });
    } finally {
      if (agentRequest.current === request) agentRequest.current = null;
    }
  }

  function selectCandidate(number) {
    const turns = conversation.current.get(event.id);
    if (!agentRun?.context || turns?.at(-1) !== agentRun) return;
    const run = { ...agentRun, context: { ...agentRun.context, selected: number } };
    conversation.current.set(event.id, [...turns.slice(0, -1), run]);
    setAgentRun(run);
  }

  function stopAgent() {
    agentRequest.current?.abort();
    setAgentRun(current => current?.pending ? { ...current, pending: false, stopped: true } : current);
  }

  function reviewProposal(candidate) {
    const proposal = agentRun.proposal;
    if (proposal.kind === 'event') {
      setDraft({ text: agentRun.question, proposal });
      showModal('create');
      return;
    }
    if (proposal.kind === 'rescue') {
      if (proposal.eventId !== event.id) return;
      void prepareRescue(proposal.analysis.incident, null, candidate).catch(error =>
        setAgentRun(current => ({ ...current, error: error.message })));
      return;
    }
    const before = proposal.before;
    const session = event.agenda.find(item => item.id === before.id);
    if (proposal.eventId !== event.id || !session || session.start !== before.start || session.end !== before.end || session.room !== before.room) {
      setAgentRun(current => ({ ...current, proposal: null, error: '议程已更新，请重新向 Agent 提出调整。' }));
      return;
    }
    const change = makeMoveChange(event, session, {
      room: proposal.room, start: proposal.start, closedRoom: proposal.closedRoom, earliest: proposal.earliest,
    }, 'Agent 提出的调整建议', candidate);
    setAgentRun(current => ({ ...current, proposal: null, reviewChangeId: change.id }));
    openChange(change);
  }

  const sourceIssueId = path === 'sources' && routeEventId === 'issue' ? role : undefined;
  const props = { event, readOnly, mobile, update, navigate, notify, ask, openChange, publish, prepareRescue, releaseRescue,
    refreshMoveChange, copy, activateChange, openImport, openDraft: () => showModal('draft'), importFiles, sourceIssueId, registration,
    showDesignMaterials: path === 'materials' && routeEventId === 'design',
    focusTaskId: path === 'prep' && routeEventId === 'task' ? role : '',
    importRun: importRuns[event?.id], memoryEvidenceId: path === 'sources' && /^\d+$/.test(routeEventId) ? routeEventId : undefined,
    closeSource, sourceReturnLabel: sourceReturn.current?.label,
    releasedChangeId: path === 'change' && routeEventId === 'released' ? role : undefined,
    organize, organizationRun: organizationRuns[event?.id] };
  if ((publicRoute || externalRoute) && !showPublic && !showExternal) return <main className="unavailable-link">
    <h1>活动链接不可用</h1><p className="muted">请向活动负责人索取当前链接。</p>
  </main>;
  return <>
    {showExternal ? <ExternalForm key={routeEventId + role} {...props} role={role} /> : showPublic ? <PublicEvent key={routeEventId} event={event} preview /> :
      <div className="activity-shell">
        <a className="skip-link" href="#workbench" onClick={e => { e.preventDefault(); document.getElementById('workbench').focus(); }}>跳转到工作台内容</a>
        <header className="activity-topbar">
          <div className="activity-toolbar">
            <div className="activity-toolbar-context">
              <button type="button" className="activity-brand" aria-label="会序，返回活动概况" onClick={() => navigate('overview')}>
                <Calendar size={25} strokeWidth={1.9} aria-hidden="true" /><span>会序</span>
              </button>
              <Select label="切换活动" compact value={event.id} onChange={value => value === 'team-board' ? showModal('team') : select(value)}
                options={[{ value: 'team-board', label: '团队活动总览' }, ...events.map(item => ({ value: item.id, label: item.title, detail: item.type }))]} />
            </div>
            <div className="activity-toolbar-actions">
              {account && <button type="button" className="button toolbar-action" aria-label="新建活动" onClick={() => { setDraft(null); showModal('create'); }}>
                <Plus size={18} aria-hidden="true" /><span>新建</span>
              </button>}
              {!mobile && <Tooltip text="Agent 工作台"><button ref={agentToggle} type="button" className={'button toolbar-action' + (agentOpen ? ' primary' : '')}
                aria-label="切换 Agent 工作台" aria-expanded={agentOpen} aria-controls={dockAgent ? agentId : undefined}
                aria-haspopup={dockAgent ? undefined : 'dialog'} onClick={toggleAgent}><Sparkles size={18} aria-hidden="true" /><span>Agent</span></button></Tooltip>}
              <Tooltip text="模型设置"><button type="button" className="icon-button activity-settings" aria-label="模型设置" aria-haspopup="dialog"
                onClick={() => showModal('settings')}><Settings size={19} aria-hidden="true" /></button></Tooltip>
              <button type="button" className="icon-button activity-account" aria-label={account ? '打开账户设置' : '登录工作台'}
                aria-haspopup="dialog" onClick={() => showModal('account')}><AccountAvatar user={account} /></button>
            </div>
          </div>
        </header>
        <div className={'activity-layout' + (dockAgent && agentOpen ? ' with-agent' : '')}>
          <ActivityDirectory id={directoryId} page={page} mobile={mobile} navigate={navigate} agentOpen={agentOpen} toggleAgent={toggleAgent} />
          <main id="workbench" tabIndex={-1} className="workspace activity-workspace">
            <ActivitySections key={event.id} {...props} />
          </main>
          <AgentWorkspace key={event.id} id={agentId} event={event} account={account} docked={dockAgent} open={agentOpen} close={closeAgent}
            history={(conversation.current.get(event.id) ?? []).filter(turn => turn !== agentRun && turn.question !== agentRun?.question)}
            clearHistory={() => { agentRequest.current?.abort(); conversation.current.delete(event.id); setAgentRun(null); }}
            selectCandidate={selectCandidate}
            run={agentRun?.eventId === event.id ? agentRun : null} ask={ask} stop={stopAgent} askLocal={askLocal}
            openSettings={() => showModal('settings')} reviewProposal={reviewProposal}
            openSource={chunkId => navigate(`sources/${chunkId}`)} openReviewedChange={id => navigate(id ? `change/released/${id}` : 'change')} />
        </div>
      </div>}
    {modal === 'create' && <CreateEvent key={draft?.text ?? (draft?.importMode ? 'import' : 'new')} draft={draft} events={events} create={create} ownerId={account?.id} close={() => setModal('')} />}
    {modal === 'team' && <TeamBoard events={events.map(item => item.id === event.id ? event : item)} close={() => setModal('')} open={(id, target, change) => {
      if (change) setEvents(list => list.map(item => item.id === id && item.change?.id !== change.id
        ? { ...item, change, draftChanges: [item.change, ...(item.draftChanges ?? [])].filter(row => row && row.id !== change.id) } : item));
      select(id, target);
    }} />}
    {modal === 'account' && <AccountDialog {...auth} openTeam={() => setModal('team')} close={() => setModal('')} />}
    {modal === 'settings' && <ModelSettings ownerId={account?.id} close={() => setModal('')} />}
    {modal === 'draft' && account && <WorkspaceDraftDialog event={event} update={update} notify={notify} close={() => setModal('')} />}
    <Toast feedback={toast} dismiss={dismissToast} />
  </>;
}
