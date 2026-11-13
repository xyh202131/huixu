import { useEffect, useRef, useState } from 'react';
import { ArrowUp, FileText, PanelRightClose, Sparkles } from 'lucide-react';
import { Badge } from './components';
import { Dialog, Notice } from './interactions';
import { checkinPoint, roomLabel, timeRange } from './scheduling';

function AgentResponse({ run, event, ask, stop, askLocal, openSettings, reviewProposal, openSource, openReviewedChange }) {
  const released = run.reviewChangeId && event.history.find(change => change.id === run.reviewChangeId);
  return <>
    <p className="agent-question">{run.question}</p>
    {run.pending && <>
      <Notice announce>正在等待模型应答。</Notice>
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
        <button type="button" className="memory-hit" onClick={() => openSource(item.chunkId)}>
          <span className="agent-source-number" aria-hidden="true">{index + 1}</span>
          <span><strong>{item.name} · v{item.revision}</strong><small>{item.location}</small></span>
          <FileText size={16} aria-hidden="true" />
        </button>
      </li>)}</ol>
    </details>}
    {run.model && <p className="agent-evidence">模型 · {run.model}</p>}
    {run.proposal?.kind === 'move' && run.proposal.analysis && <MoveAnalysis proposal={run.proposal} event={event} reviewProposal={reviewProposal} />}
    {run.proposal?.kind === 'event' && <button type="button" className="button primary" onClick={() => reviewProposal()}>打开活动草稿</button>}
    {released && <>
      <Notice tone="success" announce>{released.title}已发布 · v{released.version}</Notice>
      <button type="button" className="button small" onClick={() => openReviewedChange(released.id)}>查看发布记录</button>
    </>}
    {run.reviewChangeId && run.reviewChangeId === event.change?.id && <button type="button" className="button small" onClick={() => openReviewedChange()}>查看待发布变更单</button>}
  </>;
}

function MoveAnalysis({ proposal, event, reviewProposal }) {
  const { requested, alternatives, blocked, window } = proposal.analysis;
  const { affected } = proposal;
  const options = [requested, ...alternatives];
  const [selection, setSelection] = useState(() => requested.issues.length && alternatives.length ? 1 : 0);
  const { candidate, issues } = options[selection];
  const room = event.rooms.find(item => item.id === candidate.room);
  const session = event.agenda.find(item => item.id === proposal.before.id);
  return <section className="agent-move-analysis" aria-label="议程调整分析">
    <h3>{proposal.before.title} · 调整方案</h3>
    <div className="agent-move-compare">
      <p><small>原安排</small><strong>{roomLabel(proposal.before.room)}</strong><span>{timeRange(proposal.before)}</span></p>
      <p><small>所选方案</small><strong>{roomLabel(candidate.room)}</strong><span>{timeRange(candidate)}</span></p>
    </div>
    <div className="selection-list" aria-label="选择调整方案">{options.map(({ candidate: option, issues: blockers }, index) => <button type="button"
      key={`${option.room}/${option.start}/${option.end}`} aria-pressed={selection === index} onClick={() => setSelection(index)}>
      <span className="radio-mark" aria-hidden="true" /><strong>{roomLabel(option.room)} · {timeRange(option)}</strong>
      <Badge tone={blockers.length ? 'amber' : 'success'}>{blockers.length ? '存在冲突' : '校验通过'}</Badge>
      <span className="choice-note">{index === 0 ? '原请求' : '备选'}{blockers.length > 0 && ' · ' + blockers.join('、')}</span>
    </button>)}</div>
    {requested.issues.length > 0 && !alternatives.length && <>
      <Notice tone="warning">{timeRange(window)} 的搜索范围内暂无可行方案。</Notice>
      {blocked.filter(({ candidate }) => candidate.room !== requested.candidate.room).slice(0, 3).map(({ candidate, issues }) =>
        <p key={candidate.room} className="muted">{roomLabel(candidate.room)}　{issues.join('、')}</p>)}
    </>}
    <dl className="agent-move-impact">
      <div><dt>容量</dt><dd>{affected.confirmed} 人已确认{room && ` / ${room.capacity} 个名额`}</dd></div>
      <div><dt>所需设备</dt><dd>{session?.equipment?.join('、') || '无额外设备要求'}</dd></div>
      <div><dt>报名影响</dt><dd>{affected.waitlisted} 人候补 · {affected.pending} 人待审核 · {affected.checkedIn} 人已签到</dd></div>
      <div><dt>新签到点</dt><dd>{checkinPoint(candidate)} · {affected.assignedGuides} 人已认领分场引导</dd></div>
    </dl>
    <button type="button" className="button primary" onClick={() => reviewProposal(candidate)}>{issues.length ? '打开变更单查看冲突' : '打开变更单核对'}</button>
  </section>;
}

export function AgentWorkspace({ id, event, account, docked, open, close, run, ask, stop, askLocal, openSettings, openAccount, reviewProposal, openSource, openReviewedChange }) {
  const [input, setInput] = useState('');
  const transcript = useRef(null);
  const question = run?.question;

  useEffect(() => {
    if (transcript.current) transcript.current.scrollTop = 0;
  }, [question]);

  function submit(event) {
    event.preventDefault();
    if (run?.pending || !input.trim()) return;
    ask(input.trim());
    setInput('');
  }

  if (!docked && !open) return null;
  const content = <>
    <div className="agent-context"><FileText size={15} aria-hidden="true" /><span>{event.title}</span></div>
    <div ref={transcript} className="agent-transcript" role="region" aria-label="Agent 对话" tabIndex={account && run ? 0 : undefined}>
      {account ? <>
        {run ? <AgentResponse {...{ run, event, ask, stop, askLocal, openSettings, reviewProposal, openSource, openReviewedChange }} /> :
          <p className="muted">查询活动进展、查找资料，或准备一份议程调整草稿。</p>}
        {!run?.pending && <div className="agent-prompts">
          <button type="button" className="button small" onClick={() => ask('当前活动的筹备进展怎么样？')}>查看筹备进展</button>
          <button type="button" className="button small" onClick={() => ask('列出当前活动可以引用的导入资料及其版本。')}>查看可引用资料</button>
        </div>}
      </> : <>
        <p className="muted">登录后可询问议程、查询已授权的资料，或准备活动与变更草稿。</p>
        <button type="button" className="button small" onClick={openAccount}>登录后使用 Agent</button>
      </>}
    </div>
    {account && <form className="agent-compose" onSubmit={submit}>
      <textarea name="command" aria-label="对 Agent 说" placeholder="例如：创新工作坊几点开始？" maxLength={2000} rows={2} enterKeyHint="send"
        value={input} onChange={event => setInput(event.target.value)} onKeyDown={event => {
          if (event.key !== 'Enter' || event.shiftKey || event.nativeEvent.isComposing || event.keyCode === 229) return;
          event.preventDefault();
          event.currentTarget.form.requestSubmit();
        }} />
      <button type="submit" className="button primary icon-button" aria-label="提交给 Agent" disabled={run?.pending || !input.trim()}>
        <ArrowUp size={18} aria-hidden="true" />
      </button>
    </form>}
  </>;

  if (!docked) return <Dialog title="Agent 工作台" variant="drawer" className="agent-drawer" fullOnMobile close={close}>{content}</Dialog>;
  return <aside id={id} className="activity-agent" aria-label="Agent 工作台" tabIndex={-1} hidden={!open}>
    <header className="agent-workspace-header">
      <h2><Sparkles size={17} aria-hidden="true" />Agent 工作台</h2>
      <button type="button" className="icon-button" aria-label="收起 Agent" onClick={close}><PanelRightClose size={18} aria-hidden="true" /></button>
    </header>
    {content}
  </aside>;
}
