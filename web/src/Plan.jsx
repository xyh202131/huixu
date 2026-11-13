import { useEffect, useMemo, useState } from 'react';
import { ArrowRight, ArrowRightLeft, CalendarDays, FileText, MapPin, Monitor, UsersRound } from 'lucide-react';
import { Badge, Empty, IconTile, LinkButton, PageHead, Panel, Table, Tabs } from './components';
import { Dialog, Notice } from './interactions';
import { Select } from './Select';
import { ProjectMemory } from './ProjectMemory';
import { ImportReview, OrganizedPlan } from './ImportReview';
import { checkCandidate, makeChange, money, moveCandidate, participantCount, roomLabel, timeRange } from './model';
import { changeReviewKey, describeChangeImpact } from './changeImpact';
import { analyzeMove, checkinPoint } from './scheduling';

export function Sources({ event, readOnly, update, notify, navigate, importFiles, importRun, memoryEvidenceId, openImport, organize, organizationRun, sourceIssueId }) {
  const [selectedIssue, setSelectedIssue] = useState(sourceIssueId);
  useEffect(() => { if (sourceIssueId) setSelectedIssue(sourceIssueId); }, [sourceIssueId]);
  const issue = event.issues.find(item => item.id === (sourceIssueId ?? selectedIssue)) ?? event.issues.find(item => !item.resolved) ?? event.issues[0];
  function confirm(value) {
    update(current => ({
      ...current,
      budget: issue.id === 'budget' ? Number(value) : current.budget,
      issues: current.issues.map(item => item.id === issue.id ? { ...item, resolved: value } : item),
    }));
    notify('已保存到计划草稿');
  }
  return <>
    <PageHead heading="h2" title="资料与确认" description={readOnly ? '浏览活动资料，对照有冲突的原文。' : '批量导入资料，建立活动索引，核对原文。'}>
      {!readOnly && <button className="button" onClick={openImport}>导入为新活动</button>}
    </PageHead>
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
          {!readOnly && <button className="button" onClick={() => confirm(choice.value)} disabled={issue.resolved === choice.value}>采用 {issue.id === 'budget' ? money(choice.value) : choice.value}</button>}
        </article>)}</div>
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
      <Table headers={['文件', '状态']}>{event.files.map(file => <tr key={file.id}>
        <td>{file.name}</td><td><Badge tone={file.status.startsWith('样例') ? 'success' : 'neutral'}>{file.status}</Badge></td>
      </tr>)}</Table>
    </details>}
  </>;
}

export function Schedule({ event, readOnly, openChange, update, notify }) {
  const [room, setRoom] = useState('全部');
  const [editing, setEditing] = useState(null);
  const [problem, setProblem] = useState('');
  const [dragRoom, setDragRoom] = useState('');
  const sessions = [...event.agenda].sort((a, b) => a.start.localeCompare(b.start)).filter(item => room === '全部' || roomLabel(item.room) === room);
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
    <PageHead heading="h2" title="方案与议程" description={readOnly ? '查看各会场的容量、设备和议程安排。' : '查看各会场的安排，编辑时间或拖动环节，发布前统一校验。'}>
      <Badge tone={event.version ? 'success' : 'neutral'}>{event.version ? '发布版本 v' + event.version : '计划草稿'}</Badge>
    </PageHead>
    {event.organizedPlan && <div className="activity-anchor" id="activity-organized-plan">
      <OrganizedPlan key={event.organizedPlan.id} plan={event.organizedPlan} update={update} notify={notify} />
    </div>}
    <Panel title="会场安排">
      <div className="room-grid">{event.rooms.map(item => <div className={'room' + (dragRoom === item.id ? ' dragging' : '')} key={item.id}
        onDragOver={e => { if (!readOnly) { e.preventDefault(); setDragRoom(item.id); } }} onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget)) setDragRoom(''); }} onDrop={e => {
          if (readOnly) return;
          e.preventDefault();
          setDragRoom('');
          const session = event.agenda.find(entry => entry.id === e.dataTransfer.getData('text/plain'));
          if (session) createProposal(session, item.id, session.start);
        }}>
        <MapPin size={21} /><strong>{roomLabel(item.id)}</strong><span>{item.capacity} 个名额 · {item.equipment.join('、')}</span>
        {!readOnly && <small>拖动下方环节到这里换厅</small>}
      </div>)}</div>
    </Panel>
    <Panel title="活动议程" action={<Tabs label="按会场筛选" items={['全部', ...event.rooms.map(item => roomLabel(item.id))]} value={room} onChange={setRoom} />}>
      {problem && !editing && <Notice tone="warning" announce>{problem}</Notice>}
      <Table headers={['时间', '环节', '会场', '嘉宾', '确认报名', ...(readOnly ? [] : ['操作'])]}>
        {sessions.map(item => {
          const confirmedTime = event.issues.find(issue => issue.sessionId === item.id)?.resolved;
          return <tr key={item.id} draggable={!readOnly} onDragStart={e => { e.dataTransfer.setData('text/plain', item.id); e.dataTransfer.effectAllowed = 'move'; }} onDragEnd={() => setDragRoom('')}>
            <td className="tabular">{timeRange(item)}</td><td><strong>{item.title}</strong>
              {confirmedTime && confirmedTime !== item.start && <small className="field-note">资料草稿建议 {confirmedTime}</small>}</td>
            <td>{roomLabel(item.room)}</td><td>{item.guest}</td><td>{participantCount(event, item.id)} 人</td>
            {!readOnly && <td><button className="button small" aria-haspopup="dialog" onClick={() => { setProblem(''); setEditing(item); }}>调整</button></td>}
          </tr>;
        })}
      </Table>
      {!sessions.length && <Empty>该会场暂无议程。</Empty>}
    </Panel>
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
  const groups = ['已确认', '候补', '待审核'].map(status => ({ status, people: impact.registrations.filter(person => person.status === status) }));
  return <>
    <Panel title="受影响报名">
      <div className="actions compact">{groups.map(({ status, people }) => <Badge key={status}>{status} {people.length} 人</Badge>)}</div>
      <p className="muted">沿用原分场报名关系，已记录的分场签到 {impact.checkedIn} 人。</p>
      {impact.registrations.length > 0 && <details className="activity-file-history">
        <summary>查看受影响名单（{impact.registrations.length} 人）</summary>
        {groups.filter(group => group.people.length).map(({ status, people }) => <div className="impact-registration-group" key={status}>
          <strong>{status} · {people.length} 人</strong><p>{people.map(person => person.name).join('、')}</p>
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
  const [selection, setSelection] = useState(() => Math.max(0, choices.findIndex(item => item.issues.length === 0)));
  const [confirmation, setConfirmation] = useState(null);
  const [publishProblem, setPublishProblem] = useState('');
  const choice = choices[selection];
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
        <div className="selection-list">{choices.map(({ candidate, issues }, index) => <button key={candidate.room + candidate.start}
          aria-pressed={index === selection} onClick={() => setSelection(index)}>
          <span className="radio-mark" aria-hidden="true" /><strong>{roomLabel(candidate.room)}</strong>
          <Badge tone={issues.length ? 'amber' : 'success'}>{issues.some(issue => issue.startsWith('超出')) ? '容量不足' : issues.length ? '存在冲突' : '校验通过'}</Badge>
          <span className="choice-note">{change.moveRequest && (index === 0 ? '原请求 · ' : '备选 · ')}{timeRange(candidate)} · {event.rooms.find(room => room.id === candidate.room)?.capacity ?? '待确认'} 个名额</span>
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
      <button className="button" type="button" onClick={() => setConfirmation(null)}>返回核对</button>
      <button className="button primary" type="button" disabled={Boolean(stale) || choice.issues.length > 0} onClick={() => {
        if (!publish(choice.candidate, recordsNotice, confirmation.reviewed)) setPublishProblem('校验未通过，请返回核对候选方案。');
      }}>{publishLabel}</button>
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

export function ChangePage({ event, readOnly, publish, refreshMoveChange, navigate, activateChange }) {
  const latest = event.history[0];
  return <>
    <PageHead heading="h3" title="变更单" description={readOnly ? '比较候选方案，查看发布影响和通知预览。' : '核对影响、比较方案，再统一发布。'} />
    {event.change ? <ActiveChange key={event.change.id} event={event} readOnly={readOnly} publish={publish} refreshMoveChange={refreshMoveChange} /> : <Panel title={latest ? '最近发布' : '待发布变更'}>
      {latest ? <>
        <Notice tone="success">{latest.title}已发布 · v{latest.version} · {latest.notified ? '已记录演练通知' : '仅发布安排'}</Notice>
        <ImpactTable before={latest.before} after={latest.after} impact={latest.impact} />
        <div className="actions publish-actions"><LinkButton onClick={() => navigate('live')}>查看现场看板</LinkButton></div>
      </> : <Empty>{readOnly ? '暂无待发布的调整。' : '当前没有待发布的调整，可从议程或现场创建。'}</Empty>}
    </Panel>}
    {!event.change && latest?.impact && <AffectedPeople impact={latest.impact} />}
    {!event.change && latest?.notified && latest.impact && <ChangeNotices impact={latest.impact} />}
    {!readOnly && event.draftChanges?.length > 0 && <Panel title="其他待评估变更">
      <div className="selection-list">{event.draftChanges.map(change => <button key={change.id} onClick={() => activateChange(change)}>{change.title}<span className="muted">{change.reason}</span></button>)}</div>
    </Panel>}
  </>;
}
