import { useEffect, useRef, useState } from 'react';
import { BookOpen, Download, Search, UploadCloud } from 'lucide-react';
import { Badge, Empty, Panel, Table } from './components';
import { CheckControl, Dialog, Notice } from './interactions';
import { memoryRequest, memoryUrl, sourceAccept } from './memoryClient';
import { isArchiveName } from './sourceFormats';

export function ProjectMemory({ eventId, importFiles, importRun, evidenceId, onCloseEvidence, onAccessChange, children }) {
  const [sources, setSources] = useState([]);
  const [loadProblem, setLoadProblem] = useState('');
  const [actionProblem, setActionProblem] = useState('');
  const [share, setShare] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [search, setSearch] = useState(null);
  const [preview, setPreview] = useState(null);
  const [updatingSource, setUpdatingSource] = useState('');
  const input = useRef(null);
  const dragDepth = useRef(0);
  const action = useRef(null);
  const busy = Boolean(importRun?.pending);

  useEffect(() => {
    const request = new AbortController();
    memoryRequest(eventId, {}, { signal: request.signal }).then(({ sources }) => {
      if (request.signal.aborted) return;
      setSources(sources);
      setLoadProblem('');
    }).catch(error => { if (!request.signal.aborted) setLoadProblem(error.message); });
    return () => request.abort();
  }, [eventId, importRun?.done, refresh]);

  async function show(parameters, handle) {
    action.current?.abort();
    const request = new AbortController();
    action.current = request;
    setActionProblem('');
    try {
      const result = await memoryRequest(eventId, parameters, { signal: request.signal });
      if (!request.signal.aborted) handle(result);
    } catch (error) {
      if (!request.signal.aborted) setActionProblem(error.message);
    }
  }

  useEffect(() => {
    setPreview(current => current?.linked ? null : current);
    if (evidenceId) show({ view: 'excerpt', chunk: evidenceId }, result => setPreview({ ...result, linked: true }));
    return () => action.current?.abort();
  }, [eventId, evidenceId]);

  async function toggle(source, agentAccess) {
    setUpdatingSource(source.id);
    setActionProblem('');
    try {
      await memoryRequest(eventId, { source: source.id }, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agentAccess }),
      });
      setSources(current => current.map(row => row.id === source.id ? { ...row, agentAccess } : row));
      setRefresh(current => current + 1);
      onAccessChange(agentAccess);
    } catch (error) {
      setActionProblem(error.message);
    } finally {
      setUpdatingSource('');
    }
  }

  function add(files) {
    if (busy || !files.length) return;
    setSearch(null);
    setActionProblem('');
    importFiles(eventId, Array.from(files), share);
  }

  return <>
    <section className={'upload-zone' + (dragging ? ' dragging' : '')} aria-label="导入活动资料" onDragOver={event => event.preventDefault()}
      onDragEnter={event => {
        if (!event.dataTransfer.types.includes('Files')) return;
        dragDepth.current += 1;
        setDragging(true);
      }} onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (!dragDepth.current) setDragging(false);
      }} onDrop={event => {
        event.preventDefault();
        dragDepth.current = 0;
        setDragging(false);
        add(event.dataTransfer.files);
      }}>
      <input ref={input} type="file" multiple hidden aria-label="选择资料" accept={sourceAccept} onChange={event => { add(event.target.files); event.target.value = ''; }} />
      <div className="upload-zone-main">
        <span className="upload-zone-icon"><UploadCloud size={23} aria-hidden="true" /></span>
        <div>
          <h2>{dragging ? '松开以导入' : '导入活动资料'}</h2>
          <p>拖入文档、表格、PDF、图片，或 ZIP、7z、RAR、TAR 压缩包。</p>
        </div>
        <button type="button" className="button primary" disabled={busy} onClick={() => input.current.click()}>选择文件</button>
      </div>
      <div className="upload-zone-access">
        <CheckControl label="允许 Agent 引用本批资料" description="允许 Agent 引用本批资料" checked={share} onChange={setShare} />
        <p>{share ? '索引完成后自动整理，所需文字片段可发送给已配置的模型。' : '仅建立本机索引。可以稍后在索引表开启引用。'}</p>
      </div>
    </section>

    {importRun && <Notice tone={busy ? 'info' : importRun.errors.length ? 'warning' : 'success'} announce>
      {busy ? `已处理 ${importRun.done} / ${importRun.total} 个文件` : `已处理 ${importRun.total} 个文件 · ${importRun.indexed} 个可检索 · ${importRun.duplicates} 个重复 · ${importRun.errors.length} 个导入失败`}
      {importRun.errors.length > 0 && <ul className="plain-list">{importRun.errors.map(({ name, reason }, index) => <li key={index}>{name} · {reason}</li>)}</ul>}
    </Notice>}

    {children}
    <Panel title="活动记忆与索引" action={<button className="button small" disabled={!sources.length} onClick={() => show({ view: 'wiki' }, setPreview)}><BookOpen size={16} />查看知识页</button>}>
      {loadProblem && <Notice tone="error" announce>{loadProblem} <button type="button" className="button small" onClick={() => setRefresh(current => current + 1)}>重试</button></Notice>}
      {actionProblem && <Notice tone="warning" announce>{actionProblem}</Notice>}
      <form className="actions memory-search" onSubmit={event => {
        event.preventDefault();
        const query = new FormData(event.currentTarget).get('query').trim();
        if (query) show({ view: 'search', q: query }, ({ hits }) => setSearch({ query, hits }));
      }}>
        <label className="search"><Search size={16} aria-hidden="true" /><input type="search" name="query" aria-label="搜索活动资料" placeholder="搜索场地、设备或原文" maxLength={180} required /></label>
        <button className="button small">搜索</button>
        {search && <button className="button small" type="button" onClick={() => { action.current?.abort(); setSearch(null); }}>清除结果</button>}
      </form>
      {search && <div className="memory-results">
        <p className="muted">「{search.query}」 · {search.hits.length} 个匹配片段</p>
        {search.hits.map(hit => <button className="memory-hit" type="button" key={hit.chunkId}
          onClick={() => show({ view: 'excerpt', chunk: hit.chunkId }, setPreview)}>
          <strong>{hit.name} · v{hit.revision} · {hit.location}</strong><span>{hit.excerpt.slice(0, 240)}</span>
        </button>)}
      </div>}
      {sources.length ? <Table headers={['资料', '索引', 'Agent 引用', '原文']}>
        {sources.map(source => <tr key={source.id}>
          <td><strong>{source.name}</strong> <Badge tone="neutral">v{source.revision}</Badge>{!source.current && <small className="field-note">历史版本</small>}</td>
          <td><Badge tone={source.state === '已索引' ? 'success' : 'amber'}>{source.state} · {source.chunkCount} 片段</Badge>{source.note && <small className="field-note">{source.note}</small>}</td>
          <td>{source.current && source.chunkCount > 0 ? <button className="button small" disabled={Boolean(updatingSource)}
            onClick={() => toggle(source, !source.agentAccess)}>{source.agentAccess ? '关闭 Agent 引用' : '允许 Agent 引用'}</button> : <span className="muted">—</span>}</td>
          <td><div className="actions compact">
            {source.chunkCount > 0 && <button className="button small" onClick={() => show({ view: 'excerpt', source: source.id }, setPreview)}>预览片段</button>}
            {isArchiveName(source.name) && <button className="button small" onClick={() => show({ view: 'contents', source: source.id }, setPreview)}>包内文件</button>}
            <a className="button small" href={memoryUrl(eventId, { view: 'download', source: source.id })}><Download size={14} />下载</a>
          </div></td>
        </tr>)}
      </Table> : <Empty>导入资料后可以查找原文、查看索引版本和导出知识页。</Empty>}
    </Panel>

    {preview && <Dialog title={preview.excerpt?.name ?? preview.contents?.name ?? '活动知识页'} variant="drawer" close={() => {
      setPreview(null);
      if (evidenceId) onCloseEvidence();
    }}>
      {preview.excerpt && <>
        <p className="muted">v{preview.excerpt.revision} · {preview.excerpt.location}</p>
        <pre className="document-preview">{preview.excerpt.excerpt}</pre>
        <a className="button" href={memoryUrl(eventId, { view: 'download', source: preview.excerpt.sourceId })}><Download size={16} />下载原件</a>
      </>}
      {preview.markdown && <>
        <pre className="document-preview">{preview.markdown}</pre>
        <a className="button" href={memoryUrl(eventId, { view: 'wiki', download: '1' })}><Download size={16} />导出 Markdown</a>
      </>}
      {preview.contents && <>
        <p className="muted">v{preview.contents.revision} · {preview.contents.state} · {preview.contents.note}</p>
        {preview.contents.entries.length ? <Table headers={['包内位置', '处理结果']}>
          {preview.contents.entries.map((entry, index) => <tr key={index}>
            <td className="archive-member-path">{entry.path}</td><td>{entry.state}{entry.note && <small className="field-note">{entry.note}</small>}
              {entry.chunkId && <button type="button" className="button small" onClick={() => show({ view: 'excerpt', chunk: entry.chunkId }, setPreview)}>预览原文</button>}
            </td>
          </tr>)}
        </Table> : <Empty>没有可展示的包内文件。</Empty>}
      </>}
    </Dialog>}
  </>;
}
