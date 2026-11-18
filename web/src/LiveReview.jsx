import { useState } from 'react';
import { AlertTriangle, ClipboardCheck, Monitor, ScanLine } from 'lucide-react';
import { Badge, Empty, IconTile, PageHead, Panel, Table } from './components';
import { Dialog, MetricValue, Notice } from './interactions';
import { Select } from './Select';
import { liveAgenda, materialText, money, participantCount, roomLabel, timeRange, uid } from './model';
import { checkinPoint, sessionPeople } from './scheduling';
import { RescueIncidentForm } from './RescueChange';
import { rescueOperations } from './registrationRules';

export function Live({ event, readOnly, mobile, prepareRescue, registration }) {
  const [board, setBoard] = useState(false);
  const [report, setReport] = useState(false);
  const [scanResult, setScanResult] = useState(null);
  const [progressWarning, setProgressWarning] = useState(null);
  const [scanSession, setScanSession] = useState('');
  const [scanning, setScanning] = useState(false);
  const [recording, setRecording] = useState(false);
  const [postPerson, setPostPerson] = useState('');
  const sessions = event.agenda.toSorted((a, b) => a.start.localeCompare(b.start));
  const { current, next } = liveAgenda(event, sessions);
  const posts = mobile ? sessions.flatMap(session => sessionPeople(event, session)
    .filter(person => person.role === '分场引导').map(person => ({ session, person }))) : [];
  const post = posts.find(({ session, person }) => person.id === postPerson && !event.actual[session.id]?.ended);
  async function mark(session, action) {
    if (!registration.current || recording) return;
    if (action === 'started' && current) {
      setProgressWarning({ sessionId: session.id, message: '请先结束正在进行的环节，再记录下一场开始。' });
      return;
    }
    setProgressWarning(null);
    const stamp = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    setRecording(true);
    try {
      await registration.change('/actual', 'POST', { sessionId: session.id, action: action === 'started' ? 'start' : 'end',
        time: stamp, revision: registration.current.revision, operations: rescueOperations(event) });
    } catch (error) {
      setProgressWarning({ sessionId: session.id, message: error.message });
    } finally {
      setRecording(false);
    }
  }
  async function checkIn(e) {
    e.preventDefault();
    const formElement = e.currentTarget;
    const form = new FormData(formElement);
    const code = form.get('code').trim().toUpperCase();
    if (scanning || !registration.current) return;
    setScanning(true);
    try {
      const result = await registration.change('/checkins', 'POST', { code, sessionId: scanSession });
      const text = result.duplicate ? '已签到，人数保持不变。' : '签到成功';
      setScanResult({ tone: result.duplicate ? 'warning' : 'success', text: result.name + text });
      formElement.reset();
    } catch (error) {
      setScanResult({ tone: 'error', text: error.message });
    } finally {
      setScanning(false);
    }
  }
  const entranceCount = event.checkins.filter(item => !item.sessionId).length;
  const runbookRows = sessions.map(item => {
    const actual = event.actual[item.id];
    const progress = actual?.started ? actual.started + (actual.ended ? '–' + actual.ended : ' 开始') : '待开始';
    const location = roomLabel(item.room) + ' · 签到 / 引导';
    const action = actual?.ended ? <Badge tone="success">已结束</Badge> : <button className="button small" disabled={recording || !registration.current} onClick={() => mark(item, actual?.started ? 'ended' : 'started')}>
      {actual?.started ? '记录结束' : '记录开始'}</button>;
    if (mobile) return <li key={item.id} className="live-runbook-card">
      <div className="live-runbook-heading"><strong>{item.title}</strong><span className="tabular muted">{timeRange(item)}</span></div>
      <p className="muted">{location}</p>
      <div className="live-runbook-progress"><span>{progress}</span>{!readOnly && action}</div>
      {progressWarning?.sessionId === item.id && <Notice tone="warning" announce>{progressWarning.message}</Notice>}
    </li>;
    return <tr key={item.id}><td>{timeRange(item)}</td><td>{item.title}</td><td>{location}</td><td>{progress}</td>
      {!readOnly && <td>{action}</td>}</tr>;
  });
  return <>
    <PageHead heading="h2" title="现场执行" description={readOnly ? '查看入场统计、当前进度和执行台本。' : '查看现场进度、核验观众凭证，或上报异常并生成调整方案。'}>
      <button className="button" aria-haspopup="dialog" onClick={() => setBoard(true)}><Monitor size={17} />现场大屏</button>
      {!readOnly && <button className="button primary" aria-haspopup="dialog" onClick={() => setReport(true)}><AlertTriangle size={17} />上报问题</button>}
    </PageHead>
    {posts.length > 0 && <Panel title="我的现场岗位">
      <Select label="查看岗位人员" value={postPerson} onChange={setPostPerson} options={[{ value: '', label: '选择岗位人员' },
        ...new Map(posts.map(({ person }) => [person.id, { value: person.id, label: person.name }])).values()]} />
      {post && <p>{post.session.start} · {checkinPoint(post.session)} · {post.person.role} · {post.session.title}</p>}
      {postPerson && !post && <p className="muted">该人员本场岗位已全部结束。</p>}
    </Panel>}
    <div className="split"><Panel title="现场进度" action={<Badge tone="success">{event.version ? '议程 v' + event.version : '计划草稿'}</Badge>}>
      <div className="running"><IconTile icon={ClipboardCheck} /><div><span>当前环节</span><strong>{current?.title ?? '暂无进行中的环节'}</strong>
        {current && <small>{roomLabel(current.room)} · 实际开始 {event.actual[current.id].started}</small>}</div></div>
      <div className="running"><IconTile icon={Monitor} tone="blue" /><div><span>下一环节</span><strong>{next?.title ?? '活动结束'}</strong>
        {next && <small>{timeRange(next)} · {roomLabel(next.room)}</small>}</div></div>
    </Panel><Panel title="观众签到" action={<Badge tone="success">入场&nbsp;<MetricValue value={entranceCount} compact />&nbsp;人</Badge>}>
      {!readOnly && registration.pendingCheckins > 0 && <Notice tone="warning">
        {registration.migrationProblem || `有 ${registration.pendingCheckins} 条历史签到待同步。若原报名尚未迁移，请先在「报名与发布」导入旧名单。`}
        <button type="button" className="button small" onClick={registration.refresh}>重试同步</button>
      </Notice>}
      {!readOnly && <form className="form-stack" onSubmit={checkIn}>
        <Select label="签到点" value={scanSession} onChange={value => { setScanSession(value); setScanResult(null); }}
          options={[{ value: '', label: '活动入场' }, ...sessions.map(item => ({ value: item.id, label: checkinPoint(item) + ' · ' + item.title }))]} />
        <label>个人凭证<input name="code" autoCapitalize="characters" autoComplete="off" spellCheck={false}
          placeholder={event.isSample ? '演练凭证 G001' : '输入已确认观众的凭证'} required /></label>
        <button className="button primary" disabled={scanning || !registration.current}><ScanLine size={17} />核验并签到</button>
        {scanResult && <Notice tone={scanResult.tone} announce>{scanResult.text}</Notice>}
      </form>}
    </Panel></div>
    <Panel title="执行台本">
      {mobile ? <ul className="live-runbook-list">{runbookRows}</ul> : <>
        {progressWarning && <Notice tone="warning" announce>{progressWarning.message}</Notice>}
        <Table headers={['计划时间', '环节', '地点与岗位', '实绩', ...(readOnly ? [] : ['操作'])]}>{runbookRows}</Table>
      </>}
    </Panel>
    {board && <Dialog title="现场大屏预览" close={() => setBoard(false)}><LiveBoard event={event} current={current} next={next} /></Dialog>}
    {report && <Dialog title="上报现场问题" variant="drawer" close={() => setReport(false)}>
      <RescueIncidentForm event={event} onPrepare={async input => {
        await prepareRescue(input);
        setReport(false);
      }} />
    </Dialog>}
  </>;
}

function LiveBoard({ event, current, next }) {
  const release = event.history[0];
  return <div className="board"><h3>{event.title}</h3>
    <p>当前 · {current?.title ?? '待开始'}{current && ' · ' + roomLabel(current.room)}</p>
    <p>下一场 · {next ? next.title + ' · ' + roomLabel(next.room) + ' · ' + next.start : '无'}</p>
    {release?.kind === 'rescue' ? <div>
      <p>最新变更 · v{release.version}</p>
      <ul className="plain-list">{release.changes.map(({ before, after }) =>
        <li key={before.id}>{before.title} · {roomLabel(after.room)} · {timeRange(after)}</li>)}</ul>
    </div> : release && <p>最新变更 · {release.title} · {roomLabel(release.after.room)} · {timeRange(release.after)}</p>}
  </div>;
}

export function Review({ event, readOnly, copy, update, notify }) {
  const [preview, setPreview] = useState('');
  const total = participantCount(event);
  const checked = event.checkins.filter(item => !item.sessionId).length;
  const spending = event.quotes.reduce((sum, quote) => sum + quote.actual, 0);
  const cards = [['确认报名', total + ' 人'], ['实际入场', checked + ' 人'], ['入场率', total ? Math.round(checked * 100 / total) + '%' : '—'], ['预算 / 实支', money(event.budget) + ' / ' + money(spending)]];
  return <>
    <PageHead heading="h2" title="复盘与模板" description="回顾报名、到场、预算和执行情况，复用活动安排。">
      {!readOnly && <button className="button primary" onClick={copy}>复制为新活动</button>}
    </PageHead>
    <div className="metrics">{cards.map(([label, value]) => <div className="metric" key={label}><div><strong>{label}</strong><MetricValue value={value} /></div></div>)}</div>
    <Panel title="可复用的团队经验">
      <ul className="plain-list">{(event.teamLessons ?? []).map(lesson => <li key={lesson.id}>
        <strong>{lesson.condition}</strong> · {lesson.advice} <Badge>来源 v{lesson.version}</Badge>
        {!readOnly && <button type="button" className="link-button" onClick={() => update(current => ({
          ...current, teamLessons: current.teamLessons.filter(row => row.id !== lesson.id),
        }))}>取消复用</button>}
      </li>)}</ul>
      {!readOnly && <form className="form-stack" onSubmit={e => {
        e.preventDefault();
        const fields = new FormData(e.currentTarget);
        const lesson = { id: uid(), condition: fields.get('condition').trim(), advice: fields.get('advice').trim(), version: event.version };
        if (!lesson.condition || !lesson.advice) return;
        update(current => ({ ...current, teamLessons: [...(current.teamLessons ?? []), lesson] }));
        e.currentTarget.reset();
        notify('已确认可供后续活动参考');
      }}>
        <label>适用条件<input name="condition" maxLength="100" required placeholder="例如：论坛跨楼转场" /></label>
        <label>下次怎么做<input name="advice" maxLength="240" required placeholder="例如：两场之间预留 15 分钟" /></label>
        <button className="button">确认作为团队经验</button>
      </form>}
      {readOnly && !event.teamLessons?.length && <Empty>暂无经负责人确认的经验。</Empty>}
    </Panel>
    <Panel title="计划与实绩"><Table headers={['环节', '计划时间', '实际开始', '实际结束', '分场签到']}>{event.agenda.map(item => <tr key={item.id}>
      <td>{item.title}</td><td>{timeRange(item)}</td><td>{event.actual[item.id]?.started ?? '—'}</td><td>{event.actual[item.id]?.ended ?? '—'}</td>
      <td>{event.checkins.filter(checkin => checkin.sessionId === item.id).length} 人</td>
    </tr>)}</Table></Panel>
    <div className="split"><Panel title="会后资料与问卷">
      <div className="actions"><button className="button" aria-haspopup="dialog" onClick={() => setPreview('会后资料')}>预览资料</button><button className="button" aria-haspopup="dialog" onClick={() => setPreview('活动问卷')}>预览问卷</button></div>
    </Panel><Panel title="发布复盘">
      {event.history.length ? <ul className="plain-list">{event.history.map(item => <li key={item.id}>{item.title} · v{item.version} · {item.count} 人受影响</li>)}</ul> : <Empty>暂无发布记录。</Empty>}
    </Panel></div>
    {preview && <Dialog title={preview} variant="drawer" close={() => setPreview('')} footer={!readOnly &&
      <button className="button primary" disabled={!total} onClick={() => {
        const message = { id: uid(), subject: preview, channel: '演练通知', count: total, version: event.version };
        update(previous => ({ ...previous, messages: [message, ...previous.messages] }));
        setPreview('');
        notify('会后沟通演练已记录');
      }}>记录演练发送</button>
    }>
      <p className="muted">接收对象 · {total} 位已确认观众</p>
      <pre className="document-preview">{preview === '会后资料' ? materialText(event, '观众议程') : '您参与了哪些环节？\n您对活动安排满意吗？\n下一场希望有哪些改进？'}</pre>
      {!total && <Notice tone="warning">暂无已确认的接收对象。</Notice>}
    </Dialog>}
  </>;
}
