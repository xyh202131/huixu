import { useEffect, useState } from 'react';
import { Dialog, Notice } from './interactions';
import { localOnlyLink, ownerRegistration } from './registrationClient';
import { restoreWorkspaceDraft, workspaceDraft } from './workspaceDraft';

export function WorkspaceDraftDialog({ event, update, close, notify }) {
  const [link, setLink] = useState('');
  const [remote, setRemote] = useState(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const [replacing, setReplacing] = useState(false);
  const path = '/' + event.id + '/draft';
  const localRevision = event.draftRevision ?? 0;
  useEffect(() => {
    const request = new AbortController();
    ownerRegistration(path, 'GET', undefined, request.signal).then(setRemote).catch(error => {
      if (!request.signal.aborted) setProblem(error.message);
    });
    return () => request.abort();
  }, [path, localRevision]);
  async function save() {
    setBusy(true);
    setProblem('');
    try {
      const saved = await ownerRegistration(path, 'PUT', { revision: localRevision, data: workspaceDraft(event) });
      update(current => ({ ...current, draftRevision: saved.revision,
        draftDirty: JSON.stringify(workspaceDraft(current)) !== JSON.stringify(saved.data) }), { syncing: true });
      notify('已保存服务端草稿 r' + saved.revision);
      close();
    } catch (error) {
      setProblem(error.message);
      if (error.status === 409) setRemote(await ownerRegistration(path).catch(() => null));
    } finally { setBusy(false); }
  }
  async function share(method) {
    setBusy(true); setProblem(''); setLink('');
    try {
      const result = await ownerRegistration('/' + event.id + '/handoff', method);
      setLink(result.url ?? '');
      if (method === 'DELETE') notify('任务协作链接已撤销');
    } catch (error) { setProblem(error.message); }
    finally { setBusy(false); }
  }
  return <Dialog title="活动草稿交接" close={() => { if (!busy) close(); }}><div className="form-stack">
    <p>{event.title} · 本机基于 r{localRevision}</p>
    <p className="muted">保存活动方案、待排程、任务分派及资料核对结果。同一负责人账户可在另一台设备继续编辑。</p>
    {remote && <p>{remote.data ? '服务端 r' + remote.revision + ' · ' + remote.data.title + ' · ' + remote.data.tasks.length + ' 项任务' : '尚未保存服务端草稿。'}</p>}
    {problem && <Notice tone="warning" announce>{problem}</Notice>}
    {remote && remote.revision !== localRevision && <Notice>请先核对服务端版本。本机修改保留到你确认载入为止。</Notice>}
    {replacing && <Notice>载入将替换本机已保存的方案、待排程和任务。请先保留需要的改动。</Notice>}
    <div className="actions">
      <button className="button primary" disabled={busy || !remote || remote.revision !== localRevision} onClick={save}>{busy ? '正在保存…' : '保存到服务端'}</button>
      {remote?.data && <button className="button" disabled={busy} onClick={() => {
        if (!replacing) { setReplacing(true); return; }
        update(current => restoreWorkspaceDraft(current, remote), { syncing: true });
        notify('已载入服务端草稿 r' + remote.revision);
        close();
      }}>{replacing ? '确认载入并替换' : '载入服务端草稿'}</button>}
    </div>
    {!!remote?.data?.tasks.length && <details className="import-review-detail"><summary>邀请同事处理筹备任务</summary>
      <p className="muted">持链接的同事可查看本场筹备任务、修改负责人和完成状态。链接 7 天有效，重新生成后旧链接失效。</p>
      <div className="actions"><button className="button" disabled={busy} onClick={() => share('POST')}>生成任务协作链接</button>
        <button className="button" disabled={busy} onClick={() => share('DELETE')}>撤销任务协作链接</button></div>
      {link && <label>复制任务协作链接<input readOnly value={link} onFocus={e => e.target.select()} /></label>}
      {link && localOnlyLink(link) && <p className="muted">当前为本机地址。跨设备协作需配置可访问的 HUIXU_PUBLIC_ORIGIN。</p>}
    </details>}
  </div></Dialog>;
}
