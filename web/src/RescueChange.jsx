import { useState } from 'react';
import { ArrowRightLeft } from 'lucide-react';
import { Badge, Empty, LinkButton, Panel, Table } from './components';
import { Dialog, Notice } from './interactions';
import { rescueKinds, rescueSummary } from './rescueScheduling';
import { checkinPoint, roomLabel, timeRange } from './scheduling';
import { Select } from './Select';

export function RescueIncidentForm({ event, incident, onPrepare }) {
  const [kind, setKind] = useState(incident?.kind ?? 'closure');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const pending = event.agenda.filter(item => !event.actual[item.id]?.started);
  const running = event.agenda.filter(item => event.actual[item.id]?.started && !event.actual[item.id]?.ended);
  const sessions = kind === 'overrun' ? running : pending;
  const now = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const from = incident?.at ?? (event.isSample ? '12:50' : now);
  const latest = event.agenda.reduce((end, item) => item.end > end ? item.end : end, '18:00');
  return <form className="form-stack" onSubmit={async event => {
    event.preventDefault();
    const input = Object.fromEntries(new FormData(event.currentTarget));
    setBusy(true);
    setProblem('');
    try { await onPrepare(input); }
    catch (error) { setProblem(error.message); }
    finally { setBusy(false); }
  }}>
    <Select label="问题类型" name="kind" options={Object.entries(rescueKinds).map(([value, label]) => ({ value, label }))} value={kind} onChange={setKind} />
    {kind === 'closure' ? <Select label="关闭的会场" name="room" defaultValue={incident?.room}
      options={event.rooms.map(room => ({ value: room.id, label: roomLabel(room.id) }))} /> : <>
      {sessions.length ? <Select label={kind === 'late' ? '迟到嘉宾所在环节' : '正在超时的环节'} name="sessionId"
        key={kind} defaultValue={incident?.sessionId} options={sessions.map(session => ({ value: session.id, label: session.title }))} />
        : <Notice tone="warning">{kind === 'overrun' ? '请先记录环节实际开始。' : '没有待开始的环节。'}</Notice>}
      <label>{kind === 'late' ? '预计抵达时间' : '预计结束时间'}<input type="time" name="resume" defaultValue={incident?.resume} required /></label>
    </>}
    <div className="form-grid">
      <label>事件开始时间<input type="time" name="at" defaultValue={from} required /></label>
      <label>最晚结束时间<input type="time" name="until" defaultValue={incident?.until ?? latest} required /></label>
    </div>
    <p className="muted">系统会保留环节原有时长，校验会场容量、设备、人员时段及 10 分钟跨厅转场。</p>
    {problem && <Notice tone="warning" announce>{problem}</Notice>}
    <button className="button primary" disabled={busy || (kind === 'closure' ? !event.rooms.length : !sessions.length)}>
      <ArrowRightLeft size={17} aria-hidden="true" />{busy ? '正在联合校验…' : '生成整场调整方案'}
    </button>
  </form>;
}

export function RescueBlockers({ analysis }) {
  if (!analysis.blocked.length) return null;
  return <details className="import-review-detail" open={!analysis.plans.length || undefined}>
    <summary>{analysis.plans.length ? '查看排除的会场和组合' : '查看排程卡点'}</summary>
    <ul className="plain-list">{analysis.blocked.map(({ title, room, reasons }) => <li key={title + (room ?? '')}>
      <strong>{title}{room && ' · ' + roomLabel(room)}</strong><br />{reasons.join('；')}
    </li>)}</ul>
  </details>;
}

function RescueImpact({ changes }) {
  return <Table label="整场调整前后对照" pinRowHeader headers={['环节', '原安排', '新安排与签到点', '报名与岗位']}>{changes.map(({ before, after, impact }) => <tr key={before.id}>
    <th scope="row">{before.title}</th>
    <td>{roomLabel(before.room)} · {timeRange(before)}<small className="field-note">{impact.checkin.before}</small></td>
    <td>{roomLabel(after.room)} · {timeRange(after)}<small className="field-note">{impact.checkin.after}</small></td>
    <td>{impact.notice.recipients.length} 位确认观众 · {impact.checkedIn} 人已签到
      {impact.posts.map(post => <small key={post.role} className="field-note">{post.role} · {post.assignees.join('、') || '待分配'}</small>)}
      {before.room !== after.room && <small className="field-note">现场跟进 · 更换签到指引，核对所需设备。</small>}
    </td>
  </tr>)}</Table>;
}

function RescueNotices({ notices }) {
  if (!notices.length) return <Empty>当前安排暂无已登记的通知对象。</Empty>;
  return <div className="rescue-notices">{notices.map((notice, index) => <details className="import-review-detail" key={index}>
    <summary>{notice.role} · {notice.recipients.length} 人</summary>
    <p className="muted">对象 · {notice.recipients.map(person => person.name).join('、')}</p>
    <div className="message-preview">{notice.body}</div>
  </details>)}</div>;
}

export function ActiveRescue({ event, change, readOnly, stale, prepareRescue, releaseRescue }) {
  const [selected, setSelected] = useState(change.preferredIndex);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const { analysis } = change;
  const option = analysis.plans[selected];
  const time = timeRange({ start: analysis.incident.at, end: analysis.incident.until });
  return <>
    <Panel title={change.title} action={<Badge>议程 v{change.version} · {time}</Badge>}>
      {stale && <Notice tone="warning" announce>报名、资源或现场状态已更新，请重新计算后再发布。</Notice>}
      <p>{rescueSummary(analysis)}</p>
      <ul className="plain-list">{analysis.affected.map(item => <li key={item.id}>
        <strong>{item.title}</strong> · {roomLabel(item.room)} · {timeRange(item)} · {item.confirmed} 人占位
        {item.equipment.length > 0 && ' · 需要' + item.equipment.join('、')}
        {item.uncheckedPeople > 0 && ' · ' + item.uncheckedPeople + ' 位人员的可用时段待核对'}
      </li>)}</ul>
      {analysis.unchanged.length > 0 && <details className="import-review-detail">
        <summary>保持原安排的环节（{analysis.unchanged.length}）</summary>
        <ul>{analysis.unchanged.map(item => <li key={item.id}>{item.title} · {roomLabel(item.room)} · {timeRange(item)}</li>)}</ul>
      </details>}
      <RescueBlockers analysis={analysis} />
      {analysis.plans.length > 0 && <div className="selection-list" aria-label="整场备选方案">{analysis.plans.map((plan, index) =>
        <button type="button" key={plan.proof} aria-pressed={selected === index} onClick={() => setSelected(index)}>
          <span className="radio-mark" aria-hidden="true" /><strong>{index === 0 ? '推荐方案' : '备选 ' + index}</strong>
          <Badge tone={stale ? 'amber' : 'success'}>{stale ? '待重新校验' : '组合校验通过'}</Badge>
          <span className="choice-note">{plan.moves.map(move => roomLabel(move.room) + ' ' + timeRange(move)).join(' · ')}</span>
        </button>)}</div>}
      {!readOnly && <details className="import-review-detail" open={!option || stale || undefined}>
        <summary>{stale ? '按最新状态重新计算' : '调整事件条件'}</summary>
        <RescueIncidentForm event={event} incident={analysis.incident} onPrepare={input => prepareRescue(input, change)} />
      </details>}
    </Panel>
    {option && <>
      <Panel title="统一发布影响"><RescueImpact changes={option.impact.rows} />
        <p className="muted">公开议程、签到选择、岗位清单、台本和大屏读取同一个发布版本。</p></Panel>
      <Panel title="受影响人员通知" action={<Badge>{option.impact.count} 人次</Badge>}><RescueNotices notices={option.impact.notices} /></Panel>
      {!readOnly && <div className="actions">
        <button type="button" className="button primary" disabled={stale} onClick={() => { setProblem(''); setConfirm(true); }}>
          核对并发布整场调整
        </button>
      </div>}
    </>}
    {confirm && option && <Dialog title="确认发布整场调整" close={() => { if (!busy) setConfirm(false); }} footer={<>
      <button className="button" disabled={busy} onClick={() => setConfirm(false)}>返回核对</button>
      <button className="button primary" disabled={busy || stale} onClick={async () => {
        setBusy(true);
        setProblem('');
        try { await releaseRescue(change, option); }
        catch (error) { setProblem(error.message); }
        finally { setBusy(false); }
      }}>{busy ? '正在发布…' : '确认发布并生成通知'}</button>
    </>}>
      <p>{option.impact.rows.length} 个环节将一起发布为 v{change.version + 1}，并生成 {option.impact.notices.length} 组通知草稿。</p>
      <Notice>发布时复查报名和现场状态，保留既有报名凭证与签到实绩。</Notice>
      {(stale || problem) && <Notice tone="warning" announce>{problem || '确认依据已更新，请返回重新计算。'}</Notice>}
    </Dialog>}
  </>;
}

export function ReleasedRescue({ release, navigate }) {
  return <>
    <Panel title="整场调整发布记录">
      <Notice tone="success">{release.title}已发布 · v{release.version} · {release.changes.length} 个环节</Notice>
      <RescueImpact changes={release.changes} />
      <LinkButton onClick={() => navigate('live')}>查看现场看板</LinkButton>
    </Panel>
    <Panel title="已生成的通知草稿" action={<Badge>{release.count} 人次</Badge>}><RescueNotices notices={release.notices} /></Panel>
  </>;
}
