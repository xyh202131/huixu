import { useEffect, useId, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, CalendarDays, Download, ExternalLink, MapPin, Plus, QrCode, Search, Send, Upload } from 'lucide-react';
import { Badge, Empty, PageHead, Panel, Table, Tabs } from './components';
import { CheckControl, Dialog, Notice, Popconfirm } from './interactions';
import { MarbleFlow } from './MarbleFlow';
import { Select } from './Select';
import { DesignMaterials } from './DesignMaterials';
import { ImportRegistrations, RegistrationEditor, RegistrationMailRecords } from './RegistrationManagement';
import { reservesSeat, reviewStatuses } from './registrationRules';
import { channels, dateLabel, materialKinds, materialText, participantCount, roomLabel, timeRange, uid } from './model';

const statuses = ['全部', ...reviewStatuses];
const statusTone = { 已确认: 'success', 待审核: 'amber', 候补: 'purple' };

export function Registration({ event, readOnly, registration, notify }) {
  const [filter, setFilter] = useState('全部');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const [showQr, setShowQr] = useState(false);
  const [qr, setQr] = useState('');
  const [problem, setProblem] = useState('');
  const [editor, setEditor] = useState(null);
  const [importOpen, setImportOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const toolbar = useRef(null);
  const data = registration.current;
  const publicPath = data?.shared ? '#/public/' + data.publicId : '#/preview-event/' + event.id;
  const publicUrl = data?.shared ? new URL('/' + publicPath, data.publicOrigin || location.origin).href : '';
  useEffect(() => {
    let active = true;
    if (showQr && publicUrl) {
      import('qrcode').then(({ default: qrCode }) => qrCode.toDataURL(publicUrl, { width: 230, margin: 2 }))
        .then(url => { if (active) setQr(url); })
        .catch(() => { if (active) setQr('error'); });
    }
    return () => { active = false; };
  }, [publicUrl, showQr]);
  const search = query.trim().toLowerCase();
  const people = event.attendees.filter(person => (filter === '全部' || person.status === filter) &&
    [person.name, person.email, person.id].some(value => value?.toLowerCase().includes(search)));
  const pageSize = 10;
  const currentPage = Math.min(page, Math.max(0, Math.ceil(people.length / pageSize) - 1));
  async function apply(path, input, message) {
    if (!data || busy) return;
    setProblem('');
    setBusy(true);
    try { await registration.change(path, 'PATCH', input); notify(message); }
    catch (error) { setProblem(error.message); }
    finally { setBusy(false); }
  }
  function changeStatus(person, status) {
    return apply('/people/' + person.id, { ...person, status }, '报名状态已更新');
  }
  async function moveToWaitlist(person) {
    await changeStatus(person, '候补');
    requestAnimationFrame(() => {
      if (document.activeElement !== document.body) return;
      const nextAction = document.getElementById('confirm-' + person.id) ?? toolbar.current?.querySelector('input:checked');
      nextAction?.focus({ preventScroll: true });
    });
  }
  const draftDetails = { title: event.title, date: event.date, venue: event.venue, capacity: event.capacity };
  const detailsChanged = data && !data.event.version && Object.entries(draftDetails).some(([field, value]) => data.event[field] !== value);
  function saveSettings(change, message) {
    return apply('/settings', { revision: data.revision, shared: data.shared, formOpen: data.event.formOpen,
      ...(detailsChanged && { details: draftDetails }), ...change }, message);
  }
  return <>
    <PageHead heading="h2" title="报名与发布" description={readOnly ? '查看报名状态、分场名额和候补名单。' : '查看公开页、报名审核、分场名额和候补。'}>
      {!readOnly && <>
        <button className="button" disabled={!data?.shared} aria-haspopup="dialog" onClick={() => { setQr(''); setShowQr(true); }}><QrCode size={18} />报名二维码</button>
        <a className="button primary" href={publicPath}><ExternalLink size={17} />预览活动页</a>
      </>}
    </PageHead>
    <Panel title="报名管理" action={<Badge tone="success">{participantCount(event)} / {data?.event.capacity ?? event.capacity} 已占位</Badge>}>
      {!readOnly && !data && <Notice tone={registration.problem ? 'warning' : 'info'} announce>
        {registration.problem || '正在读取服务端报名名单…'} {registration.problem && <button className="button small" onClick={registration.refresh}>重试</button>}
      </Notice>}
      {!readOnly && data && <div className="actions registration-toolbar">
        <button className="button primary" onClick={() => setEditor({})}><Plus size={17} aria-hidden="true" />新增报名</button>
        <button className="button" onClick={() => setImportOpen(true)}><Upload size={16} aria-hidden="true" />导入名单</button>
        <button className="button" onClick={registration.refresh}>刷新名单</button>
      </div>}
      <div className="toolbar" ref={toolbar}>
        <Tabs label="报名状态" items={statuses} value={filter} onChange={value => { setFilter(value); setPage(0); setProblem(''); }} />
        <label className="search"><Search size={17} aria-hidden="true" /><input type="search" aria-label="搜索报名" placeholder="姓名、邮箱或凭证" value={query} onChange={e => { setQuery(e.target.value); setPage(0); setProblem(''); }} /></label>
      </div>
      {problem && <Notice tone="warning" announce>{problem}</Notice>}
      {people.length ? <>
        <Table label="报名名单" pinRowHeader headers={['姓名', '分场', '审核', '出席', '个人凭证', ...(readOnly ? [] : ['操作'])]}>{people.slice(currentPage * pageSize, (currentPage + 1) * pageSize).map(person => <tr key={person.id}>
          <th scope="row">{person.name}{!readOnly && person.email && <small className="field-note">{person.email}</small>}</th>
          <td>{event.agenda.find(item => item.id === person.sessionId)?.title ?? '全场'}
            {person.requestedSessionId && <small className="field-note">有换场申请</small>}</td>
          <td><Badge tone={statusTone[person.status]}>{person.status}</Badge></td>
          <td><Badge tone={person.attendance === '确认出席' ? 'success' : 'neutral'}>{person.attendance || '待回应'}</Badge></td>
          <td className="tabular">{person.id}</td>
          {!readOnly && <td><div className="actions compact">
            <button className="button small" disabled={!data} onClick={() => setEditor({ person })}>编辑</button>
            {person.status === '已确认' ? <Popconfirm label="转候补" confirmLabel="确认转候补"
              description={'将' + person.name + '转为候补，并释放已确认名额？'} onConfirm={() => moveToWaitlist(person)} /> :
              <button className="button small" id={'confirm-' + person.id} disabled={!data || busy} onClick={() => changeStatus(person, '已确认')}>确认报名</button>}
            {person.status === '待审核' && <button className="button small" disabled={!data || busy} onClick={() => changeStatus(person, '候补')}>加入候补</button>}
          </div></td>}
        </tr>)}</Table>
        <div className="pagination"><span className="muted">共 {people.length} 人 · 第 {currentPage + 1} 页</span>
          <button className="button small" onClick={() => setPage(currentPage - 1)} disabled={currentPage === 0}>上一页</button>
          <button className="button small" onClick={() => setPage(currentPage + 1)} disabled={(currentPage + 1) * pageSize >= people.length}>下一页</button></div>
      </> : <Empty>没有符合条件的报名。</Empty>}
    </Panel>
    <div className="split"><Panel title="报名设置">
      {readOnly ? <Badge tone={event.formOpen ? 'success' : 'neutral'}>{event.formOpen ? '报名已开放' : '报名已暂停'}</Badge> :
        data && <div className="form-stack">
          <CheckControl variant="switch" label="发布公开活动页" description={data.shared ? '公开页可访问' : '仅工作台预览'}
            checked={data.shared} disabled={busy} onChange={shared => saveSettings({ shared }, shared ? '公开活动页已发布' : '公开活动页已下线')} />
          <CheckControl variant="switch" label="开放公开报名" description={event.formOpen ? (data.shared ? '报名已开放' : '发布活动页后开放报名') : '报名已暂停'}
            checked={event.formOpen} disabled={busy} onChange={formOpen => saveSettings({ formOpen }, formOpen ? '已保存报名开放设置' : '已暂停公开报名')} />
          {detailsChanged && <button className="button" disabled={busy} onClick={() => saveSettings({}, '已同步报名活动信息')}>同步方案的日期、地点及人数</button>}
          {publicUrl && <label>公开报名链接<input readOnly value={publicUrl} onFocus={event => event.currentTarget.select()} /></label>}
        </div>}
    </Panel><Panel title="票务接入"><p className="muted">本地演练使用免费报名。付费票、选座和退款待接入服务。</p></Panel></div>
    {showQr && <Dialog title="报名二维码" variant="drawer" close={() => setShowQr(false)}>
      <div className="qr-content">{qr === 'error' ? <Notice tone="error" announce>二维码生成失败，可使用下方链接。</Notice> : qr ? <img src={qr} alt="公开报名二维码" width="230" height="230" /> : <div className="qr-skeleton" role="status"><span className="sr-only">正在生成二维码</span></div>}
        <p className="muted">{data?.publicOrigin ? '扫码打开公开活动页。' : '当前二维码使用本机地址。'}</p><a className="button" href={publicPath} onClick={() => setShowQr(false)}>打开报名页</a></div>
    </Dialog>}
    {editor && <RegistrationEditor event={event} person={editor.person} registration={registration} close={() => setEditor(null)} notify={notify} />}
    {importOpen && <ImportRegistrations registration={registration} close={() => setImportOpen(false)} notify={notify} />}
  </>;
}

export function PublicEvent({ event, submit, preview = false }) {
  const [received, setReceived] = useState(false);
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState(false);
  const agendaHeading = useRef(null);
  const registrationHeading = useRef(null);

  async function register(e) {
    e.preventDefault();
    if (busy || !submit || !event.formOpen) return;
    const form = new FormData(e.currentTarget);
    setBusy(true);
    setProblem('');
    try { await submit(Object.fromEntries(form)); setReceived(true); }
    catch (error) { setProblem(error.message); }
    finally { setBusy(false); }
  }
  const registrationAvailable = !preview && (received || event.formOpen);
  return <div className="public-event">
    <header className="public-event-bar">
      <div className="public-event-inner">
        {preview ? <a className="public-back" href="#/registration"><ArrowLeft size={17} aria-hidden="true" />返回报名管理</a> : <strong>会序</strong>}
        <Badge tone={event.version ? 'success' : 'neutral'}>{event.version ? '议程 v' + event.version : '活动信息'}</Badge>
      </div>
    </header>
    <main className="public-event-inner public-event-content">
      <section className="public-hero" aria-labelledby="public-event-title">
        <div className="public-hero-media">
          <MarbleFlow variant="spectrum" />
          {event.type === '行业论坛'
            ? <picture className="public-hero-photo">
              <source type="image/webp" srcSet="/conference-640.webp 640w, /conference-1280.webp 1280w, /conference-2172.webp 2172w"
                sizes="(max-width: 400px) 640px, (max-width: 760px) 1024px, 1280px" />
              <img src="/conference.png" alt="" width={2172} height={724} fetchPriority="high" />
            </picture>
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
            {received ? '查看报名结果' : '前往报名'}<ArrowRight size={17} aria-hidden="true" />
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
          {preview ? <Notice>当前为预览。活动负责人发布后可通过公开链接报名。</Notice> :
            received ? <Notice tone="success" announce>报名请求已收到，请等待活动负责人审核。</Notice> :
            event.formOpen ? <form className="form-stack" onSubmit={register}>
              <label>姓名<input name="name" required maxLength={80} autoComplete="name" /></label>
              <label>邮箱<input name="email" type="email" required maxLength={254} autoComplete="email" /></label>
              <Select label="分场" name="sessionId" options={[{ value: '', label: '全场活动' }, ...event.agenda.map(session => ({ value: session.id, label: session.title }))]} />
              {problem && <Notice tone="error" announce>{problem}</Notice>}
              <button className="button primary" disabled={busy}>提交报名</button>
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

export function Materials({ event, readOnly, update, notify, navigate, showDesignMaterials, registration }) {
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
      ? event.attendees.filter(person => (status === '已确认' ? reservesSeat(person) : status === '全部' || person.status === status) &&
        (!sessionId || person.sessionId === sessionId)).map(person => person.name)
      : [...new Set(event.agenda.filter(session => !sessionId || session.id === sessionId).map(session => session.guest))];
    setPreview({ id: uid(), subject: event.title + ' · ' + kind, channel: form.get('channel'), body: text, people, count: people.length, version: event.version });
    setPreviewNeedsUpdate(false);
  }
  return <>
    <PageHead heading="h3" title="材料与沟通" description="生成设计提示词和执行材料，按人群与渠道预览通知。">
      <Badge tone={event.version ? 'success' : 'neutral'}>{event.version ? '发布版本 v' + event.version : '计划草稿'}</Badge>
    </PageHead>
    <Tabs label="材料工作区" items={['执行材料与通知', '设计材料']} value={showDesignMaterials ? '设计材料' : '执行材料与通知'}
      onChange={value => navigate(value === '设计材料' ? 'materials/design' : 'materials', { preserveScroll: true })} />
    <div hidden={!showDesignMaterials}>
      <DesignMaterials event={event} notify={notify} navigate={navigate} />
    </div>
    {!showDesignMaterials && <>
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
        <td>{message.subject}</td><td>{message.channel}</td><td>{message.count}</td><td>{message.version ? 'v' + message.version : '草稿'}</td>
        <td><Badge tone={message.channel === '救场通知草稿' ? 'amber' : 'success'}>{message.channel === '救场通知草稿' ? '待发送' : '演练已记录'}</Badge></td>
      </tr>)}</Table> : <Empty>暂无演练通知记录。</Empty>}
    </Panel>
    {!readOnly && <RegistrationMailRecords eventId={event.id} registration={registration} />}
    {preview && <Dialog title="通知预览" variant="drawer" close={() => setPreview(null)} footer={(!readOnly || previewNeedsUpdate) && <>
      {previewNeedsUpdate && <button type="submit" form={formId} className="button">更新预览</button>}
      {!readOnly && <button className="button primary" disabled={previewNeedsUpdate || !preview.count} onClick={() => {
        update(current => ({ ...current, messages: [{ ...preview, date: new Date().toLocaleString('zh-CN') }, ...current.messages] }));
        setPreview(null);
        notify('演练通知已记录');
      }}>记录演练发送</button>}
    </>}>
      {previewNeedsUpdate && <Notice tone="warning" announce>材料或筛选条件已改变，请更新预览后再确认。</Notice>}
      <p>{preview.channel} · {preview.count} 位接收对象</p>
      <p className="muted">{preview.people.slice(0, 8).join('、')}{preview.count > 8 && ' 等'}</p>
      <pre className="document-preview">{preview.body}</pre>
      {!preview.count && <Notice tone="warning">当前筛选条件下没有接收对象。</Notice>}
    </Dialog>}
    </>}
  </>;
}
