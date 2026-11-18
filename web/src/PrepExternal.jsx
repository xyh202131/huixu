import { useState } from 'react';
import { Link2, UsersRound } from 'lucide-react';
import { Badge, Empty, IconTile, PageHead, Panel, Table } from './components';
import { Notice } from './interactions';
import { Select } from './Select';
import { externalRoles, money, roomLabel, timeRange, uid } from './model';
import { GuestRequests } from './GuestCollaboration';

const roleDescriptions = { guest: '确认时段并登记课件', vendor: '提交报价与交付说明', volunteer: '查看并认领岗位班次' };
const shifts = ['入场签到 08:30–09:30', '分场引导 13:00–15:00', '撤场交接 17:00–18:00'];

function replySummary(event, reply) {
  const session = event.agenda.find(item => item.id === reply.sessionId);
  if (!session) return reply.summary;
  const label = reply.role === 'volunteer' ? '分场引导 · ' : '';
  const availability = reply.availability ? ' · 可用 ' + timeRange(reply.availability) : '';
  const details = reply.details ? ' · ' + reply.details : '';
  return label + session.title + ' · ' + timeRange(session) + ' · ' + roomLabel(session.room) + availability + details;
}

export function External({ event, readOnly, registration }) {
  return <>
    <PageHead heading="h3" title="外部协作" description={readOnly ? '查看嘉宾、供应商与志愿者的协作事项。' : '邀请嘉宾确认安排、收取课件，并查看各角色的提交记录。'} />
    {!readOnly && <GuestRequests event={event} registration={registration} />}
    <div className="role-grid">{Object.entries(externalRoles).map(([role, label]) => <Panel key={role}>
      <div className="file-title"><IconTile icon={UsersRound} /><h2>{label}</h2></div>
      <p className="muted">{roleDescriptions[role]}</p>
      {!readOnly && <a className="button" href={'#/external/' + event.id + '/' + role}><Link2 size={17} />打开{label}演练表单</a>}
    </Panel>)}</div>
    <Panel title="提交记录">
      {event.replies.length ? <Table headers={['角色', '姓名或机构', '提交内容', '状态']}>{event.replies.map(reply => <tr key={reply.id}>
        <td>{externalRoles[reply.role]}</td><td>{reply.name}</td><td>{replySummary(event, reply)}</td><td><Badge tone="success">已提交</Badge></td>
      </tr>)}</Table> : <Empty>还没有外部回复。</Empty>}
    </Panel>
  </>;
}

export function ExternalForm({ event, role, update }) {
  const [message, setMessage] = useState(null);
  const label = externalRoles[role];
  const sessions = event.agenda.map(session => ({ value: session.id, label: session.title + ' · ' + timeRange(session) }));
  const volunteerShifts = [...shifts, ...sessions.map(({ value, label }) => ({ value: 'session:' + value, label: '分场引导 · ' + label }))];
  function submit(e) {
    e.preventDefault();
    const fields = new FormData(e.currentTarget);
    const name = fields.get('name').trim();
    if (!name) return;
    const file = fields.get('deck');
    const shift = fields.get('shift');
    const start = fields.get('availableFrom');
    const end = fields.get('availableUntil');
    if ((start || end) && (!start || !end || start >= end)) {
      setMessage({ tone: 'error', text: '请填写完整的可用时段，结束时间须晚于开始时间。' });
      return;
    }
    if (role === 'volunteer' && event.replies.some(reply => reply.shift === shift)) {
      setMessage({ tone: 'error', text: '该班次已被认领，请选择其他班次。' });
      return;
    }
    const quote = role === 'vendor' ? Number(fields.get('quote')) : 0;
    const sessionId = role === 'guest' ? fields.get('session') : shift?.startsWith('session:') ? shift.slice(8) : null;
    const details = role === 'guest' ? fields.get('available').trim() + (file?.name ? ' · ' + file.name : '') : '';
    const summary = role === 'vendor' ? money(quote) + ' · ' + fields.get('terms') : shift;
    const reply = { id: uid(), role, name, shift, sessionId, details, summary, availability: start && end ? { start, end } : undefined };
    update(current => ({
      ...current, replies: [...current.replies, reply],
      quotes: role === 'vendor' ? [...current.quotes, { id: reply.id, name: fields.get('terms').trim() || '外部报价', supplier: name, quote, actual: null }] : current.quotes,
    }));
    setMessage({ tone: 'success', text: '已提交，活动工作台可以查看。' });
    e.currentTarget.reset();
  }
  return <div className="external-page">
    <a className="link-button" href="#/external">返回外部协作</a>
    <PageHead title={event.title + ' · ' + label} description={roleDescriptions[role] + '。使用虚构资料演练。'} />
    <Panel title={label + '提交'}><form className="form-stack" onSubmit={submit}>
      <label>姓名或机构<input name="name" required maxLength="40" /></label>
      {role === 'guest' && <>
        <Select label="活动环节" name="session" options={sessions} />
        <label>可用时段或确认说明<input name="available" placeholder="例如：确认出席" required maxLength="80" /></label>
        <label>课件（记录文件名）<input name="deck" type="file" /></label>
      </>}
      {role === 'vendor' && <><label>报价（元）<input name="quote" type="number" min="0" max="10000000" required /></label>
        <label>交付范围与说明<textarea name="terms" maxLength="200" required /></label></>}
      {role === 'volunteer' && <Select label="班次" name="shift" options={volunteerShifts} />}
      {role !== 'vendor' && <div className="form-grid">
        <label>可用开始时间（选填）<input type="time" name="availableFrom" /></label>
        <label>可用结束时间（选填）<input type="time" name="availableUntil" /></label>
      </div>}
      <button className="button primary">提交{label}资料</button>{message && <Notice tone={message.tone} announce>{message.text}</Notice>}
    </form></Panel>
  </div>;
}
