import { useEffect, useState } from 'react';
import { Panel } from './components';
import { Notice } from './interactions';

export function TaskHandoff({ token }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const url = '/api/registration-public/handoff';
  useEffect(() => {
    const controller = new AbortController();
    fetch(url, { cache: 'no-store', headers: { 'X-Huixu-Confirmation': token }, signal: controller.signal }).then(async response => {
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      setError(''); setData(result);
    }).catch(problem => { if (!controller.signal.aborted) setError(problem.message); });
    return () => controller.abort();
  }, [token, refresh]);
  async function save(e, task) {
    e.preventDefault();
    const fields = new FormData(e.currentTarget);
    setBusy(true);
    try {
      const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Huixu-Confirmation': token },
        body: JSON.stringify({ revision: data.revision, taskId: String(task.id), owner: fields.get('owner'), done: fields.has('done') }) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      setData(result); setError('');
    } catch (problem) { setError(problem.message); }
    finally { setBusy(false); }
  }
  return <main className="attendance-page"><h1>{data?.title ?? '筹备任务协作'}</h1>
    {error && <Notice tone="warning" announce>{error}</Notice>}
    <button className="button" disabled={busy} onClick={() => setRefresh(n => n + 1)}>刷新任务</button>
    {data && <Panel title={'筹备任务 · r' + data.revision}>
      {data.tasks.map(task => <form className="team-event" key={task.id} onSubmit={e => save(e, task)}>
        <strong>{task.name}</strong>
        <label>负责人<input key={task.owner} name="owner" defaultValue={task.owner} maxLength={80} /></label>
        <label><input key={String(task.done)} type="checkbox" name="done" defaultChecked={task.done} /> 已完成</label>
        <button className="button" disabled={busy}>保存此任务</button>
      </form>)}
    </Panel>}
  </main>;
}
