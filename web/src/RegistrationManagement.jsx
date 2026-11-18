import { useEffect, useId, useRef, useState } from 'react';
import { Clipboard, Mail } from 'lucide-react';
import { Badge, Empty, Panel, Table } from './components';
import { Dialog, Notice, Popconfirm } from './interactions';
import { ownerRegistration } from './registrationClient';
import { reviewStatuses } from './registrationRules';
import { Select } from './Select';

const resultLabels = {
  pending: '正在提交', accepted: '服务已受理', delivered: '服务商确认送达', failed: '提交失败',
  unknown: '结果待核对', delayed: '投递延迟', bounced: '投递失败', complained: '收到投诉',
  opened: '服务商记录打开', clicked: '服务商记录点击',
};

export function RegistrationEditor({ event, person, registration, close, notify }) {
  const [view, setView] = useState('edit');
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [link, setLink] = useState(null);
  const [preview, setPreview] = useState(null);
  const [sendResult, setSendResult] = useState(null);
  const noteLabel = useId();
  const linkField = useRef(null);
  const path = person?.id ? '/people/' + person.id : '/people';
  const requested = event.agenda.find(item => item.id === person?.requestedSessionId);

  async function run(action) {
    setProblem('');
    setBusy(true);
    try { await action(); } catch (error) { setProblem(error.message); }
    finally { setBusy(false); }
  }

  const title = view === 'mail' ? '确认邮件预览' : person ? '编辑报名' : '新增报名';
  return <Dialog title={title} variant="drawer" close={close}>
    {view === 'edit' ? <>
      <form className="form-stack" onChange={() => setDirty(true)} onSubmit={event => {
        event.preventDefault();
        void run(async () => {
          const form = new FormData(event.currentTarget);
          await registration.change(path, person ? 'PATCH' : 'POST', { ...Object.fromEntries(form), revision: person?.revision,
            clearRequest: form.get('clearRequest') === 'on' });
          notify('报名已保存到服务端');
          close();
        });
      }}>
        <label>姓名<input name="name" maxLength={80} defaultValue={person?.name} required /></label>
        <label>邮箱<input name="email" type="email" maxLength={254} defaultValue={person?.email} /></label>
        <Select label="分场" name="sessionId" defaultValue={person?.sessionId} onChange={() => setDirty(true)}
          options={[{ value: '', label: '全场' }, ...event.agenda.map(session => ({ value: session.id, label: session.title }))]} />
        <Select label="审核状态" name="status" options={reviewStatuses} defaultValue={person?.status} onChange={() => setDirty(true)} />
        <label><span id={noteLabel}>内部备注</span><textarea aria-labelledby={noteLabel} name="note" defaultValue={person?.note || undefined} rows={3} maxLength={1000} /></label>
        {requested && <>
          <Notice>已申请换至「{requested.title}」。可修改分场后保存，系统会检查新场次的名额。</Notice>
          <label className="import-access"><input type="checkbox" name="clearRequest" />本次已处理换场申请</label>
        </>}
        {person && <p className="muted">凭证 {person.id} · 出席状态 {person.attendance}</p>}
        <button type="submit" className="button primary" disabled={busy}>保存报名</button>
      </form>
      {person?.status === '已确认' && <section className="registration-editor-links form-stack" aria-label="出席确认">
        <h3>出席确认</h3>
        <div className="actions">
          <button className="button" disabled={busy || dirty} onClick={() => run(async () => {
            setLink(await registration.change('/links/' + person.id, 'POST'));
          })}>生成专属链接</button>
          <button className="button" disabled={busy || dirty || !person.email} onClick={() => run(async () => {
            setPreview(await registration.change('/mail/' + person.id + '/preview', 'POST'));
            setSendResult(null);
            setView('mail');
          })}><Mail size={16} aria-hidden="true" />预览确认邮件</button>
        </div>
        {dirty ? <small className="muted">保存报名更改后，可生成链接或预览邮件。</small> :
          !person.email && <small className="muted">保存邮箱后即可准备邮件。</small>}
        {link && <div className="form-stack">
          <label>专属确认链接<input ref={linkField} readOnly value={link.url} /></label>
          {link.local && <Notice>当前链接仅能在本机打开。配置参与者可访问的 HTTPS 地址后再分享给手机用户。</Notice>}
          <button className="button" onClick={() => run(async () => {
            try { await navigator.clipboard.writeText(link.url); notify('已复制专属确认链接'); }
            catch { linkField.current?.select(); notify('链接已选中，可手动复制'); }
          })}><Clipboard size={16} aria-hidden="true" />复制专属链接</button>
        </div>}
        <Popconfirm label="撤销确认链接" confirmLabel="撤销全部链接" description="此前为此报名生成或发送的确认链接会立即失效。"
          onConfirm={() => run(async () => {
            await registration.change('/links/' + person.id, 'DELETE');
            setLink(null);
            notify('已撤销该报名的确认链接');
          })} />
      </section>}
    </> : <div className="form-stack">
      <dl className="registration-email-details">
        <dt>发件人</dt><dd>{preview.sender}</dd><dt>收件人</dt><dd>{preview.recipient}</dd>
        <dt>主题</dt><dd>{preview.subject}</dd><dt>活动版本</dt><dd>{preview.version ? 'v' + preview.version : '活动信息'}</dd>
      </dl>
      <pre className="document-preview">{preview.body}{'\n\n'}［附 {preview.origin} 的专属确认链接］</pre>
      {sendResult && <Notice tone={sendResult.status === 'accepted' ? 'info' : 'warning'} announce>
        {sendResult.status === 'accepted'
          ? 'Resend 已受理。投递结果可在「材料与沟通 → 出席确认邮件」核对。'
          : (sendResult.error || '提交结果待核对。') + ' 请在「材料与沟通 → 出席确认邮件」查看记录。'}
      </Notice>}
      <div className="actions">
        <button className="button" disabled={busy} onClick={() => { setView('edit'); setProblem(''); }}>返回报名</button>
        {!sendResult && <button className="button primary" disabled={busy} onClick={() => run(async () => {
          const result = await registration.change('/mail/' + preview.id + '/send', 'POST');
          setSendResult(result.records.find(item => item.id === preview.id) ?? { status: 'unknown' });
        })}>{busy ? '正在提交邮件…' : '确认发送邮件'}</button>}
      </div>
    </div>}
    {problem && <Notice tone="warning" announce>{problem}</Notice>}
  </Dialog>;
}

export function ImportRegistrations({ registration, close, notify }) {
  const [preview, setPreview] = useState(null);
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState(false);

  async function run(action) {
    setProblem('');
    setBusy(true);
    try { await action(); } catch (error) { setProblem(error.message); }
    finally { setBusy(false); }
  }

  return <Dialog title="导入或迁移报名名单" variant="drawer" close={close}>
    <p className="muted">支持 Excel、CSV、TSV。首行填写姓名，可加报名编号、邮箱、分场、审核状态和备注。名单缺行会保留原记录。</p>
    <form className="form-stack" onSubmit={event => {
      event.preventDefault();
      const file = new FormData(event.currentTarget).get('file');
      if (!file?.size) return;
      setPreview(null);
      void run(async () => setPreview(await registration.change('/import/file?name=' + encodeURIComponent(file.name), 'POST', file)));
    }}>
      <label>名单文件<input name="file" type="file" accept=".xlsx,.xls,.csv,.tsv" required /></label>
      <div className="actions">
        <button className="button" disabled={busy}>预览文件</button>
        {registration.legacyPeople.length > 0 && <button type="button" className="button" disabled={busy} onClick={() => {
          setPreview(null);
          void run(async () => setPreview(await registration.change('/import/preview', 'POST', { rows: registration.legacyPeople })));
        }}>预览此浏览器的旧名单</button>}
      </div>
    </form>
    {preview && <>
      <Notice>{preview.accepted} 条可保存。重复和待处理项见下方。</Notice>
      <Table headers={['位置', '姓名', '结果', '说明']}>{preview.previews.map((row, index) => <tr key={index}>
        <td>{row.location}</td><td>{row.name}</td><td>{row.kind}</td><td>{row.detail}</td>
      </tr>)}</Table>
      <button className="button primary" disabled={busy || !preview.accepted} onClick={() => run(async () => {
        const result = await registration.change('/import/commit', 'POST', { rows: preview.rows, previewKey: preview.previewKey });
        notify('已保存 ' + result.accepted + ' 条报名记录');
        close();
      })}>保存预览中的有效变更</button>
    </>}
    {problem && <Notice tone="warning" announce>{problem}</Notice>}
  </Dialog>;
}

export function RegistrationMailRecords({ eventId, registration }) {
  const [initialMail, setInitialMail] = useState(null);
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState(false);
  const ready = Boolean(registration.current);
  const mail = registration.mail ?? initialMail;

  useEffect(() => {
    if (!ready) return;
    const controller = new AbortController();
    ownerRegistration('/' + eventId + '/mail', 'GET', undefined, controller.signal)
      .then(setInitialMail).catch(error => { if (!controller.signal.aborted) setProblem(error.message); });
    return () => controller.abort();
  }, [eventId, ready]);

  async function load(path = '', method = 'GET') {
    setProblem('');
    setBusy(true);
    try { await registration.change('/mail' + path, method); }
    catch (error) { setProblem(error.message); }
    finally { setBusy(false); }
  }

  return <Panel title="出席确认邮件" action={<button className="button small" disabled={!ready || busy} onClick={() => load()}>刷新记录</button>}>
    <p className="muted">在「报名管理」编辑已确认的报名，可预览并发送带专属链接的邮件。</p>
    {mail && !mail.configured && <Notice>{mail.reason}</Notice>}
    {problem && <Notice tone="warning" announce>{problem}</Notice>}
    {mail?.records.length ? <Table headers={['收件人', '主题', '结果', '操作']}>{mail.records.map(record => <tr key={record.id}>
      <td>{record.recipient}</td><td>{record.subject}</td>
      <td><Badge tone={record.status === 'delivered' ? 'success' : 'neutral'}>{resultLabels[record.status] || record.status}</Badge>
        {record.error && <small className="field-note">{record.error}</small>}
      </td>
      <td>{record.status === 'failed' ? <Popconfirm label="重试" confirmLabel="确认重试" description={'重试发给 ' + record.recipient + ' 的邮件？'}
        onConfirm={() => { if (!busy) void load('/' + record.id + '/retry', 'POST'); }} /> : record.providerId &&
        <button className="button small" disabled={busy} onClick={() => load('/' + record.id + '/refresh', 'POST')}>查询投递</button>}</td>
    </tr>)}</Table> : <Empty>暂无发送记录。</Empty>}
  </Panel>;
}
