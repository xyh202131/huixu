import { useEffect, useRef, useState } from 'react';
import { ArrowLeft, BookOpen, Download, FileText, Search, UploadCloud } from 'lucide-react';
import { Badge, Empty, FilterChips, Panel, Table } from './components';
import { CheckControl, Dialog, Notice } from './interactions';
import { memoryRequest, memoryUrl, sourceAccept } from './memoryClient';
import { isArchiveName } from './sourceFormats';
import { SourceEditor } from './SourceEditor';
import { Select } from './Select';
import { LoadingImage } from './LoadingImage';

const imageTypes = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', avif: 'image/avif', bmp: 'image/bmp' };

function ImportProgress({ run }) {
  const remaining = run.total - run.indexed - run.duplicates - run.errors.length;
  const summary = run.pending ? `${run.done} / ${run.total} 个文件已处理` : [
    `${run.indexed} 个可检索`, `${run.duplicates} 个重复`, `${run.errors.length} 个导入失败`,
    remaining > 0 && `${remaining} 个暂无可检索片段`,
  ].filter(Boolean).join(' · ');
  return <Panel className="import-progress" title="本批导入" action={<Badge tone={run.pending ? 'neutral' : run.errors.length || remaining ? 'amber' : 'success'}>
    {run.pending ? '处理中' : '处理完成'}
  </Badge>}>
    <p className="muted" role="status">{summary}</p>
    <progress value={run.done} max={run.total} aria-label="已处理文件进度" />
    <ul className="import-progress-files" aria-label="文件处理结果">{run.files.map(({ name, state, tone, note }, index) => <li key={index}>
      <FileText size={16} aria-hidden="true" />
      <div><strong>{name}</strong>{note && <small>{note}</small>}</div>
      <Badge tone={tone}>{state}</Badge>
    </li>)}</ul>
  </Panel>;
}

export function ProjectMemory({ eventId, mobile, importFiles, importRun, evidenceId, onCloseEvidence, returnLabel, onAccessChange, children }) {
  const [sources, setSources] = useState([]);
  const [loadProblem, setLoadProblem] = useState('');
  const [actionProblem, setActionProblem] = useState('');
  const [share, setShare] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [search, setSearch] = useState(null);
  const [query, setQuery] = useState('');
  const [reviewFilter, setReviewFilter] = useState('全部');
  const [accessFilter, setAccessFilter] = useState('全部');
  const queryControl = useRef(null);
  const reviewControl = useRef(null);
  const accessControl = useRef(null);
  const previewOrigin = useRef(null);
  const [previewTrail, setPreviewTrail] = useState([]);
  const [preview, setPreview] = useState(null);
  const [updatingSource, setUpdatingSource] = useState('');
  const [managing, setManaging] = useState(null);
  const replacement = useRef(null);
  const replacementSource = useRef(null);
  const input = useRef(null);
  const dragDepth = useRef(0);
  const action = useRef(null);
  const busy = Boolean(importRun?.pending);
  const filteredSources = sources.filter(source => (reviewFilter === '全部' || source.reviewStatus === reviewFilter) &&
    (accessFilter === '全部' || Boolean(source.agentAccess) === (accessFilter === '允许 Agent 引用')));
  const filteredIds = new Set(filteredSources.map(source => source.id));
  const hits = search?.hits.filter(hit => filteredIds.has(hit.sourceId)) ?? [];
  const foundIds = new Set(hits.map(hit => hit.sourceId));
  const visibleSources = filteredSources.filter(source => !search || foundIds.has(source.id) || source.name.toLowerCase().includes(search.query.toLowerCase()));

  function clearSearch() {
    action.current?.abort();
    setSearch(null);
    setQuery('');
  }

  function openPreview(parameters) {
    if (!preview) previewOrigin.current = { y: window.scrollY, element: document.activeElement };
    const previous = preview;
    show(parameters, result => {
      setPreviewTrail(current => previous ? [...current, previous] : []);
      setPreview(result);
    });
  }

  function closePreview() {
    setPreview(null);
    setPreviewTrail([]);
    if (evidenceId) { onCloseEvidence(); return; }
    const origin = previewOrigin.current;
    requestAnimationFrame(() => {
      window.scrollTo({ top: origin?.y ?? window.scrollY, behavior: 'instant' });
      (origin?.element?.isConnected ? origin.element : queryControl.current)?.focus({ preventScroll: true });
    });
  }

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

  function sourceUpdated(source) {
    setActionProblem('');
    setSources(current => current.map(row => row.id === source.id ? { ...row, ...source } : row));
    if (search) show({ view: 'search', q: search.query }, ({ hits }) => setSearch({ query: search.query, hits }));
    setRefresh(current => current + 1);
    onAccessChange(Boolean(source.agentAccess && source.reviewStatus !== '已停用'));
  }

  function sourceActions(source) {
    return <div className="actions compact source-actions">
      {source.current && <button className="button small" disabled={busy} onClick={() => { setActionProblem(''); setManaging(source); }}>管理资料</button>}
      {source.chunkCount > 0 && <button className="button small" onClick={() => openPreview({ view: 'excerpt', source: source.id })}>预览片段</button>}
      {imageTypes[source.name.split('.').at(-1).toLowerCase()] && <button className="button small" onClick={() => {
        previewOrigin.current = { y: window.scrollY, element: document.activeElement };
        setPreviewTrail([]);
        setPreview({ image: { ...source, mediaType: imageTypes[source.name.split('.').at(-1).toLowerCase()] } });
      }}>预览图片</button>}
      {isArchiveName(source.name) && <button className="button small" onClick={() => openPreview({ view: 'contents', source: source.id })}>包内文件</button>}
      <a className="button small" href={memoryUrl(eventId, { view: 'download', source: source.id })}><Download size={14} aria-hidden="true" />下载</a>
    </div>;
  }

  function accessButton(source) {
    return source.current && source.chunkCount > 0 ? <button className="button small" disabled={Boolean(updatingSource) || source.reviewStatus === '已停用'}
      onClick={() => toggle(source, !source.agentAccess)}>{source.agentAccess ? '关闭 Agent 引用' : '允许 Agent 引用'}</button> : <span className="muted">{source.current ? '暂无可引用片段' : '历史版本不再参与引用'}</span>;
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

    {importRun && <ImportProgress run={importRun} />}

    {children}
    <Panel className="source-index" title="活动记忆与索引" action={<button className="button small" disabled={!sources.length} onClick={() => openPreview({ view: 'wiki' })}><BookOpen size={16} />查看知识页</button>}>
      {loadProblem && <Notice tone="error" announce>{loadProblem} <button type="button" className="button small" onClick={() => setRefresh(current => current + 1)}>重试</button></Notice>}
      {actionProblem && <Notice tone="warning" announce>{actionProblem}</Notice>}
      <form className="actions memory-search" onSubmit={event => {
        event.preventDefault();
        const committed = query.trim();
        if (committed) show({ view: 'search', q: committed }, ({ hits }) => setSearch({ query: committed, hits }));
      }}>
        <label className="search"><Search size={16} aria-hidden="true" /><input ref={queryControl} type="search" name="query" aria-label="搜索活动资料" placeholder="搜索场地、设备或原文" maxLength={180} required value={query} onChange={event => setQuery(event.target.value)} /></label>
        <button className="button small">搜索</button>
        <Select label="资料核对状态" value={reviewFilter} onChange={setReviewFilter} options={['全部', '待核对', '已确认', '已停用']} triggerRef={reviewControl} />
        <Select label="资料引用范围" value={accessFilter} onChange={setAccessFilter} options={['全部', '允许 Agent 引用', '仅本机检索']} triggerRef={accessControl} />
      </form>
      <FilterChips label="资料筛选条件" items={[
        { id: 'query', label: '搜索', value: search?.query, remove: clearSearch, controlRef: queryControl },
        { id: 'review', label: '核对状态', value: reviewFilter !== '全部' && reviewFilter, remove: () => setReviewFilter('全部'), controlRef: reviewControl },
        { id: 'access', label: '引用范围', value: accessFilter !== '全部' && accessFilter, remove: () => setAccessFilter('全部'), controlRef: accessControl },
      ]} />
      {search && <div className="memory-results">
        <p className="muted" role="status">「{search.query}」 · {hits.length} 个匹配片段</p>
        {hits.map(hit => <button className="memory-hit" type="button" key={hit.chunkId}
          onClick={() => openPreview({ view: 'excerpt', chunk: hit.chunkId })}>
          <strong>{hit.name} · v{hit.revision} · {hit.location}</strong><span>{hit.excerpt.slice(0, 240)}</span>
        </button>)}
      </div>}
      <p className="muted source-result-count" role="status">显示 {visibleSources.length} / {sources.length} 份资料</p>
      {visibleSources.length ? mobile ? <ul className="source-index-cards" aria-label="活动资料索引">{visibleSources.map(source => <li key={source.id}>
        <div className="source-card-title"><strong>{source.name}</strong><Badge tone="neutral">v{source.revision}{!source.current && ' · 历史'}</Badge></div>
        <div className="source-card-status"><Badge tone={source.state === '已索引' ? 'success' : 'amber'}>{source.state} · {source.chunkCount} 片段</Badge>
          <Badge tone={source.reviewStatus === '已确认' ? 'success' : 'neutral'}>{source.reviewStatus}</Badge>
          {source.contentVersion > 0 && <small className="muted">人工修订 {source.contentVersion} 次</small>}</div>
        {source.note && <p className="muted">{source.note}</p>}
        <div className="source-card-access">{accessButton(source)}</div>
        {sourceActions(source)}
      </li>)}</ul> : <Table headers={['资料', '索引', '核对状态', 'Agent 引用', '原文与管理']} label="活动资料索引">
        {visibleSources.map(source => <tr key={source.id}>
          <td><strong>{source.name}</strong> <Badge tone="neutral">v{source.revision}</Badge>{!source.current && <small className="field-note">历史版本</small>}</td>
          <td><Badge tone={source.state === '已索引' ? 'success' : 'amber'}>{source.state} · {source.chunkCount} 片段</Badge>{source.note && <small className="field-note">{source.note}</small>}</td>
          <td><Badge tone={source.reviewStatus === '已确认' ? 'success' : 'neutral'}>{source.reviewStatus}</Badge>
            {source.contentVersion > 0 && <small className="field-note">人工修订 {source.contentVersion} 次</small>}</td>
          <td>{accessButton(source)}</td>
          <td>{sourceActions(source)}</td>
        </tr>)}
      </Table> : <Empty>{sources.length ? '没有符合当前条件的资料，可移除筛选标签。' : '导入资料后可以查找原文、查看索引版本和导出知识页。'}</Empty>}
    </Panel>

    {preview && <Dialog title={preview.excerpt?.name ?? preview.contents?.name ?? preview.image?.name ?? '活动知识页'} variant="drawer" fullOnMobile close={closePreview}>
      <button type="button" className="link-button preview-return" onClick={() => {
        if (!previewTrail.length) { closePreview(); return; }
        setPreview(previewTrail.at(-1));
        setPreviewTrail(current => current.slice(0, -1));
      }}><ArrowLeft size={16} aria-hidden="true" />{previewTrail.length ? '返回包内目录' : evidenceId ? returnLabel || '返回查看位置' : '返回资料列表'}</button>
      {preview.image && <>
        <p className="muted">v{preview.image.revision} · {preview.image.reviewStatus}</p>
        <LoadingImage key={preview.image.id} className="source-image-preview" src={memoryUrl(eventId, { view: 'download', source: preview.image.id })} alt={preview.image.name} mediaType={preview.image.mediaType} />
        <a className="button" href={memoryUrl(eventId, { view: 'download', source: preview.image.id })}><Download size={16} aria-hidden="true" />下载原件</a>
      </>}
      {preview.excerpt && <>
        <p className="muted">v{preview.excerpt.revision} · {preview.excerpt.location}</p>
        {preview.excerpt.textRevision > 0 && <Notice>人工修订 r{preview.excerpt.textRevision} · {preview.excerpt.editNote || '整理文字已更正'}</Notice>}
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
              {entry.chunkId && <button type="button" className="button small" onClick={() => openPreview({ view: 'excerpt', chunk: entry.chunkId })}>预览原文</button>}
            </td>
          </tr>)}
        </Table> : <Empty>没有可展示的包内文件。</Empty>}
      </>}
    </Dialog>}
    <input ref={replacement} type="file" hidden aria-label="替换单份资料" onChange={event => {
      const file = event.target.files[0];
      event.target.value = '';
      const source = replacementSource.current;
      if (!file || !source) return;
      if (file.name.split('.').at(-1).toLowerCase() !== source.name.split('.').at(-1).toLowerCase()) {
        setActionProblem('请使用相同格式的文件替换。其他格式可通过追加资料导入。');
        return;
      }
      setActionProblem('');
      setManaging(null);
      importFiles(eventId, [new File([file], source.name, { type: file.type })], Boolean(source.agentAccess));
    }} />
    {managing && <SourceEditor key={managing.id} eventId={eventId} source={managing} problem={actionProblem} updated={sourceUpdated}
      close={() => setManaging(null)} replace={source => { replacementSource.current = source; replacement.current.click(); }} />}
  </>;
}
