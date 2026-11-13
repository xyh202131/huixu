import { useEffect, useRef, useState } from 'react';
import { ArrowRight, Check, FileText, Sparkles } from 'lucide-react';
import { Badge, Empty, Panel, Tabs } from './components';
import { Notice, Popconfirm } from './interactions';
import { organizationRequest } from './memoryClient';
import { uid } from './model';
import { conflictEvidenceKey, missingPlanFields, planFromReview, planSections, reviewChoices } from './organizationSchema';

function factLabel(fact) {
  const field = planSections[fact.section].fields[fact.field];
  return [fact.entity, field].filter(Boolean).join(' · ');
}

function Evidence({ evidence, navigate }) {
  return <>
    <p className="import-evidence-location"><FileText size={16} aria-hidden="true" /><span>{evidence.name} · v{evidence.revision} · {evidence.location}</span></p>
    <blockquote>{evidence.excerpt}</blockquote>
    <button type="button" className="link-button" onClick={() => navigate('sources/' + evidence.chunkId, { preserveScroll: true })}>查看完整片段</button>
  </>;
}

function ReviewMetric({ count, label, pending }) {
  return <div className={pending ? 'review-metric pending' : 'review-metric'}><dt>{label}</dt><dd>{count}</dd></div>;
}

export function ImportReview({ event, update, notify, navigate, organize, organizationRun, importRun }) {
  const [snapshot, setSnapshot] = useState(null);
  const [problem, setProblem] = useState('');
  const [generating, setGenerating] = useState(false);
  const [pendingOnly, setPendingOnly] = useState(false);
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
  const choices = review ? reviewChoices(review, event.organizationChoices) : {};
  const conflicts = review?.facts.filter(fact => fact.options.length > 1) ?? [];
  const unresolved = conflicts.filter(fact => !fact.options.some(option => option.value === choices[fact.key]));
  const visibleConflicts = pendingOnly ? unresolved : conflicts;
  const plan = review && planFromReview(review, choices);
  const missing = plan ? missingPlanFields(plan, unresolved) : [];
  const error = problem || organizationRun?.error;

  function choose(fact, value) {
    const evidence = conflictEvidenceKey(fact);
    update(current => ({ ...current, organizationChoices: { ...current.organizationChoices, [fact.key]: { value, evidence } } }));
  }

  async function generate() {
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
      const choicesMatch = latest.review.facts.every(fact => fact.options.length === 1 || fact.options.some(option => option.value === latestChoices[fact.key]));
      if (!choicesMatch) {
        setSnapshot(latest);
        setProblem('请先确认新增的冲突。');
        return;
      }
      const draft = { ...planFromReview(latest.review, latestChoices), id: uid(), revision: latest.review.revision };
      update(current => ({ ...current, organizedPlan: draft }));
      notify('已生成可编辑的方案草稿');
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
          {visibleConflicts.map(fact => <section className="import-conflict" key={fact.key} aria-label={factLabel(fact)}>
            <div className="import-conflict-head"><h3>{factLabel(fact)}</h3>
              <Badge tone={choices[fact.key] ? 'success' : 'amber'}>{choices[fact.key] ? '已确认' : '待确认'}</Badge>
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
                {facts.map(fact => <div key={fact.key}><dt>{factLabel(fact)}</dt>
                  {fact.options.map(option => <dd key={option.value}>{option.value} <span className="import-evidence-links">
                    {option.evidence.map(evidence => <button type="button" key={evidence.chunkId} className="link-button"
                      onClick={() => navigate('sources/' + evidence.chunkId, { preserveScroll: true })}>{evidence.name} · {evidence.location}</button>)}
                  </span></dd>)}
                </div>)}
              </dl></section>;
            })}
          </details>
          <div className="import-review-footer">
            {unresolved.length > 0 && <p className="muted">确认全部冲突后可以生成方案。</p>}
            {event.organizedPlan && <button type="button" className="button" onClick={() => navigate('schedule/plan')}>打开现有草稿</button>}
            {event.organizedPlan && !generating && unresolved.length === 0 ?
              <Popconfirm label="用整理结果替换草稿" confirmLabel="确认替换" description="替换后，现有草稿的手工修改会被覆盖。"
                className="button primary" onConfirm={generate} /> :
              <button type="button" className="button primary" disabled={generating || unresolved.length > 0} onClick={generate}>
                {generating ? '正在生成' : '生成可编辑方案'}<ArrowRight size={17} aria-hidden="true" />
              </button>}
          </div>
        </>}
      </>}
  </Panel>;
}

function PlanFields({ section, data, change }) {
  return <div className="import-plan-fields">{Object.entries(planSections[section].fields).map(([field, label]) =>
    <label key={field} className={field === 'title' ? 'plan-title-field' : undefined}>{label}
      <input value={data[field] ?? ''} onChange={e => change(field, e.target.value)} />
    </label>)}</div>;
}

export function OrganizedPlan({ plan, update, notify }) {
  const [edited, setEdited] = useState(null);
  const draft = edited ?? plan;
  const missing = missingPlanFields(draft);
  const dirty = edited !== null;

  function edit(change) {
    setEdited(current => change(current ?? plan));
  }

  return <Panel title="导入生成的活动方案" action={<Badge tone={dirty ? 'amber' : 'neutral'}>{dirty ? '有未保存的修改' : '可编辑草稿'}</Badge>}>
    <form className="form-stack" onSubmit={event => {
      event.preventDefault();
      update(current => current.organizedPlan?.id === draft.id ? { ...current, organizedPlan: draft } : current);
      setEdited(null);
      notify('已保存活动方案草稿');
    }}>
      <PlanFields section="event" data={draft.event} change={(field, value) => edit(current => ({ ...current, event: { ...current.event, [field]: value } }))} />
      {Object.entries(planSections).filter(([section]) => section !== 'event').map(([section, { label }]) =>
        <details key={section} className="import-review-detail">
          <summary>{label}（{draft[section].length}）</summary>
          {draft[section].map((row, index) => <fieldset className="import-plan-row" key={row.id}>
            <legend>{row.name || label + ' ' + (index + 1)}</legend>
            <PlanFields section={section} data={row} change={(field, value) => edit(current => ({
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
        {missing.length > 0 && <span className="muted">{missing.length} 项待补</span>}
        <button className="button primary">保存活动方案</button>
      </div>
    </form>
  </Panel>;
}
