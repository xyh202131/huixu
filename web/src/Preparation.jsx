import { useEffect, useState } from 'react';
import { Pencil, Plus } from 'lucide-react';
import { Badge, Empty, PageHead, Panel, Table, Tabs } from './components';
import { CheckControl, Dialog, MetricValue, Notice } from './interactions';
import { Select } from './Select';
import { roomKey } from './executionPlan';
import { money, roomLabel, uid } from './model';
import { preparationRooms, saveDraftRoom, taskDueDate } from './prepRules';
import { signupSnapshot } from './registrationRules';
import { planDate } from './topicPlan';

const tabs = ['筹备任务', '设备与物料', '预算与报价'];
const names = { task: '筹备任务', room: '会场', supply: '物料', quote: '报价' };
const maximumAmount = 1000000000;

function editEntry(rows, original, fields, newId) {
  if (!original) return [...rows, { id: newId, ...fields }];
  return rows.map(row => row === original || (original.id != null && row.id === original.id)
    ? { ...row, id: row.id ?? newId, ...fields } : row);
}

function actualAmount(quote) {
  if (quote.actual === 0 && !quote.id) return null;
  return quote.actual ?? null;
}

function deadlineLabel(task, eventDate) {
  const deadline = taskDueDate(task, eventDate);
  if (deadline) return deadline;
  if (task.offset != null && task.offset !== '') return '活动前 ' + task.offset + ' 天';
  return '截止待定';
}

function statusEdit(task, done, linkedUpload) {
  return { ...task, done, reopenedAfterUpload: !done && linkedUpload ? true : undefined };
}

function EditLabel({ name, edit }) {
  if (!edit) return name;
  return <button type="button" className="link-button prep-row-edit" aria-label={'编辑' + name} aria-haspopup="dialog" onClick={edit}>
    <span>{name}</span><Pencil size={14} aria-hidden="true" />
  </button>;
}

export function Preparation({ event, readOnly, update, notify, focusTaskId, registration, openAccount }) {
  const [tab, setTab] = useState(tabs[0]);
  const [editing, setEditing] = useState(null);
  useEffect(() => { if (focusTaskId) setTab(tabs[0]); }, [focusTaskId]);
  const completed = event.tasks.filter(task => task.done).length;
  const rooms = preparationRooms(event);
  const supplies = event.supplies ?? event.organizedPlan?.supplies ?? [];
  const hasUpload = task => (registration.current?.guestRequests ?? []).some(reply => reply.filename && reply.taskId === String(task.id));

  function openEditor(kind, record) {
    setEditing({ kind, record, revision: registration.current?.revision });
  }

  async function save(fields) {
    const { kind, record } = editing;
    if (kind === 'room') {
      if (rooms.some(room => room.id === fields.id && room.id !== record?.id)) throw new Error('这个会场名称已存在。');
      if (event.version) {
        const current = registration.current;
        if (!current) throw new Error(registration.problem || '正在读取发布版，请稍后重试。');
        if (editing.revision !== current.revision) throw new Error('活动或报名已更新，请关闭编辑后重新核对。');
        const saved = record && current.event.rooms.find(room => room.id === record.id);
        if (record && !saved) throw new Error('该会场已移出发布版，请关闭后重新核对。');
        if (saved && saved.id === fields.id && saved.capacity === fields.capacity && saved.ready === fields.ready &&
            JSON.stringify(saved.equipment) === JSON.stringify(fields.equipment)) return;
        const nextRooms = record ? current.event.rooms.map(room => room.id === record.id ? fields : room) : [...current.event.rooms, fields];
        const snapshot = signupSnapshot({ ...current.event, rooms: nextRooms, version: current.event.version + 1 });
        const result = await registration.change('/schedule', 'PATCH', { revision: current.revision, event: snapshot });
        update(latest => {
          if (latest.version > result.event.version) return latest;
          const agenda = result.event.agenda.map(session => ({ ...latest.agenda.find(item => item.id === session.id), ...session }));
          return { ...latest, ...result.event, agenda };
        });
        notify('会场已更新至发布版 v' + result.event.version);
        return;
      }
      update(current => saveDraftRoom(current, record?.id, fields));
    } else if (kind === 'task') {
      const id = record?.id ?? uid();
      const changedStatus = record && record.done !== fields.done;
      const linkedUpload = changedStatus && hasUpload(record);
      update(current => {
        if (!record) return { ...current, tasks: [...current.tasks, { id, ...fields }] };
        return { ...current, tasks: current.tasks.map(task => {
          if (task.id !== id) return task;
          const amended = { ...task, name: fields.name, owner: fields.owner, offset: fields.offset, dueDate: fields.dueDate };
          return changedStatus ? statusEdit(amended, fields.done, linkedUpload) : amended;
        }) };
      });
    } else if (kind === 'supply') {
      const id = record?.id ?? uid();
      update(current => {
        if (!current.supplies && Array.isArray(current.organizedPlan?.supplies)) {
          return { ...current, organizedPlan: { ...current.organizedPlan, supplies: editEntry(current.organizedPlan.supplies, record, fields, id) } };
        }
        return { ...current, supplies: editEntry(current.supplies ?? [], record, fields, id) };
      });
    } else if (kind === 'quote') {
      const id = record?.id ?? uid();
      update(current => ({ ...current, quotes: editEntry(current.quotes, record, fields, id) }));
    } else {
      const budget = fields.budget;
      update(current => {
        const plan = current.organizedPlan;
        if (!plan) return { ...current, budget };
        return { ...current, budget, organizedPlan: { ...plan, event: { ...plan.event, budget: budget ? String(budget) : '' } } };
      });
    }
    notify((names[kind] ?? '活动预算') + '已保存');
  }

  function addButton(kind, label, primary = false) {
    if (readOnly) return null;
    return <button type="button" className={'button' + (primary ? ' primary' : '')} aria-haspopup="dialog" onClick={() => openEditor(kind)}>
      <Plus size={17} aria-hidden="true" />{label}
    </button>;
  }

  return <>
    <PageHead heading="h2" title="筹备与协作" description="管理任务、场地、设备、物料和预算。">
      {readOnly && <button type="button" className="button" aria-haspopup="dialog" onClick={openAccount}>登录后编辑</button>}
      {tab === tabs[0] && addButton('task', '新建任务', true)}
    </PageHead>
    <Tabs label="筹备视图" items={tabs} value={tab} onChange={setTab} />
    {tab === tabs[0] && <Panel title="筹备任务" action={<Badge tone="success"><MetricValue value={completed} compact />&nbsp;/ {event.tasks.length} 已完成</Badge>}>
      {event.tasks.length ? <Table headers={['任务', '负责人', '截止时间', '状态']} label="筹备任务列表" pinRowHeader>
        {event.tasks.map(task => <tr key={task.id} id={'activity-task-' + task.id}>
          <th scope="row"><EditLabel name={task.name} edit={!readOnly && (() => openEditor('task', task))} /></th>
          <td>{task.owner || '待分配'}</td><td className="tabular">{deadlineLabel(task, event.date)}</td>
          <td>{readOnly ? <Badge tone={task.done ? 'success' : 'neutral'}>{task.done ? '已完成' : '待处理'}</Badge> :
            <CheckControl label={task.name + '完成状态'} description={task.done ? '已完成' : '标记完成'} checked={task.done} onChange={done => {
              const linkedUpload = hasUpload(task);
              update(current => ({ ...current, tasks: current.tasks.map(item => item.id === task.id ? statusEdit(item, done, linkedUpload) : item) }));
            }} />}</td>
        </tr>)}
      </Table> : <Empty>还没有筹备任务。</Empty>}
    </Panel>}
    {tab === tabs[1] && <>
      <Panel title="场地与设备" action={addButton('room', '新增会场')}>
        {rooms.length ? <Table headers={['场地', '可用名额', '设备', '最早可用']} label="场地与设备列表" pinRowHeader>
          {rooms.map(room => <tr key={room.id}>
            <th scope="row"><EditLabel name={roomLabel(room.id)} edit={!readOnly && (() => openEditor('room', room))} /></th>
            <td>{room.capacity ? room.capacity + ' 人' : '待确认'}</td><td>{room.equipment.join('、') || '—'}</td><td>{room.ready || '待确认'}</td>
          </tr>)}
        </Table> : <Empty>还没有登记会场。</Empty>}
      </Panel>
      <Panel title="物料清单" action={addButton('supply', '新增物料')}>
        {supplies.length ? <Table headers={['物料', '数量']} label="物料列表" pinRowHeader>{supplies.map((item, index) => <tr key={item.id ?? index}>
          <th scope="row"><EditLabel name={item.name} edit={!readOnly && (() => openEditor('supply', item))} /></th>
          <td>{item.quantity || '待确认'}</td>
        </tr>)}</Table> : <Empty>还没有登记物料。</Empty>}
      </Panel>
    </>}
    {tab === tabs[2] && <Panel title="预算与报价" action={<div className="actions compact">
      <Badge tone="success">预算 {event.budget ? money(event.budget) : '待确认'}</Badge>
      {!readOnly && <button type="button" className="button small" aria-haspopup="dialog" onClick={() => openEditor('budget')}>编辑总预算</button>}
      {addButton('quote', '新增报价')}
    </div>}>
      {event.quotes.length ? <Table headers={['预算项', '供应商', '报价', '实际支出']} label="预算与报价列表" pinRowHeader>
        {event.quotes.map((quote, index) => <tr key={quote.id ?? index}>
          <th scope="row"><EditLabel name={quote.name} edit={!readOnly && (() => openEditor('quote', quote))} /></th>
          <td>{quote.supplier || '待确认'}</td><td>{money(quote.quote)}</td><td>{actualAmount(quote) == null ? '待记录' : money(quote.actual)}</td>
        </tr>)}
      </Table> : <Empty>还没有登记报价。</Empty>}
    </Panel>}
    {!readOnly && editing && <PreparationEditor editing={editing} event={event} save={save} close={() => setEditing(null)} />}
  </>;
}

function PreparationEditor({ editing, event, save, close }) {
  const { kind, record } = editing;
  const [fixedDeadline, setFixedDeadline] = useState(Boolean(record?.dueDate));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const roomPublished = kind === 'room' && event.version > 0;
  const roomUsed = roomPublished && record && event.agenda.some(item => item.room === record.id);
  const title = kind === 'budget' ? '编辑总预算' : (record ? '编辑' : '新增') + names[kind];

  async function submit(e) {
    e.preventDefault();
    if (busy) return;
    setError('');
    setBusy(true);
    const form = new FormData(e.currentTarget);
    const text = name => String(form.get(name) ?? '').trim();
    try {
      const name = text('name');
      if (kind !== 'budget' && !name) throw new Error('请填写名称。');
      let fields;
      if (kind === 'task') {
        const dueDate = text('dueDate');
        if (dueDate && !planDate(dueDate)) throw new Error('请输入有效的截止日期。');
        fields = { name, owner: text('owner') || '待分配', dueDate: dueDate || undefined,
          offset: text('offset') === '' ? null : Number(text('offset')), done: form.has('done') };
      } else if (kind === 'room') {
        const equipment = [...new Set(text('equipment').split(/[、,，;；\n]+/).map(value => value.trim()).filter(Boolean))];
        if (equipment.length > 30 || equipment.some(value => value.length > 80)) throw new Error('最多填写 30 项设备，每项不超过 80 个字。');
        fields = { id: roomUsed ? record.id : roomKey(name), capacity: Number(text('capacity')), equipment, ready: text('ready') };
      } else if (kind === 'supply') {
        fields = { name, quantity: text('quantity') };
      } else if (kind === 'quote') {
        fields = { name, supplier: text('supplier'), quote: Number(text('quote')), actual: text('actual') === '' ? null : Number(text('actual')) };
      } else {
        fields = { budget: Number(text('budget')) };
      }
      await save(fields);
      close();
    } catch (problem) {
      setError(problem.message);
    } finally {
      setBusy(false);
    }
  }

  return <Dialog title={title} variant="drawer" close={() => { if (!busy) close(); }}>
    <form className="form-stack" onSubmit={submit} aria-busy={busy}>
      {kind === 'task' && <>
        <label>任务名称<input name="name" required maxLength={160} defaultValue={record?.name} /></label>
        <label>负责人<input name="owner" maxLength={80} defaultValue={record?.owner === '待分配' ? '' : record?.owner} placeholder="待分配" /></label>
        <Select label="截止方式" value={fixedDeadline ? '固定日期' : '按活动倒排'} options={['按活动倒排', '固定日期']}
          onChange={value => setFixedDeadline(value === '固定日期')} />
        {fixedDeadline ? <label>截止日期<input name="dueDate" type="date" required defaultValue={record && taskDueDate(record, event.date)} /></label>
          : <label>活动前多少天截止<input name="offset" type="number" min={0} max={365} defaultValue={record ? record.offset ?? '' : 7} placeholder="留空为待定" /></label>}
        <div><label className="import-access"><input name="done" type="checkbox" defaultChecked={record?.done} />已完成</label></div>
      </>}
      {kind === 'room' && <>
        <label>会场名称<input name="name" required maxLength={100} defaultValue={record ? roomLabel(record.id) : ''} readOnly={Boolean(roomUsed)} /></label>
        {roomUsed && <p className="muted">这个会场已关联发布议程。如需改会场名称，可以新增会场，再从议程发起变更。</p>}
        <div className="form-grid">
          <label>可用名额（人）<input name="capacity" type="number" required={roomPublished} min={roomPublished ? 1 : 0} max={100000}
            defaultValue={record?.capacity || ''} placeholder="待确认" /></label>
          <label>最早可用时间<input name="ready" type="time" required={roomPublished} defaultValue={record?.ready} /></label>
        </div>
        <label>设备清单<textarea name="equipment" maxLength={2450} defaultValue={record?.equipment.join('\n')} placeholder="每行一项，例如投影、无线麦克风" /></label>
        {roomPublished && <Notice>保存前会校验该会场的既有场次、报名人数和设备要求，通过后更新发布版本。</Notice>}
      </>}
      {kind === 'supply' && <>
        <label>物料名称<input name="name" required maxLength={160} defaultValue={record?.name} /></label>
        <label>数量<input name="quantity" maxLength={80} defaultValue={record?.quantity} placeholder="例如 120 份" /></label>
      </>}
      {kind === 'quote' && <>
        <label>预算项<input name="name" required maxLength={200} defaultValue={record?.name} /></label>
        <label>供应商<input name="supplier" maxLength={80} defaultValue={record?.supplier} placeholder="待确认" /></label>
        <div className="form-grid">
          <label>报价（元）<input name="quote" type="number" required min={0} max={maximumAmount} step="0.01" defaultValue={record?.quote} /></label>
          <label>实际支出（元）<input name="actual" type="number" min={0} max={maximumAmount} step="0.01" defaultValue={record ? actualAmount(record) ?? '' : ''} placeholder="留空为待记录" /></label>
        </div>
      </>}
      {kind === 'budget' && <label>活动总预算（元）<input name="budget" type="number" min={0} max={maximumAmount} step="0.01"
        defaultValue={event.budget || ''} placeholder="留空为待确认" /></label>}
      {error && <Notice tone="error" announce>{error}</Notice>}
      <div className="actions">
        <button type="button" className="button" onClick={close} disabled={busy}>取消</button>
        <button type="submit" className="button primary" disabled={busy}>{busy ? '正在保存…' : roomPublished ? '保存并更新发布版' : '保存'}</button>
      </div>
    </form>
  </Dialog>;
}
