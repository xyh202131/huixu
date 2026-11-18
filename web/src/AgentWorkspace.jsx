import { useEffect, useRef, useState } from 'react';
import { ArrowUp, FileText, PanelRightClose, Sparkles } from 'lucide-react';
import { Badge, IconButton } from './components';
import { Dialog, Notice } from './interactions';
import { checkinPoint, roomLabel, timeRange } from './scheduling';
import { RescueBlockers } from './RescueChange';

function AgentResponse({ run, event, ask, stop, askLocal, openSettings, reviewProposal, openSource, openReviewedChange, selectCandidate }) {
  const released = run.reviewChangeId && event.history.find(change => change.id === run.reviewChangeId);
  const options = run.proposal?.kind === 'rescue' ? run.proposal.analysis.plans : run.proposal?.kind === 'move' ?
    [run.proposal.analysis.requested, ...run.proposal.analysis.alternatives] : [];
  const available = options.flatMap((option, index) => option.proof ? [index + 1] : []);
  const busy = Boolean(run.execution?.pending);
  return <>
    <p className="agent-question">{run.question}</p>
    {run.pending && <>
      <Notice announce>正在分析请求与校验安排。</Notice>
      <button type="button" className="button small" onClick={stop}>停止等待</button>
    </>}
    {run.stopped && <Notice announce>本次请求已停止。</Notice>}
    {run.error && <>
      <Notice tone="warning" announce>{run.error}</Notice>
      <div className="actions compact">
        <button type="button" className="button small" onClick={() => ask(run.question)}>重试请求</button>
        {run.code === 'MODEL_NOT_CONFIGURED' && <>
          <button type="button" className="button small" onClick={openSettings}>打开模型设置</button>
          <button type="button" className="button small" onClick={() => askLocal(run.question)}>使用本机规则演练</button>
        </>}
      </div>
    </>}
    {run.answer && <p className="agent-answer" role="status">{run.answer}</p>}
    {run.evidence && <p className="agent-evidence">已读取 {run.evidence.title} · {run.evidence.version ? '议程 v' + run.evidence.version : '计划草稿'}</p>}
    {run.statusReads?.length > 0 && <p className="agent-evidence">已读取 {run.statusReads.join('、')}</p>}
    {run.citations?.length > 0 && <details className="agent-sources" open>
      <summary>检索到的原文（{run.citations.length}）</summary>
      <ol>{run.citations.map((item, index) => <li key={item.chunkId}>
        <button type="button" id={`agent-source-${event.id}-${item.chunkId}`} className="memory-hit" onClick={() => openSource(item.chunkId)}>
          <span className="agent-source-number" aria-hidden="true">{index + 1}</span>
          <span><strong>{item.name} · v{item.revision}</strong><small>{item.location}</small></span>
          <FileText size={16} aria-hidden="true" />
        </button>
      </li>)}</ol>
    </details>}
    {run.model && <p className="agent-evidence">模型 · {run.model}</p>}
    {run.proposal?.kind === 'move' && run.proposal.analysis && <MoveAnalysis proposal={run.proposal} event={event} selected={run.context?.selected} {...{ selectCandidate, reviewProposal, busy }} />}
    {run.proposal?.kind === 'rescue' && <RescueProposal proposal={run.proposal} selected={run.context?.selected} {...{ reviewProposal, selectCandidate, busy }} />}
    {run.confirmation && available.length > 0 && !released && !run.execution?.refresh && <p className="agent-evidence">
      可执行方案 {available.join('、')}。回复「按方案 {available.includes(2) ? 2 : available[0]} 执行」即可更新议程、签到点、岗位、台本和大屏，并生成通知草稿。
    </p>}
    {run.execution && <div className="agent-execution">
      <p className="agent-question">{run.execution.question}</p>
      <Notice tone={run.execution.warning ? 'warning' : undefined} announce>
        {busy ? '正在复查并发布方案 ' + run.execution.number + '…' : run.execution.message}
      </Notice>
      {run.execution.refresh && <button type="button" className="button small" onClick={() => (run.local ? askLocal : ask)(run.question)}>重新预览原请求</button>}
    </div>}
    {run.proposal?.kind === 'event' && <button type="button" className="button primary" onClick={() => reviewProposal()}>打开活动草稿</button>}
    {released && <>
      <Notice tone="success" announce>{released.title}已发布 · v{released.version}</Notice>
      <button type="button" className="button small" onClick={() => openReviewedChange(released.id)}>查看发布记录</button>
    </>}
    {run.reviewChangeId && run.reviewChangeId === event.change?.id && <button type="button" className="button small" onClick={() => openReviewedChange()}>查看待发布变更单</button>}
  </>;
}

function ProposalImpact({ impact, selected, number }) {
  if (!impact) return null;
  return <details className="agent-plan-impact import-review-detail" open={selected || undefined}>
    <summary>方案 {number} 影响 · {impact.rows.length} 个环节 · {impact.count} 人待通知</summary>
    {impact.rows.map(({ before, after, checkin, confirmed, pending, waitlisted, checkedIn, posts }) => <div className="agent-plan-row" key={before.id}>
      <strong>{before.title}</strong>
      <span>{roomLabel(before.room)} {timeRange(before)} → {roomLabel(after.room)} {timeRange(after)}</span>
      <span>{checkin.before === checkin.after ? checkin.after : checkin.before + ' → ' + checkin.after}</span>
      <span>{confirmed} 人已确认 · {pending} 人待审核 · {waitlisted} 人候补 · {checkedIn} 人已签到</span>
      <span>岗位 {posts.map(({ role, count }) => role + (count ? ' ' + count + ' 人' : '待分配')).join('、')}</span>
    </div>)}
    {impact.notices.map(({ role, count, body }, index) => <details className="agent-notice-preview" key={index}>
      <summary>{role}通知草稿 · {count} 人</summary>
      <div className="message-preview">{body}</div>
    </details>)}
  </details>;
}

function RescueProposal({ proposal, selected, reviewProposal, selectCandidate, busy }) {
  const { analysis } = proposal;
  const index = selected - 1;
  return <section className="agent-move-analysis" aria-label="整场救场分析">
    <h3>{analysis.affected.length} 个受影响环节</h3>
    {analysis.plans.length > 0 && <div className="selection-list">{analysis.plans.map((plan, position) => <div className="agent-plan-option" key={position}>
      <button type="button" disabled={busy} aria-pressed={index === position} onClick={() => selectCandidate(position + 1)}>
        <span className="radio-mark" aria-hidden="true" />
        <strong>方案 {position + 1}{position === 0 && ' · 推荐'}</strong><Badge tone="success">组合校验通过</Badge>
        <span className="choice-note">{plan.moves.map(move => roomLabel(move.room) + ' ' + timeRange(move)).join(' · ')}</span>
      </button>
      <ProposalImpact impact={plan.impact} number={position + 1} selected={index === position} />
    </div>)}</div>}
    <RescueBlockers analysis={analysis} />
    <button type="button" className="button primary" disabled={busy} onClick={() => reviewProposal(analysis.plans[index])}>打开整场变更单核对</button>
  </section>;
}

function MoveAnalysis({ proposal, event, selected, reviewProposal, selectCandidate, busy }) {
  const { requested, alternatives, blocked, window } = proposal.analysis;
  const { affected } = proposal;
  const options = [requested, ...alternatives];
  const selection = options[selected - 1] ? selected - 1 : 0;
  const { candidate, issues } = options[selection];
  const room = event.rooms.find(item => item.id === candidate.room);
  const session = event.agenda.find(item => item.id === proposal.before.id);
  return <section className="agent-move-analysis" aria-label="议程调整分析">
    <h3>{proposal.before.title} · 调整方案</h3>
    <div className="agent-move-compare">
      <p><small>原安排</small><strong>{roomLabel(proposal.before.room)}</strong><span>{timeRange(proposal.before)}</span></p>
      <p><small>所选方案</small><strong>{roomLabel(candidate.room)}</strong><span>{timeRange(candidate)}</span></p>
    </div>
    <div className="selection-list" aria-label="选择调整方案">{options.map(({ candidate: option, issues: blockers, impact }, index) =>
      <div className="agent-plan-option" key={`${option.room}/${option.start}/${option.end}`}>
        <button type="button" disabled={busy} aria-pressed={selection === index} onClick={() => selectCandidate(index + 1)}>
          <span className="radio-mark" aria-hidden="true" /><strong>{roomLabel(option.room)} · {timeRange(option)}</strong>
          <Badge tone={blockers.length ? 'amber' : 'success'}>{blockers.length ? '存在冲突' : '校验通过'}</Badge>
          <span className="choice-note">方案 {index + 1} · {index === 0 ? '原请求' : '备选'}{blockers.length > 0 && ' · ' + blockers.join('、')}</span>
        </button>
        <ProposalImpact impact={impact} number={index + 1} selected={selection === index} />
      </div>)}</div>
    {requested.issues.length > 0 && !alternatives.length && <>
      <Notice tone="warning">{timeRange(window)} 的搜索范围内暂无可行方案。</Notice>
      {blocked.filter(({ candidate }) => candidate.room !== requested.candidate.room).slice(0, 3).map(({ candidate, issues }) =>
        <p key={candidate.room} className="muted">{roomLabel(candidate.room)}　{issues.join('、')}</p>)}
    </>}
    {affected && !options[selection].impact && <dl className="agent-move-impact">
      <div><dt>容量</dt><dd>{affected.confirmed} 人已确认{room && ` / ${room.capacity} 个名额`}</dd></div>
      <div><dt>所需设备</dt><dd>{session?.equipment?.join('、') || '无额外设备要求'}</dd></div>
      <div><dt>报名影响</dt><dd>{affected.waitlisted} 人候补 · {affected.pending} 人待审核 · {affected.checkedIn} 人已签到</dd></div>
      <div><dt>新签到点</dt><dd>{checkinPoint(candidate)} · {affected.assignedGuides} 人已认领分场引导</dd></div>
    </dl>}
    <button type="button" className="button primary" disabled={busy} onClick={() => reviewProposal(candidate)}>{issues.length ? '打开变更单查看冲突' : '打开变更单核对'}</button>
  </section>;
}

export function AgentWorkspace({ id, event, account, docked, open, close, run, history, clearHistory, selectCandidate, ask, stop, askLocal, openSettings, reviewProposal, openSource, openReviewedChange }) {
  const [input, setInput] = useState('');
  const transcript = useRef(null);
  const question = run?.question;
  const busy = Boolean(run?.pending || run?.execution?.pending);

  useEffect(() => {
    if (transcript.current) transcript.current.scrollTop = 0;
  }, [question]);

  function submit(event) {
    event.preventDefault();
    if (busy || !input.trim()) return;
    ask(input.trim());
    setInput('');
  }

  if (!docked && !open) return null;
  const content = <>
    <div className="agent-context"><FileText size={15} aria-hidden="true" /><span>{event.title}</span></div>
    <div ref={transcript} className="agent-transcript" role="region" aria-label="Agent 对话" tabIndex={run ? 0 : undefined}>
      {!!history.length && <details><summary>此前对话（{history.length}）</summary>{history.map((item, index) =>
        <div key={index}><strong>{item.question}</strong><p>{item.answer}</p></div>)}</details>}
      {run ? <AgentResponse {...{ run, event, ask, stop, askLocal, openSettings, reviewProposal, openSource, openReviewedChange, selectCandidate }} /> :
        <p className="muted">{account ? '查询活动进展、查找资料，或准备一份议程调整草稿。' : '配置模型后即可询问当前活动、起草方案或分析议程调整。访客草稿保留到本次页面关闭。'}</p>}
      {!busy && <div className="agent-prompts">
        {run && <button type="button" className="button small" onClick={clearHistory}>清空本场对话</button>}
        <button type="button" className="button small" onClick={() => ask('当前活动的筹备进展怎么样？')}>查看筹备进展</button>
        {account && <button type="button" className="button small" onClick={() => ask('列出当前活动可以引用的导入资料及其版本。')}>查看可引用资料</button>}
        <button type="button" className="button small" onClick={openSettings}>配置模型</button>
      </div>}
    </div>
    <form className="agent-compose" onSubmit={submit}>
      <textarea name="command" aria-label="对 Agent 说" placeholder="例如：创新工作坊几点开始？" maxLength={2000} rows={2} enterKeyHint="send"
        value={input} onChange={event => setInput(event.target.value)} onKeyDown={event => {
          if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing || event.keyCode === 229) return;
          event.preventDefault();
          event.currentTarget.form.requestSubmit();
        }} />
      <IconButton type="submit" className="button primary" label="提交给 Agent" icon={ArrowUp}
        busy={busy} disabled={busy || !input.trim()} />
    </form>
  </>;

  if (!docked) return <Dialog title="Agent 工作台" variant="drawer" className="agent-drawer" fullOnMobile close={close}>{content}</Dialog>;
  return <aside id={id} className="activity-agent" aria-label="Agent 工作台" tabIndex={-1} hidden={!open}>
    <header className="agent-workspace-header">
      <h2><Sparkles size={17} aria-hidden="true" />Agent 工作台</h2>
      <IconButton label="收起 Agent" icon={PanelRightClose} variant="ghost" onClick={close} />
    </header>
    {content}
  </aside>;
}
