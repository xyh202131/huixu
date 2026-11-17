import { useEffect, useMemo, useState } from 'react';
import { ArrowRight, ArrowRightLeft, CalendarDays, FileText, MapPin, Monitor, UsersRound } from 'lucide-react';
import { Badge, Empty, IconTile, LinkButton, PageHead, Panel, Table, Tabs } from './components';
import { Dialog, Notice } from './interactions';
import { Select } from './Select';
import { ActiveRescue, ReleasedRescue } from './RescueChange';
import { rescueOperations } from './registrationRules';
import { ProjectMemory } from './ProjectMemory';
import { ImportReview, OrganizedPlan } from './ImportReview';
import { checkCandidate, makeChange, money, moveCandidate, participantCount, roomLabel, timeRange } from './model';
import { changeReviewKey, describeChangeImpact } from './changeImpact';
import { analyzeMove, checkinPoint, sameCandidate } from './scheduling';

export function Sources({ event, readOnly, update, notify, navigate, importFiles, importRun, memoryEvidenceId, openImport, organize, organizationRun, sourceIssueId }) {
  const [selectedIssue, setSelectedIssue] = useState(sourceIssueId);
  const [editingSource, setEditingSource] = useState(null);
  useEffect(() => { if (sourceIssueId) setSelectedIssue(sourceIssueId); }, [sourceIssueId]);
  const issue = event.issues.find(item => item.id === (sourceIssueId ?? selectedIssue)) ?? event.issues.find(item => !item.resolved) ?? event.issues[0];
  const editingIssue = editingSource?.kind === 'issue';
  let editingStatus = editingSource?.status ?? editingSource?.record.reviewStatus ?? '待核对';
  if (editingIssue && editingSource.status === undefined && editingSource.record.resolved) editingStatus = '已确认';
  let editingType = 'text';
  if (editingSource?.record.sessionId) editingType = 'time';
  if (editingSource?.record.id === 'budget') editingType = 'number';
  function confirm(value, target = issue, note = '') {
    setSelectedIssue(target.id);
    update(current => ({
      ...current,
      budget: target.id === 'budget' && value ? Number(value) : current.budget,
      issues: current.issues.map(item => item.id === target.id ? { ...item, resolved: value, resolutionNote: note } : item),
    }));
    notify('已保存到计划草稿');
  }
  return <>
    <PageHead heading="h2" title="资料与确认" description={readOnly ? '浏览活动资料，对照有冲突的原文。' : '批量导入资料，建立活动索引，核对原文。'}>
      {!readOnly && <button className="button" onClick={openImport}>导入为新活动</button>}
    </PageHead>
    {readOnly && <Notice>当前为示例资料，核对修改保留在本次页面中。</Notice>}
    {event.issues.length > 0 && <Panel title="资料待确认">
      <div className="selection-list">{event.issues.map(item => <button key={item.id} aria-pressed={item.id === issue?.id} onClick={() => navigate('sources/issue/' + item.id)}>
        <span>{item.title}</span><Badge tone={item.resolved ? 'success' : 'amber'}>{item.resolved ? '已确认' : '待核对'}</Badge>
      </button>)}</div>
    </Panel>}
    {issue && <div className="activity-anchor" id={'activity-issue-' + issue.id}>
      <Panel title={issue.field} action={issue.resolved && <Badge tone="success">已采用 {issue.id === 'budget' ? money(issue.resolved) : issue.resolved}</Badge>}>
        <div className="evidence-grid">{issue.choices.map(choice => <article key={choice.file} className="evidence">
          <div className="file-title"><FileText size={18} /><strong>{choice.file}</strong></div><p className="muted">{choice.location}</p>
          <blockquote>{choice.quote}</blockquote>
          <button className="button" onClick={() => confirm(choice.value)} disabled={issue.resolved === choice.value}>采用 {issue.id === 'budget' ? money(choice.value) : choice.value}</button>
        </article>)}</div>
        {issue.resolutionNote && <p className="muted">核对依据　{issue.resolutionNote}</p>}
        <div className="actions">
          <button className="button" type="button" onClick={() => setEditingSource({ kind: 'issue', record: issue })}>修改状态与内容</button>
          {issue.resolved && <button className="button" type="button" onClick={() => confirm(null)}>重新标为待核对</button>}
        </div>
        {issue.resolved && issue.sessionId && <div className="actions publish-actions">
          <LinkButton onClick={() => navigate('schedule')}>查看议程中的草稿时间</LinkButton>
        </div>}
      </Panel>
    </div>}
    {!readOnly && <ProjectMemory eventId={event.id} importFiles={importFiles} importRun={importRun} evidenceId={memoryEvidenceId}
      onCloseEvidence={() => navigate('sources', { preserveScroll: true })} onAccessChange={allowed => organize(event.id, allowed)}>
      <ImportReview {...{ event, update, notify, navigate, organize, organizationRun, importRun }} />
    </ProjectMemory>}
    {event.files.length > 0 && <details className="activity-file-history">
      <summary>样例与旧资料登记（{event.files.length}）</summary>
      <Table headers={['文件', '解析状态', '核对状态', '操作']}>{event.files.map(file => <tr key={file.id}>
        <td>{file.name}{file.reviewNote && <small className="field-note">{file.reviewNote}</small>}</td><td><Badge tone={file.status.startsWith('样例') ? 'success' : 'neutral'}>{file.status}</Badge></td>
        <td><Badge>{file.reviewStatus ?? '待核对'}</Badge></td>
        <td><button type="button" className="button small" onClick={() => setEditingSource({ kind: 'file', record: file })}>修改核对状态</button></td>
      </tr>)}</Table>
    </details>}
    {editingSource && <Dialog title={editingSource.kind === 'issue' ? '核对资料 · ' + editingSource.record.field : '核对资料 · ' + editingSource.record.name}
      variant="drawer" fullOnMobile close={() => setEditingSource(null)}>
      <form className="form-stack" aria-label="修改资料核对结果" onSubmit={event => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        const note = String(form.get('note') ?? '').trim();
        if (editingSource.kind === 'issue') {
          const value = String(form.get('value') ?? '').trim();
          confirm(form.get('status') === '已确认' ? value : null, editingSource.record, note);
        } else {
          update(current => ({ ...current, files: current.files.map(file => file.id === editingSource.record.id
            ? { ...file, reviewStatus: form.get('status'), reviewNote: note } : file) }));
          notify('资料核对状态已保存');
        }
        setEditingSource(null);
      }}>
        <Select label="核对状态" name="status" value={editingStatus} onChange={status => setEditingSource(current => ({ ...current, status }))}
          options={editingSource.kind === 'issue' ? ['待核对', '已确认'] : ['待核对', '已确认', '已停用']} />
        {editingSource.kind === 'issue' && <label>采用内容<input name="value" maxLength={240}
          type={editingType} min={0} step={editingType === 'number' ? '0.01' : undefined} required={editingStatus === '已确认'}
          defaultValue={editingSource.record.resolved ?? ''} /></label>}
        <label>核对依据<textarea name="note" rows={3} maxLength={500} defaultValue={editingSource.record.resolutionNote ?? editingSource.record.reviewNote ?? ''} /></label>
        <button className="button primary">保存核对结果</button>
      </form>
    </Dialog>}
  </>;
}

export function Schedule({ event, readOnly, openChange, update, notify, navigate }) {
  const [room, setRoom] = useState('全部');
  const [editing, setEditing] = useState(null);
  const [problem, setProblem] = useState('');
  const [dragRoom, setDragRoom] = useState('');
  const agenda = event.agenda.toSorted((a, b) => a.start.localeCompare(b.start));
  const sessions = agenda.filter(item => room === '全部' || roomLabel(item.room) === room);
  function createProposal(item, target, start) {
    if (target === item.room && start === item.start) {
      setProblem('请选择新的会场或时间。');
      return;
    }
    openChange(makeChange(item, [moveCandidate(item, target, start)], '调整活动安排'));
    setEditing(null);
  }
  function closeEditor() {
    setEditing(null);
    setProblem('');
  }
  return <>
    <PageHead heading="h2" title="方案与议程" description={event.organizedPlan?.topicPlan && !agenda.length
      ? '编辑活动目标、环节和筹备事项，补齐方案里待确认的信息。'
      : readOnly ? '查看各会场的容量、设备和议程安排。' : '查看各会场的安排，编辑时间或拖动环节，发布前统一校验。'}>
      <Badge tone={event.version ? 'success' : 'neutral'}>{event.version ? '发布版本 v' + event.version : '计划草稿'}</Badge>
    </PageHead>
    {event.organizedPlan && <div className="activity-anchor" id="activity-organized-plan">
      <OrganizedPlan key={event.organizedPlan.id} plan={event.organizedPlan} update={update} notify={notify} navigate={navigate} />
    </div>}
    {event.organizedPlan?.topicPlan && !agenda.length ? <Notice>当前为方案草稿。具体时间和会场留待确认后排程。</Notice> : <>
    <Panel title="会场安排">
      <div className="room-grid">{event.rooms.map(item => {
        const label = roomLabel(item.id);
        const scheduled = agenda.filter(session => session.room === item.id);
        const next = scheduled.find(session => !event.actual[session.id]?.started);
        return <button type="button" className={'room schedule-room' + (dragRoom === item.id ? ' dragging' : '')} key={item.id}
          aria-pressed={room === label} onClick={() => setRoom(room === label ? '全部' : label)}
          onDragOver={e => { if (!readOnly) { e.preventDefault(); setDragRoom(item.id); } }} onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget)) setDragRoom(''); }} onDrop={e => {
            if (readOnly) return;
            e.preventDefault();
            setDragRoom('');
            const session = event.agenda.find(entry => entry.id === e.dataTransfer.getData('text/plain'));
            if (session) createProposal(session, item.id, session.start);
          }}>
          <MapPin size={20} aria-hidden="true" /><strong>{label}</strong>
          <span>{item.capacity} 个名额 · {scheduled.length} 个环节</span>
          {item.equipment.length > 0 && <span>{item.equipment.join('、')}</span>}
          {next && <span className="schedule-room-next">{next.start} · {next.title} · {participantCount(event, next.id)} 人已确认</span>}
          {!readOnly && <small>拖动下方环节到这里换厅</small>}
        </button>;
      })}</div>
    </Panel>
    <Panel title="活动议程" action={<Tabs label="按会场筛选" items={['全部', ...event.rooms.map(item => roomLabel(item.id))]} value={room} onChange={setRoom} />}>
      {problem && !editing && <Notice tone="warning" announce>{problem}</Notice>}
      <Table headers={['时间', '环节', '会场', '嘉宾', '确认报名', ...(readOnly ? [] : ['操作'])]}>
        {sessions.map(item => {
          const confirmedTime = event.issues.find(issue => issue.sessionId === item.id)?.resolved;
          const released = event.history.find(change => change.before?.id === item.id || change.changes?.some(row => row.before.id === item.id));
          return <tr key={item.id} draggable={!readOnly} onDragStart={e => { e.dataTransfer.setData('text/plain', item.id); e.dataTransfer.effectAllowed = 'move'; }} onDragEnd={() => setDragRoom('')}>
            <td className="tabular">{timeRange(item)}</td><td><strong>{item.title}</strong>
              {released && <div><LinkButton onClick={() => navigate(`change/released/${released.id}`)}>变更 v{released.version}</LinkButton></div>}
              {confirmedTime && confirmedTime !== item.start && <small className="field-note">资料草稿建议 {confirmedTime}</small>}</td>
            <td>{roomLabel(item.room)}</td><td>{item.guest}</td><td>{participantCount(event, item.id)} 人</td>
            {!readOnly && <td><button className="button small" aria-haspopup="dialog" onClick={() => { setProblem(''); setEditing(item); }}>调整</button></td>}
          </tr>;
        })}
      </Table>
      {!sessions.length && <Empty>该会场暂无议程。</Empty>}
    </Panel>
    </>}
    {editing && <Dialog key={editing.id} title={'调整' + editing.title} variant="drawer" close={closeEditor}>
      <form className="form-stack" onSubmit={e => {
        e.preventDefault();
        const values = new FormData(e.currentTarget);
        createProposal(editing, values.get('room'), values.get('start'));
      }}>
        <Select label="会场" name="room" defaultValue={editing.room} options={event.rooms.map(item => ({ value: item.id, label: roomLabel(item.id) }))} />
        <label>开始时间<input type="time" name="start" defaultValue={event.issues.find(issue => issue.sessionId === editing.id)?.resolved ?? editing.start} required /></label>
        {problem && <Notice tone="warning" announce>{problem}</Notice>}
        <button className="button primary">校验并预览变更</button>
      </form>
    </Dialog>}
  </>;
}

function ScheduleCard({ item, title, next }) {
  return <div className={'schedule-card' + (next ? ' next' : '')}>
    <strong>{title}</strong>
    <span><CalendarDays size={18} />{timeRange(item)}</span><span><MapPin size={18} />{roomLabel(item.room)}</span>
  </div>;
}

function ImpactTable({ before, after, impact }) {
  const beforeLabel = timeRange(before) + ' · ' + roomLabel(before.room);
  const afterLabel = timeRange(after) + ' · ' + roomLabel(after.room);
  const rows = [
    [CalendarDays, '公开议程', beforeLabel, afterLabel],
    [UsersRound, '嘉宾行程', beforeLabel, afterLabel],
    [MapPin, '签到点', impact?.checkin.before ?? checkinPoint(before), impact?.checkin.after ?? checkinPoint(after)],
    [FileText, '工作人员台本', beforeLabel, afterLabel],
    [Monitor, '现场大屏', beforeLabel, afterLabel],
  ];
  return <Table headers={['事项', '变更前', '变更后']}>{rows.map(([Icon, label, previous, current]) => <tr key={label}>
    <td><span className="inline-icon"><Icon size={17} />{label}</span></td><td>{previous}</td><td>{current}</td>
  </tr>)}</Table>;
}

function AffectedPeople({ impact }) {
  const groups = ['已确认', '候补', '待审核', '已取消'].map(status => ({ status, people: impact.registrations.filter(person => person.status === status) }));
  return <>
    <Panel title="受影响报名">
      <div className="actions compact">{groups.map(({ status, people }) => <Badge key={status}>{status} {people.length} 人</Badge>)}</div>
      <p className="muted">沿用原分场报名关系，已记录的分场签到 {impact.checkedIn} 人。</p>
      {impact.registrations.length > 0 && <details className="activity-file-history">
        <summary>查看受影响名单（{impact.registrations.length} 人）</summary>
        {groups.filter(group => group.people.length).map(({ status, people }) => <div className="impact-registration-group" key={status}>
          <strong>{status} · {people.length} 人</strong><p>{people.map(person => person.name + (person.attendance === '无法参加' ? '（无法参加）' : '')).join('、')}</p>
        </div>)}
      </details>}
    </Panel>
    <Panel title="受影响岗位与人员">
      <Table headers={['岗位', '负责人', '原安排', '新安排']}>{impact.posts.map(post => <tr key={post.role}>
        <td>{post.role}</td><td>{post.assignees.join('、') || '待分配'}</td><td>{post.before}</td><td>{post.after}</td>
      </tr>)}</Table>
      {impact.people.length ? <ul className="plain-list">{impact.people.map(({ role, name, availability }, index) => <li key={role + name + index}>
        {role} · {name} · {availability ? '可用 ' + timeRange(availability) : '可用时段待核对'}
      </li>)}</ul> : <p className="muted">当前环节的人员安排待确认。</p>}
    </Panel>
  </>;
}

function ChangeNotices({ impact }) {
  const { notice, personnelNotices = [] } = impact;
  return <Panel title="变更通知">
    <div className="notice-grid">
      <div className="recipient"><UsersRound size={21} /><div><span>接收对象</span><strong>{notice.recipients.length} 位已确认观众</strong></div></div>
      <div><p className="muted">通知预览（演练）</p><div className="message-preview">{notice.body}</div></div>
    </div>
    {personnelNotices.map(({ role, recipients, body }) => <div className="notice-grid impact-registration-group" key={role}>
      <div className="recipient"><UsersRound size={21} /><div><span>{role} · {recipients.length} 人</span><strong>{recipients.join('、')}</strong></div></div>
      <div><p className="muted">通知预览（演练）</p><div className="message-preview">{body}</div></div>
    </div>)}
  </Panel>;
}

function ActiveChange({ event, readOnly, publish, refreshMoveChange }) {
  const change = event.change;
  const choices = change.candidates.map(candidate => ({ candidate, issues: checkCandidate(event, change, candidate) }));
  const [selectedCandidate, setSelectedCandidate] = useState(change.preferredCandidate);
  const choice = choices.find(({ candidate }) => sameCandidate(candidate, selectedCandidate))
    ?? choices.find(item => item.issues.length === 0) ?? choices[0];
  const [confirmation, setConfirmation] = useState(null);
  const [publishProblem, setPublishProblem] = useState('');
  const [publishing, setPublishing] = useState(false);
  const count = participantCount(event, change.sessionId);
  const impact = choice && describeChangeImpact(event, change, choice.candidate);
  const audienceCount = impact?.notice.recipients.length ?? 0;
  const personnelCount = impact?.personnelNotices.reduce((total, group) => total + group.recipients.length, 0) ?? 0;
  const unknownAvailability = impact?.people.filter(person => !person.availability).length ?? 0;
  const reviewed = impact && changeReviewKey(event, change, choice.candidate, impact);
  const stale = confirmation && confirmation.reviewed !== reviewed;
  const recordsNotice = confirmation?.mode === 'notify';
  const publishLabel = recordsNotice ? '发布并记录演练通知' : '仅发布';
  const hasFeasible = choices.some(option => !option.issues.length);
  const analysis = useMemo(() => {
    if (hasFeasible || !change.moveRequest) return null;
    return analyzeMove(event, change.before, change.moveRequest);
  }, [event, change, hasFeasible]);
  const hasNewAlternatives = analysis?.alternatives.length > 0;
  function openPublish(mode) {
    setPublishProblem('');
    setConfirmation({ mode, reviewed });
  }
  return <>
    <Panel className="change-summary">
      <div className="change-title"><IconTile icon={ArrowRightLeft} /><h2>{change.title}</h2><Badge tone="amber">待发布</Badge></div>
      <Notice>{change.reason} · {count} 人已确认 · 原安排 {timeRange(change.before)}</Notice>
    </Panel>
    <div className="split change-split">
      <Panel title="候选方案" action={!readOnly && change.moveRequest && <button type="button" className="button small" onClick={refreshMoveChange}>重新搜索备选</button>}>
        {analysis && <Notice tone="warning" announce>
          {hasNewAlternatives ? '已找到新的可行时段，请重新搜索备选后核对。'
            : `${timeRange(analysis.window)} 的搜索范围内暂无可行方案。请核对容量、设备或人员时间后重新分析。`}
        </Notice>}
        <div className="selection-list">{choices.map(({ candidate, issues }, index) => <button key={`${candidate.room}/${candidate.start}/${candidate.end}`}
          aria-pressed={candidate === choice?.candidate} onClick={() => setSelectedCandidate(candidate)}>
          <span className="radio-mark" aria-hidden="true" /><strong>{roomLabel(candidate.room)}</strong>
          <Badge tone={issues.length ? 'amber' : 'success'}>{issues.some(issue => issue.startsWith('超出')) ? '容量不足' : issues.length ? '存在冲突' : '校验通过'}</Badge>
          <span className="choice-note">{change.moveRequest && (index === 0 ? '原请求 · ' : issues.length ? '待核对 · ' : '备选 · ')}{timeRange(candidate)} · {event.rooms.find(room => room.id === candidate.room)?.capacity ?? '待确认'} 个名额</span>
        </button>)}</div>
        {!choice && <Empty>没有可用候选。请确认场地和资源后重新校验。</Empty>}
        {choice?.issues.length > 0 && <Notice tone="warning" announce>{choice.issues.join(' · ')}</Notice>}
        {analysis && !hasNewAlternatives && analysis.blocked.length > 0 && <ul className="plain-list">
          {analysis.blocked.map(({ candidate, issues }) => <li key={candidate.room}>
            <strong>{roomLabel(candidate.room)} · {timeRange(candidate)}</strong>　{issues.join('、')}
          </li>)}
        </ul>}
        {choice && <div className="schedule-compare"><ScheduleCard item={change.before} title="原安排" /><ArrowRight size={19} /><ScheduleCard item={choice.candidate} title="新安排" next /></div>}
      </Panel>
      <Panel title="发布影响">
        {choice ? <ImpactTable before={change.before} after={choice.candidate} impact={impact} /> : <Empty>选定方案后查看发布影响。</Empty>}
      </Panel>
    </div>
    {impact && <AffectedPeople impact={impact} />}
    {impact && <ChangeNotices impact={impact} />}
    {!readOnly && <div className="actions publish-actions">
      <button className="button" aria-haspopup="dialog" disabled={!choice || choice.issues.length > 0} onClick={() => openPublish('publish')}>仅发布</button>
      <button className="button primary" aria-haspopup="dialog" disabled={!choice || choice.issues.length > 0 || !(audienceCount + personnelCount)} onClick={() => openPublish('notify')}>发布并记录演练通知</button>
    </div>}
    {confirmation && choice && <Dialog title="确认发布变更" close={() => setConfirmation(null)} footer={<>
      <button className="button" type="button" disabled={publishing} onClick={() => setConfirmation(null)}>返回核对</button>
      <button className="button primary" type="button" disabled={publishing || Boolean(stale) || choice.issues.length > 0} onClick={async () => {
        setPublishing(true);
        setPublishProblem('');
        try {
          if (!await publish(choice.candidate, recordsNotice, confirmation.reviewed)) setPublishProblem('校验未通过，请返回核对候选方案。');
        } catch (error) {
          setPublishProblem(error.message);
        } finally {
          setPublishing(false);
        }
      }}>{publishing ? '正在发布…' : publishLabel}</button>
    </>}>
      <p><strong>{change.title}</strong> · {timeRange(choice.candidate)} · {roomLabel(choice.candidate.room)}</p>
      <Notice tone={choice.issues.length ? 'warning' : 'info'}>{choice.issues.length ? choice.issues.join(' · ') : '公开议程、签到点、岗位清单、执行台本和现场大屏将同步更新。'}</Notice>
      {unknownAvailability > 0 && <Notice tone="warning">有 {unknownAvailability} 位已安排人员未登记可用时段，请核对后确认。</Notice>}
      {recordsNotice && <p className="muted">本次将为 {audienceCount} 位已确认观众{personnelCount ? `和 ${personnelCount} 位嘉宾或分场引导人员` : ''}记录演练通知。</p>}
      {stale && <Notice tone="error" announce>报名、人员、签到或发布版本已更新，请返回核对最新影响。</Notice>}
      {publishProblem && <Notice tone="error" announce>{publishProblem}</Notice>}
    </Dialog>}
  </>;
}

export function ChangePage({ event, readOnly, publish, refreshMoveChange, navigate, activateChange, releasedChangeId, prepareRescue, releaseRescue, registration }) {
  const selectedRelease = event.history.find(change => change.id === releasedChangeId);
  const latest = selectedRelease ?? event.history[0];
  const showDraft = event.change && !selectedRelease;
  const rescueDraft = showDraft && event.change.kind === 'rescue';
  const rescueRelease = !showDraft && latest?.kind === 'rescue';
  const stale = rescueDraft && (registration.current?.revision !== event.change.revision ||
    event.change.operationsKey !== JSON.stringify(rescueOperations(event)));
  return <>
    <PageHead heading="h3" title="变更单" description={readOnly ? '比较候选方案，查看发布影响和通知预览。' : '核对影响、比较方案，再统一发布。'} />
    {rescueDraft ? <ActiveRescue key={JSON.stringify([event.change.id, event.change.revision, event.change.analysis.incident, event.change.preferredIndex])}
      event={event} change={event.change} readOnly={readOnly} stale={stale} prepareRescue={prepareRescue} releaseRescue={releaseRescue} />
      : rescueRelease ? <ReleasedRescue release={latest} navigate={navigate} />
      : showDraft ? <ActiveChange key={event.change.id} event={event} readOnly={readOnly} publish={publish} refreshMoveChange={refreshMoveChange} /> : <Panel title={selectedRelease ? '发布记录' : latest ? '最近发布' : '待发布变更'}>
      {latest ? <>
        <Notice tone="success">{latest.title}已发布 · v{latest.version} · {latest.notified ? '已记录演练通知' : '仅发布安排'}</Notice>
        <ImpactTable before={latest.before} after={latest.after} impact={latest.impact} />
        <div className="actions publish-actions">
          <LinkButton onClick={() => navigate('live')}>查看现场看板</LinkButton>
          {selectedRelease && event.change && <LinkButton onClick={() => navigate('change')}>返回待发布变更单</LinkButton>}
        </div>
      </> : <Empty>{readOnly ? '暂无待发布的调整。' : '当前没有待发布的调整，可从议程或现场创建。'}</Empty>}
    </Panel>}
    {rescueRelease && selectedRelease && event.change && <LinkButton onClick={() => navigate('change')}>返回待发布变更单</LinkButton>}
    {!showDraft && latest?.impact && <AffectedPeople impact={latest.impact} />}
    {!showDraft && latest?.notified && latest.impact && <ChangeNotices impact={latest.impact} />}
    {!selectedRelease && !readOnly && event.draftChanges?.length > 0 && <Panel title="其他待评估变更">
      <div className="selection-list">{event.draftChanges.map(change => <button key={change.id} onClick={() => activateChange(change)}>{change.title}<span className="muted">{change.reason}</span></button>)}</div>
    </Panel>}
  </>;
}
