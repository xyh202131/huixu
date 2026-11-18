import { useEffect, useId, useRef, useState } from 'react';
import { ArrowRight, Check, FileText, Sparkles } from 'lucide-react';
import { Badge, Empty, Panel, Tabs } from './components';
import { Dialog, Notice, Popconfirm } from './interactions';
import { organizationRequest } from './memoryClient';
import { uid } from './model';
import { applyReviewFields, conflictEvidenceKey, currentReviewChoice, missingPlanFields, planFromReview, planSections, rebasePlanDraft, reviewChoices, topicPlanSections } from './organizationSchema';
import { topicEventDetails } from './topicPlan';
import { adoptionDiff, adoptExecutionPlan } from './executionPlan';

function factLabel(fact) {
  const field = planSections[fact.section].fields[fact.field];
  return [fact.entity, field].filter(Boolean).join(' · ');
}

function Evidence({ evidence, navigate, openSource }) {
  return <>
    <p className="import-evidence-location"><FileText size={16} aria-hidden="true" /><span>{evidence.name} · v{evidence.revision} · {evidence.location}
      {evidence.textRevision > 0 && ` · 人工修订 r${evidence.textRevision}`}</span></p>
    <blockquote>{evidence.excerpt}</blockquote>
    <button type="button" className="link-button" onClick={() => openSource ? openSource(evidence.chunkId) : navigate('sources/' + evidence.chunkId, { preserveScroll: true })}>查看完整片段</button>
  </>;
}

function ReviewMetric({ count, label, pending }) {
  return <div className={pending ? 'review-metric pending' : 'review-metric'}><dt>{label}</dt><dd>{count}</dd></div>;
}

function fieldStatus(fact, choices) {
  const saved = currentReviewChoice(fact, choices);
  if (saved) return saved.status ?? '已确认';
  return fact.options.length > 1 ? '待核对' : '已提取';
}

function FieldReviewEditor({ fact, saved, draft, save, reset, openSource, close }) {
  const id = useId();
  const [status, setStatus] = useState(draft?.status ?? saved?.status ?? '已确认');
  const [value, setValue] = useState(draft?.value ?? saved?.value ?? fact.options[0]?.value ?? '');
  const [note, setNote] = useState(draft?.note ?? saved?.note ?? '');
  let type = 'text';
  if (fact.field === 'date') type = 'date';
  if (['start', 'end'].includes(fact.field)) type = 'time';
  if (['target', 'budget', 'capacity', 'amount'].includes(fact.field)) type = 'number';
  const manual = !fact.options.some(option => option.value === value.trim());
  return <Dialog title={'编辑提取字段 · ' + factLabel(fact)} variant="drawer" fullOnMobile close={close}>
    <form className="form-stack" aria-label="编辑提取字段" onSubmit={event => {
      event.preventDefault();
      save({ status, value: value.trim(), note: note.trim(), evidence: conflictEvidenceKey(fact) });
    }}>
      <Tabs label="字段核对状态" items={['待核对', '已确认', '已忽略']} value={status} onChange={setStatus} />
      <div className="form-stack"><label htmlFor={id + '-value'}>采用值</label><input id={id + '-value'} name="value" type={type} min={type === 'number' ? 0 : undefined} step={fact.field === 'amount' || fact.field === 'budget' ? '0.01' : undefined}
        required={status === '已确认'} maxLength={240} value={value} onChange={event => setValue(event.target.value)} /></div>
      <div className="form-stack"><label htmlFor={id + '-note'}>核对依据</label><textarea id={id + '-note'} name="note" rows={3} maxLength={500} required={manual && status === '已确认'}
        value={note} onChange={event => setNote(event.target.value)} /></div>
      <p className="muted">可以填写新值并说明依据。标为待核对或已忽略后，该字段暂不带入新的方案草稿。</p>
      <div className="actions"><button className="button primary">保存字段</button>
        <button type="button" className="button" onClick={reset}>恢复提取结果</button></div>
    </form>
    <details open><summary>原始提取与出处</summary>{fact.options.map(option => <article className="evidence" key={option.value}>
      <strong>{option.value}</strong>{option.evidence.map(evidence => <Evidence key={evidence.chunkId} evidence={evidence}
        openSource={id => openSource(id, { status, value, note })} />)}
    </article>)}</details>
  </Dialog>;
}

export function ImportReview({ event, update, notify, navigate, organize, organizationRun, importRun }) {
  const [snapshot, setSnapshot] = useState(null);
  const [problem, setProblem] = useState('');
  const [generating, setGenerating] = useState(false);
  const [pendingOnly, setPendingOnly] = useState(false);
  const [editing, setEditing] = useState(null);
  const [editingDraft, setEditingDraft] = useState(null);
  const editorTrigger = useRef(null);
  const [selectedKeys, setSelectedKeys] = useState([]);
  const conflictHeading = useRef(null);
  const refreshToken = organizationRun?.token;

  useEffect(() => {
    if (importRun?.pending || organizationRun?.pending) return;
    const request = new AbortController();
    let timer;
    async function load() {
      try {
        const next = await organizationRequest(event.id, 'GET', request.signal);
        if (request.signal.aborted) return;
        setSnapshot(next);
        setProblem('');
        if (next.status === 'running') timer = setTimeout(load, 1800);
      } catch (error) {
        if (!request.signal.aborted) setProblem(error.message);
      }
    }
    void load();
    return () => { request.abort(); clearTimeout(timer); };
  }, [event.id, importRun, organizationRun?.pending, refreshToken]);

  const busy = importRun?.pending || organizationRun?.pending || snapshot?.status === 'running';
  const review = snapshot?.review;
  useEffect(() => {
    if (!busy && review && location.hash.startsWith('#/sources/conflict/')) {
      const key = location.hash.slice('#/sources/conflict/'.length);
      const element = document.getElementById('activity-conflict-' + key);
      if (element) { element.tabIndex = -1; element.focus({ preventScroll: true }); element.scrollIntoView({ block: 'start' }); }
    }
  }, [review?.revision, busy]);
  const choices = review ? reviewChoices(review, event.organizationChoices) : {};
  const conflicts = review?.facts.filter(fact => fact.options.length > 1) ?? [];
  const unresolved = conflicts.filter(fact => !choices[fact.key] && fieldStatus(fact, event.organizationChoices) !== '已忽略');
  useEffect(() => {
    if (!snapshot || busy || problem) return;
    const reviewConflicts = unresolved.map(fact => ({ key: fact.key, label: factLabel(fact) }));
    if (JSON.stringify(event.reviewConflicts ?? []) !== JSON.stringify(reviewConflicts)) {
      update(current => ({ ...current, reviewConflicts }));
    }
  }, [snapshot, busy, problem, event.organizationChoices, event.reviewConflicts]);
  const visibleConflicts = pendingOnly ? unresolved : conflicts;
  const plan = review && planFromReview(review, choices);
  const missing = plan ? missingPlanFields(plan, unresolved) : [];
  const error = problem || organizationRun?.error;
  const syncKeys = review?.facts.filter(fact => selectedKeys.includes(fact.key) &&
    (Object.hasOwn(choices, fact.key) ? Boolean(choices[fact.key]) : fact.options.length === 1)).map(fact => fact.key) ?? [];

  function editField(fact, trigger) {
    editorTrigger.current = trigger;
    setEditingDraft(null);
    setEditing(fact);
  }

  function choose(fact, value) {
    const evidence = conflictEvidenceKey(fact);
    update(current => ({ ...current, organizationChoices: { ...current.organizationChoices, [fact.key]: { value, evidence, status: '已确认' } } }));
  }

  function saveField(decision) {
    const latest = review.facts.find(fact => fact.key === editing.key);
    if (!latest || conflictEvidenceKey(latest) !== conflictEvidenceKey(editing)) {
      setProblem('该字段的来源已变化，请重新打开核对。');
      setEditing(null);
      return;
    }
    update(current => ({ ...current, organizationChoices: { ...current.organizationChoices, [editing.key]: decision } }));
    setEditing(null);
    notify('字段状态与内容已保存');
  }

  async function generate(selectedOnly = false) {
    setGenerating(true);
    setProblem('');
    try {
      const latest = await organizationRequest(event.id);
      if (latest.status !== 'ready' || latest.review?.revision !== review.revision) {
        setSnapshot(latest);
        setProblem('资料有新变化，请核对最新的整理结果。');
        return;
      }
      const latestChoices = reviewChoices(latest.review, event.organizationChoices);
      const draft = { ...planFromReview(latest.review, latestChoices), id: uid(), revision: latest.review.revision };
      update(current => {
        if (selectedOnly && !current.organizedPlan) return current;
        const currentChoices = reviewChoices(latest.review, current.organizationChoices);
        const organizedPlan = selectedOnly ? applyReviewFields(current.organizedPlan, latest.review, currentChoices, syncKeys)
          : { ...draft, ...planFromReview(latest.review, currentChoices) };
        return { ...current, organizedPlan };
      });
      if (selectedOnly) setSelectedKeys([]);
      notify(selectedOnly ? '已更新所选字段，其余草稿内容已保留' : '已生成可编辑的方案草稿');
      navigate('schedule/plan');
    } catch (error) {
      setProblem(error.message);
    } finally {
      setGenerating(false);
    }
  }

  return <Panel title="Agent 智能整理" className="import-review" action={<Badge tone={busy ? 'amber' : review ? 'success' : 'neutral'}>
    {busy ? '处理中' : review ? '可核对' : '待整理'}
  </Badge>}>
    {busy ? <Notice tone="info" announce>{importRun?.pending ? '资料正在解析。已允许引用的资料会在本批导入完成后开始整理。' : 'Agent 正在提取活动信息并比对原文。'}</Notice> :
      <>
        {error && <Notice tone="warning" announce>{error}</Notice>}
        {snapshot?.excluded > 0 && <p className="muted">{snapshot.excluded} 份资料当前仅供本机检索。允许 Agent 引用后，会纳入整理。</p>}
        {snapshot?.unparsed > 0 && <p className="muted">{snapshot.unparsed} 份资料暂无可提取的文字。解析状态可在活动索引中查看。</p>}
        {!review && !snapshot?.total && <Empty>导入资料并允许 Agent 引用后，这里会显示提取结果和待核对项。</Empty>}
        {snapshot?.total > 0 && (!review || review.failed > 0) && <button type="button" className="button" onClick={() => organize(event.id)}>
          <Sparkles size={17} aria-hidden="true" />{error || review ? '重试整理' : '整理当前资料'}
        </button>}
        {review && <>
          {review.covered < review.total && <Notice tone="warning">本次整理完成 {review.covered} / {review.total} 个片段。仍有 {review.total - review.covered} 个片段未完成，可在活动索引中核对。</Notice>}
          <dl className="import-review-summary" aria-label="整理结果">
            <ReviewMetric count={review.facts.length} label="已提取字段" />
            <ReviewMetric count={unresolved.length} label="待确认冲突" pending={unresolved.length > 0} />
            <ReviewMetric count={missing.length} label="缺失项" pending={missing.length > 0} />
          </dl>
          {conflicts.length > 0 && <div className="import-conflict-toolbar">
            <h3 ref={conflictHeading} tabIndex={-1}>冲突核对</h3>
            <Tabs label="筛选资料冲突" items={['全部冲突', '仅待确认']} value={pendingOnly ? '仅待确认' : '全部冲突'} onChange={value => setPendingOnly(value === '仅待确认')} />
          </div>}
          {pendingOnly && conflicts.length > 0 && !unresolved.length && <Empty>全部冲突已确认，可查看已采用的原文。</Empty>}
          {visibleConflicts.map(fact => <section className="import-conflict activity-anchor" id={'activity-conflict-' + encodeURIComponent(fact.key)} key={fact.key} aria-label={factLabel(fact)}>
            <div className="import-conflict-head"><h3>{factLabel(fact)}</h3>
              <div className="actions compact"><Badge tone={choices[fact.key] ? 'success' : 'amber'}>{fieldStatus(fact, event.organizationChoices)}</Badge>
                <button type="button" className="button small" onClick={event => editField(fact, event.currentTarget)}>编辑状态与内容</button></div>
            </div>
            <div className="evidence-grid">{fact.options.map(option => {
              const adopted = choices[fact.key] === option.value;
              return <article className={adopted ? 'evidence adopted' : 'evidence'} key={option.value}>
                <strong className="import-option-value">{option.value}</strong>
                <div>{option.evidence.map(evidence => <Evidence key={evidence.chunkId} evidence={evidence} navigate={navigate} />)}</div>
                <button type="button" className={adopted ? 'button small primary' : 'button small'}
                  aria-pressed={adopted} onClick={() => {
                    if (pendingOnly) conflictHeading.current?.focus({ preventScroll: true });
                    choose(fact, option.value);
                  }}>
                  {adopted && <Check size={16} aria-hidden="true" />}{adopted ? '已采用' : '采用'} {option.value}
                </button>
              </article>;
            })}</div>
          </section>)}
          <details className="import-review-detail" open={missing.length > 0}>
            <summary>缺失项（{missing.length}）</summary>
            {missing.length ? <ul>{missing.map((label, index) => <li key={index}>{label}</li>)}</ul> : <p className="muted">已提取当前检查所需的字段。</p>}
          </details>
          <details className="import-review-detail">
            <summary>提取结果与出处（{review.facts.length}）</summary>
            {Object.entries(planSections).map(([section, { label }]) => {
              const facts = review.facts.filter(fact => fact.section === section);
              if (!facts.length) return null;
              return <section className="import-facts" key={section}><h3>{label}</h3><dl>
                {facts.map(fact => <div key={fact.key}><dt>{factLabel(fact)} <Badge>{fieldStatus(fact, event.organizationChoices)}</Badge></dt>
                  {fact.options.map(option => <dd key={option.value}>{option.value} <span className="import-evidence-links">
                    {option.evidence.map(evidence => <button type="button" key={evidence.chunkId} className="link-button"
                      onClick={() => navigate('sources/' + evidence.chunkId, { preserveScroll: true })}>{evidence.name} · {evidence.location}</button>)}
                  </span></dd>)}
                  <dd><div className="actions compact">
                    <button type="button" className="button small" onClick={event => editField(fact, event.currentTarget)}>编辑状态与内容</button>
                    {event.organizedPlan && <label className="review-field-select"><input type="checkbox" aria-label={'更新草稿 · ' + factLabel(fact)}
                      checked={syncKeys.includes(fact.key)} disabled={Object.hasOwn(choices, fact.key) && !choices[fact.key]}
                      onChange={event => setSelectedKeys(current => event.target.checked ? [...current, fact.key] : current.filter(key => key !== fact.key))} />更新此字段到草稿</label>}
                  </div>
                  {currentReviewChoice(fact, event.organizationChoices) && <p className="muted">当前核对值　{choices[fact.key] || '暂不采用'}
                    {currentReviewChoice(fact, event.organizationChoices).note && ' · ' + currentReviewChoice(fact, event.organizationChoices).note}</p>}
                  </dd>
                </div>)}
              </dl></section>;
            })}
          </details>
          <div className="import-review-footer">
            {unresolved.length > 0 && <p className="muted">未确认冲突暂留空，其余信息可以先生成草稿。</p>}
            {event.organizedPlan && <button type="button" className="button" onClick={() => navigate('schedule/plan')}>打开现有草稿</button>}
            {event.organizedPlan && <button type="button" className="button primary" disabled={generating || !syncKeys.length}
              onClick={() => generate(true)}>更新所选字段（{syncKeys.length}）</button>}
            {event.organizedPlan && !generating ?
              <Popconfirm label="用整理结果替换草稿" confirmLabel="确认替换" description="替换后，现有草稿的手工修改会被覆盖。"
                className="button primary" onConfirm={generate} /> :
              <button type="button" className="button primary" disabled={generating} onClick={() => generate()}>
                {generating ? '正在生成' : '生成可编辑方案'}<ArrowRight size={17} aria-hidden="true" />
              </button>}
          </div>
        </>}
      </>}
    {editing && <FieldReviewEditor key={editing.key} fact={editing} saved={currentReviewChoice(editing, event.organizationChoices)} draft={editingDraft}
      openSource={(id, draft) => {
        const fact = editing;
        setEditingDraft(draft);
        navigate('sources/' + id, { preserveScroll: true, returnLabel: '返回字段核对', returnFocus: editorTrigger.current, onReturn: () => setEditing(fact) });
      }} save={saveField} close={() => setEditing(null)} reset={() => {
        update(current => {
          const organizationChoices = { ...current.organizationChoices };
          delete organizationChoices[editing.key];
          return { ...current, organizationChoices };
        });
        setEditing(null);
        notify('已恢复该字段的提取结果');
      }} />}
  </Panel>;
}

function PlanFields({ fields, data, change, topic }) {
  const id = useId();
  return <div className="import-plan-fields">{Object.entries(fields).map(([field, label]) => {
    const labelId = id + '-' + field;
    const input = { value: data[field] ?? '', onChange: e => change(field, e.target.value), 'aria-labelledby': labelId };
    return <label key={field} className={['title', 'goal', 'registrationUrl'].includes(field) ? 'plan-title-field' : undefined}><span id={labelId}>{label}</span>
      {field === 'goal' ? <textarea rows={2} {...input} /> : <input {...input}
        type={topic && field === 'date' ? 'date' : 'text'} required={topic && field === 'title'} />}
    </label>;
  })}</div>;
}

export function OrganizedPlan({ event, plan, update, notify, navigate }) {
  const [adopting, setAdopting] = useState(false);
  const [edited, setEdited] = useState(null);
  const [rebased, setRebased] = useState(false);
  const previousPlan = useRef(plan);
  useEffect(() => {
    const previous = previousPlan.current;
    previousPlan.current = plan;
    if (previous === plan || !edited) return;
    setEdited(rebasePlanDraft(previous, plan, edited));
    setRebased(true);
  }, [plan]);
  const draft = edited ?? plan;
  const missing = missingPlanFields(draft);
  const dirty = edited !== null;
  const topic = draft.topicPlan;
  const sections = topic ? topicPlanSections : planSections;

  function edit(change) {
    setEdited(current => change(current ?? plan));
  }

  const preview = adopting ? adoptExecutionPlan(event, plan) : null;
  return <Panel title={plan.manual ? '活动方案' : topic ? '主题生成的活动方案' : '导入生成的活动方案'}
    action={<Badge tone={dirty ? 'amber' : 'neutral'}>{dirty ? '有未保存的修改' : '可编辑草稿'}</Badge>}>
    {rebased && <Notice>资料有局部更新，未保存的手工修改已保留，请核对后保存。</Notice>}
    {topic && !plan.manual && <div className="topic-plan-context">
      <p className="muted">{draft.model ? '由已配置的模型起草。' : '由会序的活动模板起草。'}环节时长为建议，具体时间、场地和负责人由团队确认。</p>
      {draft.reference && <p className="muted">参考《{draft.reference.title}》{draft.reference.version ? ' v' + draft.reference.version : '草稿'}，
        借用 {draft.reference.durations} 个环节时长、{draft.reference.tasks} 项筹备任务
        {draft.reference.roles > 0 && '、' + draft.reference.roles + ' 个岗位'}{draft.reference.supplies > 0 && '、' + draft.reference.supplies + ' 项物料'}。</p>}
      {draft.reference?.lessons?.length > 0 && <ul>{draft.reference.lessons.map((item, i) => <li key={i}>{item.condition} · {item.advice}（来源 v{item.version}）</li>)}</ul>}
    </div>}
    <form className="form-stack" onSubmit={event => {
      event.preventDefault();
      if (topic && !draft.event.title.trim()) {
        notify('请填写活动名称');
        return;
      }
      update(current => current.organizedPlan?.id === draft.id ? {
        ...current, ...(topic && !current.version ? topicEventDetails(draft.event) : {}), organizedPlan: draft,
      } : current);
      setEdited(null);
      setRebased(false);
      notify('已保存活动方案草稿');
    }}>
      <PlanFields fields={sections.event.fields} topic={topic} data={draft.event} change={(field, value) => edit(current => ({ ...current, event: { ...current.event, [field]: value } }))} />
      {Object.entries(sections).filter(([section]) => section !== 'event').map(([section, { label, fields }]) =>
        <details key={section} className="import-review-detail">
          <summary>{label}（{draft[section].length}）</summary>
          {draft[section].map((row, index) => <fieldset className="import-plan-row" key={row.id}>
            <legend>{row.name || label + ' ' + (index + 1)}</legend>
            <PlanFields fields={fields} topic={topic} data={row} change={(field, value) => edit(current => ({
              ...current, [section]: current[section].map(item => item.id === row.id ? { ...item, [field]: value } : item),
            }))} />
            <button type="button" className="button small" onClick={() => edit(current => ({
              ...current, [section]: current[section].filter(item => item.id !== row.id),
            }))}>移除此项</button>
          </fieldset>)}
          <button type="button" className="button small" onClick={() => {
            const id = uid();
            edit(current => ({ ...current, [section]: [...current[section], { id }] }));
          }}>添加{label}</button>
        </details>)}
      <div className="import-review-footer plan-editor-actions">
        {missing.length > 0 && (topic ? <details className="plan-missing"><summary>{missing.length} 项待补</summary>
          <ul>{missing.map((item, index) => <li key={index}>{item}</li>)}</ul></details> : <span className="muted">{missing.length} 项待补</span>)}
        {topic && <button type="button" className="button" disabled={dirty} onClick={() => navigate('materials/design')}>生成设计提示词</button>}
        <button className="button primary">保存活动方案</button>
        <button className="button" type="button" disabled={dirty} onClick={() => setAdopting(true)}>
          {event.version ? '采用筹备任务' : '采用为执行计划'}</button>
      </div>
    </form>
    {preview && <Dialog title="核对采用范围" close={() => setAdopting(false)}>
      <div className="form-stack">
        {!event.version && <><strong>待排程环节（{preview.executionPlan.agenda.length}）</strong>
          <ul>{preview.executionPlan.agenda.map(row => <li key={row.sourceId}>{row.title} · {row.start && row.end ? row.start + '–' + row.end : (row.duration ? row.duration + ' 分钟 · ' : '') + '时段待定'} · {row.room || '会场待定'}
            <small className="field-note">{adoptionDiff(event.executionPlan?.agenda.find(old => old.sourceId === row.sourceId), row,
              { title: '名称', duration: '时长', date: '日期', start: '开始', end: '结束', room: '会场', guest: '讲者', equipment: '设备', expected: '分场预计人数' })}</small></li>)}
            {(event.executionPlan?.agenda ?? []).filter(old => !preview.executionPlan.agenda.some(row => row.sourceId === old.sourceId))
              .map(old => <li key={old.id}>移出待排程 · {old.title}</li>)}</ul>
          {preview.executionPlan.rooms.length > 0 && <><strong>本次采用的会场</strong><ul>{preview.executionPlan.rooms.map((room, index) =>
            <li key={index}>{room.id} · {room.capacity ? room.capacity + ' 人' : '容量待定'} · {room.equipment.join('、') || '设备待核对'}</li>)}</ul></>}</>}
        <strong>筹备任务（{plan.tasks?.filter(row => row.name?.trim()).length ?? 0}）</strong>
        <ul>{preview.tasks.filter(task => plan.tasks?.some(row => row.id === task.sourceId)).map(task =>
          <li key={task.sourceId}>{task.name} · {task.owner}{task.done && ' · 已完成'} · {adoptionDiff(
            event.tasks.find(old => old.sourceId === task.sourceId), task, { name: '名称', owner: '负责人', offset: '倒排天数' })}</li>)}</ul>
        <p className="muted">{event.version ? '已发布议程的调整请通过变更单处理。' : '本次更新内部排程和筹备清单。确认发布后才会更新对外议程。'}</p>
        <button className="button primary" onClick={() => {
          update(current => adoptExecutionPlan({ ...current, version: Math.max(event.version, current.version) }, current.organizedPlan));
          setAdopting(false);
          notify('执行计划已更新');
          navigate(event.version ? 'prep' : 'schedule/execution');
        }}>确认采用</button>
      </div>
    </Dialog>}
  </Panel>;
}
