import { useEffect, useId, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, CalendarDays, Download, ExternalLink, MapPin, QrCode, Search, Send } from 'lucide-react';
import { Badge, Empty, PageHead, Panel, Table, Tabs } from './components';
import { CheckControl, Dialog, Notice, Popconfirm } from './interactions';
import { MarbleFlow } from './MarbleFlow';
import { Select } from './Select';
import { channels, dateLabel, materialKinds, materialText, participantCount, roomLabel, timeRange, uid } from './model';

const statuses = ['全部', '已确认', '待审核', '候补'];
const statusTone = { 已确认: 'success', 待审核: 'amber', 候补: 'purple' };

export function Registration({ event, update, notify }) {
  const [filter, setFilter] = useState('全部');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const [showQr, setShowQr] = useState(false);
  const [qr, setQr] = useState('');
  const [problem, setProblem] = useState('');
  const toolbar = useRef(null);
  const publicPath = '#/public/' + event.id;
  useEffect(() => {
    let active = true;
    if (showQr) {
      import('qrcode').then(({ default: qrCode }) => qrCode.toDataURL(new URL(publicPath, window.location.href).href, { width: 230, margin: 2 }))
        .then(url => { if (active) setQr(url); })
        .catch(() => { if (active) setQr('error'); });
    }
    return () => { active = false; };
  }, [publicPath, showQr]);
  const people = event.attendees.filter(person =>
    (filter === '全部' || person.status === filter) && (person.name.includes(query) || person.id.toLowerCase().includes(query.toLowerCase())));
  const pageSize = 10;
  const currentPage = Math.min(page, Math.max(0, Math.ceil(people.length / pageSize) - 1));
  function changeStatus(person, next) {
    if (next === '已确认') {
      const session = event.agenda.find(item => item.id === person.sessionId);
      const room = event.rooms.find(item => item.id === session?.room);
      if (participantCount(event) >= event.capacity || (room && participantCount(event, session.id) >= room.capacity)) {
        setProblem(person.name + '的报名未确认。活动或分场已满，可保留候补。');
        return;
      }
    }
    setProblem('');
    update(current => ({ ...current, attendees: current.attendees.map(item => item.id === person.id ? { ...item, status: next } : item) }));
    notify('报名状态已更新');
  }
  function moveToWaitlist(person) {
    changeStatus(person, '候补');
    requestAnimationFrame(() => {
      if (document.activeElement !== document.body) return;
      const nextAction = document.getElementById('confirm-' + person.id) ?? toolbar.current?.querySelector('input:checked');
      nextAction?.focus({ preventScroll: true });
    });
  }
  return <>
    <PageHead heading="h2" title="报名与发布" description="查看公开页、报名审核、分场名额和候补。">
      <button className="button" aria-haspopup="dialog" onClick={() => { setQr(''); setShowQr(true); }}><QrCode size={18} />报名二维码</button>
      <a className="button primary" href={publicPath}><ExternalLink size={17} />预览活动页</a>
    </PageHead>
    <Panel title="报名管理" action={<Badge tone="success">{participantCount(event)} / {event.capacity} 已确认</Badge>}>
      <div className="toolbar" ref={toolbar}>
        <Tabs label="报名状态" items={statuses} value={filter} onChange={value => { setFilter(value); setPage(0); setProblem(''); }} />
        <label className="search"><Search size={17} aria-hidden="true" /><input type="search" aria-label="搜索报名" placeholder="姓名或凭证" value={query} onChange={e => { setQuery(e.target.value); setPage(0); setProblem(''); }} /></label>
      </div>
      {problem && <Notice tone="warning" announce>{problem}</Notice>}
      {people.length ? <>
        <Table headers={['姓名', '分场', '状态', '个人凭证', '操作']}>{people.slice(currentPage * pageSize, (currentPage + 1) * pageSize).map(person => <tr key={person.id}>
          <td><strong>{person.name}</strong></td><td>{event.agenda.find(item => item.id === person.sessionId)?.title ?? '全场'}</td>
          <td><Badge tone={statusTone[person.status]}>{person.status}</Badge></td><td className="tabular">{person.id}</td>
          <td><div className="actions compact">{person.status === '已确认' ? <Popconfirm label="转候补" confirmLabel="确认转候补"
            description={'将' + person.name + '转为候补，并释放已确认名额？'} onConfirm={() => moveToWaitlist(person)} /> : <>
            <button className="button small" id={'confirm-' + person.id} onClick={() => changeStatus(person, '已确认')}>确认报名</button>
            {person.status !== '候补' && <button className="button small" onClick={() => changeStatus(person, '候补')}>加入候补</button>}
          </>}</div></td>
        </tr>)}</Table>
        <div className="pagination"><span className="muted">共 {people.length} 人 · 第 {currentPage + 1} 页</span>
          <button className="button small" onClick={() => setPage(currentPage - 1)} disabled={currentPage === 0}>上一页</button>
          <button className="button small" onClick={() => setPage(currentPage + 1)} disabled={(currentPage + 1) * pageSize >= people.length}>下一页</button></div>
      </> : <Empty>没有符合条件的报名。</Empty>}
    </Panel>
    <div className="split"><Panel title="报名设置">
      <CheckControl variant="switch" label="开放公开报名" description={event.formOpen ? '报名已开放' : '报名已暂停'} checked={event.formOpen} onChange={formOpen => {
        update(current => ({ ...current, formOpen }));
        notify(formOpen ? '已开放公开报名' : '已暂停公开报名');
      }} />
    </Panel><Panel title="票务接入"><p className="muted">本地演练使用免费报名。付费票、选座和退款待接入服务。</p></Panel></div>
    {showQr && <Dialog title="报名二维码" variant="drawer" close={() => setShowQr(false)}>
      <div className="qr-content">{qr === 'error' ? <Notice tone="error" announce>二维码生成失败，可使用下方链接。</Notice> : qr ? <img src={qr} alt="本机报名页二维码" width="230" height="230" /> : <div className="qr-skeleton" role="status"><span className="sr-only">正在生成二维码</span></div>}
        <p className="muted">二维码指向当前本机演练地址。</p><a className="button" href={publicPath} onClick={() => setShowQr(false)}>打开报名页</a></div>
    </Dialog>}
  </>;
}

export function PublicEvent({ event, update }) {
  const [registration, setRegistration] = useState(null);
  const agendaHeading = useRef(null);
  const registrationHeading = useRef(null);

  function register(e) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const name = form.get('name').trim();
    if (!name || !event.formOpen) return;
    const person = { id: 'P-' + uid().slice(0, 8).toUpperCase(), name, status: '待审核', sessionId: form.get('session') };
    update(current => ({ ...current, attendees: [...current.attendees, person] }));
    setRegistration(person);
  }
  const current = event.attendees.find(person => person.id === registration?.id);
  const registrationAvailable = Boolean(current || event.formOpen);
  return <div className="public-event">
    <header className="public-event-bar">
      <div className="public-event-inner">
        <a className="public-back" href="#/registration"><ArrowLeft size={17} aria-hidden="true" />返回报名管理</a>
        <Badge tone={event.version ? 'success' : 'neutral'}>{event.version ? '议程 v' + event.version : '草稿预览'}</Badge>
      </div>
    </header>
    <main className="public-event-inner public-event-content">
      <section className="public-hero" aria-labelledby="public-event-title">
        <div className="public-hero-media">
          <MarbleFlow variant="spectrum" />
          {event.type === '行业论坛'
            ? <div className="public-hero-photo"><img src="/conference.png" alt="" /></div>
            : <div className="public-hero-placeholder"><span>{event.type}</span></div>}
        </div>
        <div className="public-hero-copy">
          <MarbleFlow strength={0.8} />
          <h1 id="public-event-title">{event.title}</h1>
          <ul className="public-event-meta">
            <li><CalendarDays size={19} aria-hidden="true" />{dateLabel(event.date)}</li>
            <li><MapPin size={19} aria-hidden="true" />{event.venue}</li>
          </ul>
          {registrationAvailable ? <button className="button primary" type="button" onClick={() => registrationHeading.current.focus()}>
            {current ? '查看报名状态' : '前往报名'}<ArrowRight size={17} aria-hidden="true" />
          </button> : <button className="button primary" type="button" onClick={() => agendaHeading.current.focus()}>
            查看议程<ArrowRight size={17} aria-hidden="true" />
          </button>}
        </div>
      </section>
      <div className="public-event-details">
        <section className="public-agenda" aria-labelledby="public-agenda-heading">
          <h2 id="public-agenda-heading" ref={agendaHeading} tabIndex={-1}>活动议程</h2>
          <Table headers={['时间', '环节', '会场']}>{event.agenda.map(session => <tr key={session.id}>
            <td className="tabular">{timeRange(session)}</td><td>{session.title}</td><td>{roomLabel(session.room)}</td>
          </tr>)}</Table>
        </section>
        <section className="public-registration" aria-labelledby="public-registration-heading">
          <h2 id="public-registration-heading" ref={registrationHeading} tabIndex={-1}>活动报名</h2>
          {current ? <Notice tone="success" announce>报名已登记 · {current.status} · 个人凭证 {current.id}</Notice> : event.formOpen ? <form className="form-stack" onSubmit={register}>
            <label>姓名<input name="name" required maxLength="40" placeholder="填写演练姓名" /></label>
            <Select label="分场" name="session" options={[{ value: '', label: '全场活动' }, ...event.agenda.map(session => ({ value: session.id, label: session.title }))]} />
            <button className="button primary">提交报名</button>
          </form> : <Notice tone="warning">报名暂时关闭。</Notice>}
        </section>
      </div>
    </main>
  </div>;
}

function downloadText(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = name + '.txt';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function Materials({ event, update, notify }) {
  const [kind, setKind] = useState(materialKinds[0]);
  const [preview, setPreview] = useState(null);
  const [previewNeedsUpdate, setPreviewNeedsUpdate] = useState(false);
  const formId = useId();
  const text = materialText(event, kind);
  function markPreviewStale() {
    if (preview) setPreviewNeedsUpdate(true);
  }
  function previewMessage(e) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const role = form.get('role');
    const status = form.get('status');
    const sessionId = form.get('session');
    const people = role === '观众'
      ? event.attendees.filter(person => (status === '全部' || person.status === status) && (!sessionId || person.sessionId === sessionId)).map(person => person.name)
      : [...new Set(event.agenda.filter(session => !sessionId || session.id === sessionId).map(session => session.guest))];
    setPreview({ id: uid(), subject: event.title + ' · ' + kind, channel: form.get('channel'), body: text, people, count: people.length, version: event.version });
    setPreviewNeedsUpdate(false);
  }
  return <>
    <PageHead heading="h3" title="材料与沟通" description="从同一版计划生成材料，核对人群和渠道后记录演练发送。">
      <Badge tone={event.version ? 'success' : 'neutral'}>{event.version ? '发布版本 v' + event.version : '计划草稿'}</Badge>
    </PageHead>
    <Tabs label="材料类型" items={materialKinds} value={kind} onChange={value => { setKind(value); markPreviewStale(); }} />
    <div className="split">
      <Panel title={kind} action={<button className="button small" onClick={() => downloadText(event.title + ' · ' + kind, text)}><Download size={16} />导出文本</button>}>
        <pre className="document-preview">{text}</pre>
      </Panel>
      <Panel title="准备通知"><form id={formId} className="form-stack" onSubmit={previewMessage}>
        <Select label="角色" name="role" options={['观众', '嘉宾']} onChange={markPreviewStale} />
        <Select label="报名状态" name="status" defaultValue="已确认" options={statuses} onChange={markPreviewStale} />
        <Select label="场次" name="session" options={[{ value: '', label: '全部场次' }, ...event.agenda.map(session => ({ value: session.id, label: session.title }))]} onChange={markPreviewStale} />
        <Select label="渠道" name="channel" options={channels} onChange={markPreviewStale} />
        <button className="button primary"><Send size={17} />{preview ? '更新预览' : '预览通知'}</button>
      </form></Panel>
    </div>
    <Panel title="沟通记录">
      {event.messages.length ? <Table headers={['主题', '渠道', '人数', '版本', '结果']}>{event.messages.map(message => <tr key={message.id}>
        <td>{message.subject}</td><td>{message.channel}</td><td>{message.count}</td><td>{message.version ? 'v' + message.version : '草稿'}</td><td><Badge tone="success">演练已记录</Badge></td>
      </tr>)}</Table> : <Empty>暂无演练通知记录。</Empty>}
    </Panel>
    {preview && <Dialog title="通知预览" variant="drawer" close={() => setPreview(null)} footer={<>
      {previewNeedsUpdate && <button type="submit" form={formId} className="button">更新预览</button>}
      <button className="button primary" disabled={previewNeedsUpdate || !preview.count} onClick={() => {
        update(current => ({ ...current, messages: [{ ...preview, date: new Date().toLocaleString('zh-CN') }, ...current.messages] }));
        setPreview(null);
        notify('演练通知已记录');
      }}>记录演练发送</button>
    </>}>
      {previewNeedsUpdate && <Notice tone="warning" announce>材料或筛选条件已改变，请更新预览后再确认。</Notice>}
      <p>{preview.channel} · {preview.count} 位接收对象</p>
      <p className="muted">{preview.people.slice(0, 8).join('、')}{preview.count > 8 && ' 等'}</p>
      <pre className="document-preview">{preview.body}</pre>
      {!preview.count && <Notice tone="warning">当前筛选条件下没有接收对象。</Notice>}
    </Dialog>}
  </>;
}
