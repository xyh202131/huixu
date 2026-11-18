import { useEffect, useState } from 'react';
import { Panel } from './components';
import { Notice } from './interactions';
import { Select } from './Select';
import { roomLabel } from './scheduling';
import { localOnlyLink } from './registrationClient';

export function GuestRequests({ event, registration }) {
  const [link, setLink] = useState('');
  const [problem, setProblem] = useState('');
  const [busy, setBusy] = useState(false);
  const sessions = event.agenda.filter(row => row.guest && !['待定', '待确认'].includes(row.guest));
  const tasks = event.tasks.filter(task => !task.done);
  async function change(path, method, input) {
    setLink(''); setProblem(''); setBusy(true);
    try {
      const result = await registration.change(path, method, input);
      if (result.url) setLink(result.url);
      registration.refresh();
    } catch (error) { setProblem(error.message); }
    finally { setBusy(false); }
  }
  return <Panel title="嘉宾专属确认">
    {event.version > 0 && sessions.length ? <form className="form-stack" onSubmit={e => {
      e.preventDefault();
      const fields = new FormData(e.currentTarget);
      void change('/guests', 'POST', { sessionId: fields.get('session'), taskId: fields.get('task') });
    }}>
      <Select label="嘉宾与环节" name="session" options={sessions.map(row => ({ value: row.id, label: row.guest + ' · ' + row.title }))} />
      <Select label="收到课件时完成的任务" name="task" options={[{ value: '', label: '不关联任务' }, ...tasks.map(row => ({ value: String(row.id), label: row.name }))]} />
      <button className="button" disabled={busy || !registration.current}>生成嘉宾专属链接</button>
      <small className="muted">链接有效期 7 天。给同一场次和嘉宾重新生成后，以新链接为准。</small>
    </form> : <p className="muted">发布含具名嘉宾的议程后，可以邀请嘉宾确认时段并上传课件。</p>}
    {link && <><label className="form-stack">复制后发给该嘉宾<input readOnly value={link} onFocus={e => e.target.select()} /></label>
      {localOnlyLink(link) && <p className="muted">当前为本机地址。跨设备使用需配置服务的 HUIXU_PUBLIC_ORIGIN 并从该地址访问。</p>}</>}
    {problem && <Notice tone="warning" announce>{problem}</Notice>}
    <ul className="plain-list">{registration.current?.guestRequests?.map(item => <li key={item.id}>
      <strong>{item.guest} · {event.agenda.find(row => row.id === item.sessionId)?.title}</strong>
      <p>{item.responded ? '嘉宾已确认 v' + item.confirmedVersion : '等待嘉宾确认'} · {item.filename || '课件待提交'}</p>
      {item.filename && <a className="link-button" href={'/api/registration/events/' + event.id + '/guests/' + item.id + '/file'}>下载课件</a>}
      {item.expires > Date.now() && <button className="button small" disabled={busy} onClick={() => change('/guests/' + item.id, 'DELETE')}>撤销链接</button>}
    </li>)}</ul>
  </Panel>;
}

export function GuestConfirmation({ token }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const url = '/api/registration-public/guest';
  useEffect(() => {
    const controller = new AbortController();
    fetch(url, { headers: { 'X-Huixu-Confirmation': token }, cache: 'no-store', signal: controller.signal })
      .then(async response => {
        const result = await response.json();
        if (!response.ok) throw new Error(result.error);
        setData(result);
      }).catch(problem => { if (!controller.signal.aborted) setError(problem.message); });
    return () => controller.abort();
  }, [token]);
  async function submit(e) {
    e.preventDefault();
    const fields = new FormData(e.currentTarget);
    const file = fields.get('file');
    setSaved(false);
    setError('');
    if (file.size > 16 * 1024 * 1024) { setError('课件上限为 16 MB。'); return; }
    setBusy(true);
    try {
      const details = { version: data.version, start: fields.get('start'), end: fields.get('end'), filename: file.name };
      const response = await fetch(url, { method: 'POST', body: file, headers: { 'X-Huixu-Confirmation': token,
        'X-Huixu-Submission': encodeURIComponent(JSON.stringify(details)) } });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      setData(result); setSaved(true);
    } catch (problem) { setError(problem.message); }
    finally { setBusy(false); }
  }
  return <main className="attendance-page guest-confirmation"><h1>嘉宾时段与课件确认</h1>
    {data ? <Panel title={data.eventTitle}><p>{data.guest} · {data.sessionTitle} · v{data.version}</p>
      <p>{data.date} · {data.start}–{data.end} · {roomLabel(data.room)}</p>
      <form className="form-stack" onSubmit={submit}>
        <label>可到场时间<input name="start" type="time" defaultValue={data.availability?.start ?? data.start} required /></label>
        <label>最晚离场时间<input name="end" type="time" defaultValue={data.availability?.end ?? data.end} required /></label>
        <label>课件（PDF 或 PPTX，最多 16 MB）<input name="file" type="file" accept=".pdf,.pptx" /></label>
        {data.filename && <p>已收到《{data.filename}》</p>}
        <button className="button primary" disabled={busy}>{busy ? '正在提交…' : '确认时段并提交'}</button>
      </form>{saved && <Notice tone="success" announce>负责人已可查看本次确认和课件。</Notice>}
    </Panel> : !error && <p role="status">正在读取嘉宾安排…</p>}
    {error && <Notice tone="warning" announce>{error}</Notice>}
  </main>;
}
