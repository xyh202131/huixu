import { useEffect, useState } from 'react';
import { CalendarDays, Check, MapPin } from 'lucide-react';
import { PublicEvent } from './Attendees';
import { Badge, Panel } from './components';
import { Notice } from './interactions';
import { dateLabel, initialEvents, timeRange } from './model';
import { attendeeConfirmation, pollRegistration, publicRegistration } from './registrationClient';
import { Select } from './Select';

function Unavailable({ children }) {
  return <main className="unavailable-link"><h1>活动链接不可用</h1><p className="muted">{children}</p></main>;
}

export function PublishedEvent({ publicId }) {
  const [event, setEvent] = useState(null);
  const [problem, setProblem] = useState('');
  useEffect(() => {
    if (!publicId) { setProblem('请向活动负责人索取活动链接。'); return; }
    if (publicId === 'forum') {
      setEvent(initialEvents()[0]);
      return;
    }
    const controller = new AbortController();
    let loaded = false;
    let pending = false;
    async function load() {
      if (pending || controller.signal.aborted) return;
      pending = true;
      try {
        const updated = await publicRegistration('/events/' + encodeURIComponent(publicId), 'GET', undefined, controller.signal);
        if (!controller.signal.aborted) { loaded = true; setEvent(updated); setProblem(''); }
      } catch (error) {
        if (!controller.signal.aborted && (!loaded || error.status === 404)) setProblem(error.message);
      } finally {
        pending = false;
      }
    }
    const stopPolling = pollRegistration(load, 5000);
    return () => { controller.abort(); stopPolling(); };
  }, [publicId]);

  if (problem) return <Unavailable>{problem}</Unavailable>;
  if (!event) return <main className="unavailable-link" role="status">正在读取活动…</main>;
  return <PublicEvent event={event} preview={publicId === 'forum'}
    submit={values => publicRegistration('/events/' + encodeURIComponent(publicId), 'POST', values)} />;
}

export function AttendancePage({ token }) {
  const [confirmation, setConfirmation] = useState(null);
  const [problem, setProblem] = useState('');
  const [status, setStatus] = useState('');
  const [pending, setPending] = useState(false);

  useEffect(() => {
    document.title = '出席确认 · 会序';
    const controller = new AbortController();
    attendeeConfirmation(token, 'GET', undefined, controller.signal).then(setConfirmation)
      .catch(error => { if (!controller.signal.aborted) setProblem(error.message); });
    return () => controller.abort();
  }, [token]);

  async function respond(action, sessionId) {
    if (pending) return;
    setPending(true);
    setStatus('');
    setProblem('');
    try {
      const result = await attendeeConfirmation(token, 'POST', { action, sessionId });
      setConfirmation(result);
      setStatus(action === 'change-session' ? '换场申请已提交。负责人处理后会更新你的报名记录。' : '已保存出席状态。');
    } catch (error) {
      setProblem(error.message);
    } finally {
      setPending(false);
    }
  }

  if (!confirmation) return problem ? <Unavailable>{problem}</Unavailable> : <main className="unavailable-link" role="status">正在读取出席确认…</main>;
  const { event, person, expires } = confirmation;
  const session = event.agenda.find(item => item.id === person.sessionId);
  const requested = event.agenda.find(item => item.id === person.requestedSessionId);
  const otherSessions = event.agenda.filter(item => item.id !== person.sessionId);
  return <main className="attendance-page">
    <header className="attendance-title">
      <span>会序 · 出席确认</span>
      <h1>{event.title}</h1>
      <p><CalendarDays size={17} aria-hidden="true" />{dateLabel(event.date)}<MapPin size={17} aria-hidden="true" />{event.venue || '场地待确认'}</p>
    </header>
    <Panel title={person.name + '的报名'} action={<Badge tone={person.attendance === '确认出席' ? 'success' : 'neutral'}>{person.attendance}</Badge>}>
      <div className="form-stack">
        <p className="muted">{person.status} · {person.id}</p>
        <p>{session ? session.title + ' · ' + timeRange(session) : '全场活动'}</p>
        {requested && <Notice>已申请换至「{requested.title}」，等待负责人处理。</Notice>}
        <div className="actions attendance-actions">
          <button className="button primary" disabled={pending || person.attendance === '确认出席'} onClick={() => respond('confirm')}>
            <Check size={18} aria-hidden="true" />确认出席
          </button>
          <button className="button" disabled={pending || person.attendance === '无法参加'} onClick={() => respond('decline')}>无法参加</button>
        </div>
        {status && <Notice tone="success" announce>{status}</Notice>}
        {problem && <Notice tone="error" announce>{problem}</Notice>}
        {otherSessions.length > 0 && <details className="import-review-detail">
          <summary>申请更换分场</summary>
          <form className="form-stack" onSubmit={event => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            void respond('change-session', form.get('sessionId'));
          }}>
            <Select label="希望参加的场次" name="sessionId" options={otherSessions.map(item => ({ value: item.id, label: item.title }))} />
            <button className="button" disabled={pending}>提交申请</button>
          </form>
        </details>}
        <small className="muted">专属链接有效至 {new Date(expires).toLocaleDateString('zh-CN')}。</small>
      </div>
    </Panel>
  </main>;
}
