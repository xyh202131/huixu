import { useEffect, useId, useState } from 'react';
import { Badge, Tabs } from './components';
import { Dialog, Notice } from './interactions';
import { memoryRequest, memoryUrl } from './memoryClient';
import { Select } from './Select';

export function SourceEditor({ eventId, source, problem, updated, replace, close }) {
  const id = useId();
  const [current, setCurrent] = useState(source);
  const [status, setStatus] = useState(source.reviewStatus);
  const [note, setNote] = useState(source.reviewNote);
  const [chunks, setChunks] = useState([]);
  const [selected, setSelected] = useState('');
  const [excerpt, setExcerpt] = useState(null);
  const [drafts, setDrafts] = useState({});
  const [busy, setBusy] = useState('');
  const [loading, setLoading] = useState(true);
  const [feedback, setFeedback] = useState(null);

  useEffect(() => {
    const controller = new AbortController();
    memoryRequest(eventId, { source: source.id, view: 'chunks' }, { signal: controller.signal }).then(result => {
      if (controller.signal.aborted) return;
      setChunks(result.chunks);
      setSelected(String(result.chunks[0]?.chunkId ?? ''));
      setLoading(false);
    }).catch(error => { if (!controller.signal.aborted) setFeedback({ tone: 'error', text: error.message }); });
    return () => controller.abort();
  }, [eventId, source.id]);

  useEffect(() => {
    if (!selected) return;
    const controller = new AbortController();
    setExcerpt(null);
    memoryRequest(eventId, { view: 'excerpt', chunk: selected }, { signal: controller.signal }).then(result => {
      if (!controller.signal.aborted) setExcerpt(result.excerpt);
    }).catch(error => { if (!controller.signal.aborted) setFeedback({ tone: 'error', text: error.message }); });
    return () => controller.abort();
  }, [eventId, selected]);

  const draft = drafts[selected] ?? { text: excerpt?.excerpt ?? '', note: excerpt?.editNote ?? '', textRevision: excerpt?.textRevision ?? 0 };
  function edit(field, value) {
    setFeedback(null);
    setDrafts(previous => ({ ...previous, [selected]: { ...draft, [field]: value } }));
  }

  async function save(view, input) {
    if (busy) return;
    setBusy(view);
    setFeedback(null);
    try {
      const result = await memoryRequest(eventId, { source: source.id, view }, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
      });
      setCurrent(result.source);
      setStatus(result.source.reviewStatus);
      setNote(result.source.reviewNote);
      if (result.excerpt) {
        setExcerpt(result.excerpt);
        setDrafts(previous => { const next = { ...previous }; delete next[selected]; return next; });
        if (!selected) {
          setChunks([{ chunkId: result.excerpt.chunkId, location: result.excerpt.location }]);
          setSelected(String(result.excerpt.chunkId));
        }
      }
      updated(result.source);
      let message = '资料状态已保存。';
      if (view === 'text') message = result.source.reviewStatus === '已停用' ? '本片段已保存并更新索引，资料保持停用状态。' : '本片段已保存并更新索引，资料回到待核对状态。';
      setFeedback({ tone: 'success', text: message });
    } catch (error) {
      setFeedback({ tone: 'error', text: error.message });
    } finally {
      setBusy('');
    }
  }

  return <Dialog title={'管理资料 · ' + source.name} variant="drawer" fullOnMobile close={close}>
    <p className="muted">文件 v{source.revision} · {current.state} · {current.chunkCount} 个片段</p>
    {problem && <Notice tone="error" announce>{problem}</Notice>}
    {feedback && <Notice tone={feedback.tone} announce>{feedback.text}</Notice>}
    <form className="form-stack" aria-label="资料核对状态" onSubmit={event => {
      event.preventDefault();
      void save('review', { status, note, expectedVersion: current.reviewVersion });
    }}>
      <fieldset className="form-stack model-settings-fields" disabled={Boolean(busy)}>
        <legend>资料核对状态</legend>
        <Tabs label="资料核对状态" items={['待核对', '已确认', '已停用']} value={status} onChange={setStatus} />
        <div className="form-stack"><label htmlFor={id + '-review-note'}>核对备注</label>
          <textarea id={id + '-review-note'} name="reviewNote" rows={2} maxLength={500} value={note} onChange={event => setNote(event.target.value)} /></div>
        <p className="muted">已停用的资料退出当前检索与 Agent 整理。重新启用后可继续核对。</p>
        <button className="button" disabled={Boolean(busy)}>{busy === 'review' ? '正在保存…' : '保存资料状态'}</button>
      </fieldset>
    </form>
    <form className="form-stack" aria-label="修订整理文字" onSubmit={event => {
      event.preventDefault();
      void save('text', { ...draft, chunkId: selected ? Number(selected) : undefined });
    }}>
      <fieldset className="form-stack model-settings-fields" disabled={loading || Boolean(busy) || Boolean(selected && !excerpt)}>
        <legend>修订整理文字</legend>
        {chunks.length > 0 && <Select label="选择要修改的片段" value={selected} onChange={setSelected}
          options={chunks.map(chunk => ({ value: String(chunk.chunkId), label: chunk.location }))} />}
        {excerpt?.textRevision > 0 && <Badge>人工修订 r{excerpt.textRevision}</Badge>}
        <div className="form-stack"><label htmlFor={id + '-text'}>整理文字</label>
          <textarea id={id + '-text'} name="text" rows={9} required maxLength={12000} value={draft.text} onChange={event => edit('text', event.target.value)} /></div>
        <div className="form-stack"><label htmlFor={id + '-text-note'}>修订说明</label>
          <textarea id={id + '-text-note'} name="note" rows={2} maxLength={500} value={draft.note} onChange={event => edit('note', event.target.value)} /></div>
        <p className="muted">保存本片段会更新检索与后续提取。文件原件和导入时的识别文字可继续对照，其他片段可分别修改。</p>
        {excerpt && <details><summary>导入时的识别文字</summary><pre className="document-preview">{excerpt.originalExcerpt || '该资料由人工补录文字。'}</pre></details>}
        <button className="button primary" disabled={Boolean(busy)}>{busy === 'text' ? '正在保存…' : '保存本片段'}</button>
      </fieldset>
    </form>
    <div className="actions">
      <button type="button" className="button" disabled={Boolean(busy)} onClick={() => replace(current)}>替换这份文件</button>
      <a className="button" href={memoryUrl(eventId, { view: 'download', source: source.id })}>下载原件</a>
    </div>
  </Dialog>;
}
