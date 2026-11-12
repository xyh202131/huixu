import { useState } from 'react';
import { AlertTriangle, ArrowRightLeft, ClipboardCheck, Monitor, ScanLine } from 'lucide-react';
import { Badge, Empty, IconTile, PageHead, Panel, Table } from './components';
import { Dialog, MetricValue, Notice } from './interactions';
import { Select } from './Select';
import { incidentChange, incidentKinds, materialText, money, participantCount, roomLabel, timeRange, uid } from './model';

export function Live({ event, readOnly, mobile, update, openChange }) {
  const [board, setBoard] = useState(false);
  const [report, setReport] = useState(false);
  const [scanResult, setScanResult] = useState(null);
  const [progressWarning, setProgressWarning] = useState(null);
  const [scanSession, setScanSession] = useState('');
  const sessions = [...event.agenda].sort((a, b) => a.start.localeCompare(b.start));
  const current = sessions.find(item => event.actual[item.id]?.started && !event.actual[item.id]?.ended);
  const next = sessions.find(item => !event.actual[item.id]?.started);
  function mark(session, action) {
    if (action === 'started' && current) {
      setProgressWarning({ sessionId: session.id, message: '请先结束正在进行的环节，再记录下一场开始。' });
      return;
    }
    setProgressWarning(null);
    const stamp = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
    update(previous => ({ ...previous, onsite: true, actual: {
      ...previous.actual, [session.id]: { ...previous.actual[session.id], [action]: stamp },
    } }));
  }
  function checkIn(e) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const code = form.get('code').trim().toUpperCase();
    const person = event.attendees.find(item => item.id === code);
    if (!person || person.status !== '已确认') return setScanResult({ tone: 'error', text: '凭证无效或报名尚未确认。' });
    if (scanSession && person.sessionId !== scanSession) return setScanResult({ tone: 'error', text: '该观众未报名此分场。' });
    if (event.checkins.some(item => item.personId === person.id && item.sessionId === scanSession)) {
      return setScanResult({ tone: 'warning', text: person.name + '已签到，人数保持不变。' });
    }
    update(previous => ({ ...previous, checkins: [...previous.checkins, { personId: person.id, sessionId: scanSession }] }));
    setScanResult({ tone: 'success', text: person.name + '签到成功' });
    e.currentTarget.reset();
  }
  const entranceCount = event.checkins.filter(item => !item.sessionId).length;
  const runbookRows = sessions.map(item => {
    const actual = event.actual[item.id];
    const progress = actual?.started ? actual.started + (actual.ended ? '–' + actual.ended : ' 开始') : '待开始';
    const location = roomLabel(item.room) + ' · 签到 / 引导';
    const action = actual?.ended ? <Badge tone="success">已结束</Badge> : <button className="button small" onClick={() => mark(item, actual?.started ? 'ended' : 'started')}>
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
    <div className="split"><Panel title="现场进度" action={<Badge tone="success">{event.version ? '议程 v' + event.version : '计划草稿'}</Badge>}>
      <div className="running"><IconTile icon={ClipboardCheck} /><div><span>当前环节</span><strong>{current?.title ?? '暂无进行中的环节'}</strong>
        {current && <small>{roomLabel(current.room)} · 实际开始 {event.actual[current.id].started}</small>}</div></div>
      <div className="running"><IconTile icon={Monitor} tone="blue" /><div><span>下一环节</span><strong>{next?.title ?? '活动结束'}</strong>
        {next && <small>{timeRange(next)} · {roomLabel(next.room)}</small>}</div></div>
    </Panel><Panel title="观众签到" action={<Badge tone="success">入场&nbsp;<MetricValue value={entranceCount} compact />&nbsp;人</Badge>}>
      {!readOnly && <form className="form-stack" onSubmit={checkIn}>
        <Select label="签到点" value={scanSession} onChange={value => { setScanSession(value); setScanResult(null); }}
          options={[{ value: '', label: '活动入场' }, ...sessions.map(item => ({ value: item.id, label: roomLabel(item.room) + ' · ' + item.title }))]} />
        <label>个人凭证<input name="code" autoCapitalize="characters" autoComplete="off" spellCheck={false}
          placeholder={event.isSample ? '演练凭证 G001' : '输入已确认观众的凭证'} required /></label>
        <button className="button primary"><ScanLine size={17} />核验并签到</button>
        {scanResult && <Notice tone={scanResult.tone} announce>{scanResult.text}</Notice>}
      </form>}
    </Panel></div>
    <Panel title="执行台本">
      {mobile ? <ul className="live-runbook-list">{runbookRows}</ul> : <>
        {progressWarning && <Notice tone="warning" announce>{progressWarning.message}</Notice>}
        <Table headers={['计划时间', '环节', '地点与岗位', '实绩', ...(readOnly ? [] : ['操作'])]}>{runbookRows}</Table>
      </>}
    </Panel>
    {board && <Dialog title="现场大屏预览" close={() => setBoard(false)}>
      <div className="board"><h3>{event.title}</h3><p>当前 · {current?.title ?? '待开始'}</p><p>下一场 · {next ? next.title + ' · ' + roomLabel(next.room) + ' · ' + next.start : '无'}</p>
        {event.history[0] && <p>最新变更 · {event.history[0].title} · {roomLabel(event.history[0].after.room)} · {timeRange(event.history[0].after)}</p>}</div>
    </Dialog>}
    {report && <Dialog title="上报现场问题" variant="drawer" close={() => setReport(false)}>
      <form className="form-stack" onSubmit={e => {
        e.preventDefault();
        const fields = new FormData(e.currentTarget);
        const change = incidentChange(event, fields.get('kind'), fields.get('session'));
        if (change) openChange(change);
        setReport(false);
      }}>
        <Select label="问题类型" name="kind" options={Object.entries(incidentKinds).map(([value, label]) => ({ value, label }))} />
        <Select label="受影响环节" name="session" defaultValue={event.change?.sessionId ?? sessions.at(-1)?.id}
          options={sessions.map(item => ({ value: item.id, label: item.title }))} />
        <button className="button primary"><ArrowRightLeft size={17} />生成调整方案</button>
      </form>
    </Dialog>}
  </>;
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
