import { useState } from 'react';
import { Link2, Package, Plus, UsersRound } from 'lucide-react';
import { Badge, Empty, IconTile, PageHead, Panel, Table, Tabs } from './components';
import { CheckControl, Dialog, MetricValue, Notice } from './interactions';
import { Select } from './Select';
import { externalRoles, money, roomLabel, timeRange, uid } from './model';

function taskDeadline(date, offset) {
  if (!date) return '活动前 ' + offset + ' 天';
  const deadline = new Date(date + 'T12:00:00Z');
  deadline.setUTCDate(deadline.getUTCDate() - offset);
  return deadline.toISOString().slice(0, 10);
}

export function Preparation({ event, readOnly, update, notify }) {
  const [tab, setTab] = useState('筹备任务');
  const [editing, setEditing] = useState(false);
  const completed = event.tasks.filter(task => task.done).length;
  return <>
    <PageHead heading="h2" title="筹备与协作" description="倒排任务、跟进负责人，并查看场地、设备和预算。">
      {!readOnly && tab === '筹备任务' && <button className="button primary" aria-haspopup="dialog" onClick={() => setEditing(true)}><Plus size={18} />新建任务</button>}
    </PageHead>
    <Tabs label="筹备视图" items={['筹备任务', '设备与物料', '预算与报价']} value={tab} onChange={setTab} />
    {tab === '筹备任务' && <Panel title="筹备任务" action={<Badge tone="success"><MetricValue value={completed} compact />&nbsp;/ {event.tasks.length} 已完成</Badge>}>
      <Table headers={['任务', '负责人', '截止时间', '状态']}>{event.tasks.map(task => <tr key={task.id}>
        <td>{task.name}</td><td>{task.owner}</td><td>{taskDeadline(event.date, task.offset)}</td>
        <td>{readOnly ? <Badge tone={task.done ? 'success' : 'neutral'}>{task.done ? '已完成' : '待处理'}</Badge> : <CheckControl label={task.name + '完成状态'} description={task.done ? '已完成' : '标记完成'} checked={task.done} onChange={done =>
          update(current => ({ ...current, tasks: current.tasks.map(item => item.id === task.id ? { ...item, done } : item) }))
        } />}</td>
      </tr>)}</Table>
    </Panel>}
    {tab === '设备与物料' && <Panel title="场地与设备">
      <Table headers={['场地', '可用名额', '设备与物料', '最早可用']}>{event.rooms.map(room => <tr key={room.id}>
        <td>{roomLabel(room.id)}</td><td>{room.capacity} 人</td><td><span className="inline-icon"><Package size={17} />{room.equipment.join('、')}</span></td><td>{room.ready}</td>
      </tr>)}</Table>
    </Panel>}
    {tab === '预算与报价' && <Panel title="预算与报价" action={<Badge tone="success">预算 {event.budget ? money(event.budget) : '待确认'}</Badge>}>
      {event.quotes.length ? <Table headers={['预算项', '供应商', '报价', '实际支出']}>{event.quotes.map(quote => <tr key={quote.name + quote.supplier}>
        <td>{quote.name}</td><td>{quote.supplier}</td><td>{money(quote.quote)}</td><td>{quote.actual ? money(quote.actual) : '待记录'}</td>
      </tr>)}</Table> : <Empty>供应商的演练报价将在这里显示。</Empty>}
    </Panel>}
    {editing && <Dialog title="新建筹备任务" variant="drawer" close={() => setEditing(false)}><form className="form-stack" onSubmit={e => {
      e.preventDefault();
      const fields = new FormData(e.currentTarget);
      const task = { id: uid(), name: fields.get('name').trim(), owner: fields.get('owner').trim() || '待分配', offset: Number(fields.get('offset')), done: false };
      if (!task.name) return;
      update(current => ({ ...current, tasks: [...current.tasks, task] }));
      setEditing(false);
      notify('筹备任务已添加');
    }}>
      <label>任务名称<input name="name" required maxLength="60" /></label><label>负责人<input name="owner" maxLength="30" /></label>
      <label>活动前多少天截止<input name="offset" type="number" min="0" max="365" defaultValue="7" required /></label>
      <button className="button primary">保存任务</button>
    </form></Dialog>}
  </>;
}

const roleDescriptions = { guest: '确认时段并登记课件', vendor: '提交报价与交付说明', volunteer: '查看并认领岗位班次' };
const shifts = ['入场签到 08:30–09:30', '分场引导 13:00–15:00', '撤场交接 17:00–18:00'];

export function External({ event, readOnly }) {
  return <>
    <PageHead heading="h3" title="外部协作" description={readOnly ? '查看嘉宾、供应商与志愿者的协作事项。' : '查看嘉宾、供应商与志愿者的提交，打开本机表单演练。'} />
    <div className="role-grid">{Object.entries(externalRoles).map(([role, label]) => <Panel key={role}>
      <div className="file-title"><IconTile icon={UsersRound} /><h2>{label}</h2></div>
      <p className="muted">{roleDescriptions[role]}</p>
      {!readOnly && <a className="button" href={'#/external/' + event.id + '/' + role}><Link2 size={17} />打开{label}表单</a>}
    </Panel>)}</div>
    <Panel title="提交记录">
      {event.replies.length ? <Table headers={['角色', '姓名或机构', '提交内容', '状态']}>{event.replies.map(reply => <tr key={reply.id}>
        <td>{externalRoles[reply.role]}</td><td>{reply.name}</td><td>{reply.summary}</td><td><Badge tone="success">已提交</Badge></td>
      </tr>)}</Table> : <Empty>还没有外部回复。</Empty>}
    </Panel>
  </>;
}

export function ExternalForm({ event, role, update }) {
  const [message, setMessage] = useState(null);
  const label = externalRoles[role];
  function submit(e) {
    e.preventDefault();
    const fields = new FormData(e.currentTarget);
    const name = fields.get('name').trim();
    if (!name) return;
    const file = fields.get('deck');
    const shift = fields.get('shift');
    if (role === 'volunteer' && event.replies.some(reply => reply.shift === shift)) {
      setMessage({ tone: 'error', text: '该班次已被认领，请选择其他班次。' });
      return;
    }
    const quote = role === 'vendor' ? Number(fields.get('quote')) : 0;
    const summary = role === 'guest' ? fields.get('session') + ' · ' + fields.get('available') + (file?.name ? ' · ' + file.name : '')
      : role === 'vendor' ? money(quote) + ' · ' + fields.get('terms') : shift;
    const reply = { id: uid(), role, name, summary, shift };
    update(current => ({
      ...current, replies: [...current.replies, reply],
      quotes: role === 'vendor' ? [...current.quotes, { name: fields.get('terms').trim() || '外部报价', supplier: name, quote, actual: 0 }] : current.quotes,
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
        <Select label="活动环节" name="session" options={event.agenda.map(session => session.title + ' · ' + timeRange(session))} />
        <label>可用时段或确认说明<input name="available" placeholder="例如：确认出席" required maxLength="80" /></label>
        <label>课件（记录文件名）<input name="deck" type="file" /></label>
      </>}
      {role === 'vendor' && <><label>报价（元）<input name="quote" type="number" min="0" max="10000000" required /></label>
        <label>交付范围与说明<textarea name="terms" maxLength="200" required /></label></>}
      {role === 'volunteer' && <Select label="班次" name="shift" options={shifts} />}
      <button className="button primary">提交{label}资料</button>{message && <Notice tone={message.tone} announce>{message.text}</Notice>}
    </form></Panel>
  </div>;
}
