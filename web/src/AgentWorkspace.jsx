import { useEffect, useRef, useState } from 'react';
import { ArrowUp, FileText, PanelRightClose, Sparkles } from 'lucide-react';
import { Dialog, Notice } from './interactions';

function AgentResponse({ run, ask, stop, askLocal, openSettings, reviewProposal, openSource }) {
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
    {run.citations?.length > 0 && <div className="memory-results">
      <p className="agent-evidence">检索到的原文</p>
      {run.citations.map(item => <button key={item.chunkId} type="button" className="memory-hit" onClick={() => openSource(item.chunkId)}>
        <strong>{item.name} · v{item.revision}</strong><span>{item.location}</span>
      </button>)}
    </div>}
    {run.model && <p className="agent-evidence">模型 · {run.model}</p>}
    {run.proposal && <button type="button" className="button primary" onClick={reviewProposal}>
      {run.proposal.kind === 'event' ? '打开活动草稿' : '打开变更单核对'}
    </button>}
  </>;
}

export function AgentWorkspace({ id, event, account, docked, open, close, run, ask, stop, askLocal, openSettings, openAccount, reviewProposal, openSource }) {
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
        {run ? <AgentResponse {...{ run, ask, stop, askLocal, openSettings, reviewProposal, openSource }} /> :
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
