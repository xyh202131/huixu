import { checkCandidate, isClock, roomLabel } from './scheduling.js';
import { planDate, planNumber, topicEventDetails } from './topicPlan.js';

const text = value => String(value ?? '').trim();
const roomKey = value => text(value).replace(/^([A-Za-z0-9]+)\s*厅$/, '$1');
const equipmentList = value => text(value).split(/[、,，;；\n]+/).map(text).filter(Boolean);

export function adoptionDiff(before, after, fields) {
  if (!before) return '新增';
  const differences = [];
  for (const [key, label] of Object.entries(fields)) {
    const previous = Array.isArray(before[key]) ? before[key].join('、') : before[key];
    const next = Array.isArray(after[key]) ? after[key].join('、') : after[key];
    if (previous !== next) differences.push(label + ' ' + (text(previous) || '待定') + ' → ' + (text(next) || '待定'));
  }
  return differences.length ? differences.join('，') : '沿用';
}

export function adoptExecutionPlan(event, plan) {
  const previous = event.executionPlan?.agenda ?? [];
  const agenda = (plan.agenda ?? []).filter(row => text(row.name)).map(row => {
    const saved = previous.find(item => item.sourceId === row.id);
    return {
      id: saved?.id ?? crypto.randomUUID(), sourceId: row.id, title: text(row.name), duration: text(row.duration),
      start: text(row.start), end: text(row.end), room: roomKey(row.room), date: text(row.date),
      guest: text(row.host), expected: text(row.expected), equipment: equipmentList(row.equipment),
    };
  });
  const rooms = (plan.venues ?? []).filter(row => text(row.name)).map(row => ({
    id: roomKey(row.name), capacity: planNumber(row.capacity, 100000), ready: '',
    equipment: equipmentList(row.equipment),
  }));
  const tasks = [...event.tasks];
  for (const row of plan.tasks ?? []) {
    if (!text(row.name)) continue;
    const index = tasks.findIndex(task => task.sourceId === row.id);
    const old = tasks[index];
    const source = { name: text(row.name), owner: text(row.owner) || '待分配',
      offset: /^\d{1,3}$/.test(text(row.offset)) && Number(row.offset) <= 365 ? Number(row.offset) : null };
    const task = old ? { ...old } : { id: crypto.randomUUID(), done: false };
    for (const [field, value] of Object.entries(source)) {
      if (!old || value !== old.adopted?.[field]) task[field] = value;
    }
    Object.assign(task, { sourceId: row.id, adopted: source });
    if (index < 0) tasks.push(task);
    else tasks[index] = task;
  }
  const details = topicEventDetails(plan.event);
  const next = { ...event, tasks };
  if (!event.version) {
    for (const key of ['title', 'date', 'capacity', 'budget', 'venue']) {
      const sourceField = { capacity: 'target' }[key] ?? key;
      if (text(plan.event[sourceField]) && details[key] !== undefined) next[key] = details[key];
    }
    next.executionPlan = { agenda, rooms };
  }
  return next;
}

export function assessExecutionPlan(event) {
  const staged = event.executionPlan ?? { agenda: [], rooms: [] };
  const rooms = new Map(event.rooms.map(room => [room.id, room]));
  for (const room of staged.rooms) rooms.set(room.id, room);
  const agenda = [...event.agenda, ...staged.agenda];
  const issues = [];
  if (!planDate(event.date)) issues.push('填写活动日期');
  if (!planNumber(event.capacity, 100000)) issues.push('填写活动预计人数（1–100000），用于确定报名总名额');
  if (!staged.agenda.length) issues.push('添加并采用至少一个环节');
  for (const room of staged.rooms) {
    if (!room.capacity) issues.push(roomLabel(room.id) + '需填写容量');
    if (staged.rooms.filter(item => item.id === room.id).length > 1) issues.push('会场名称重复：' + roomLabel(room.id));
  }
  const state = { ...event, rooms: [...rooms.values()], agenda };
  for (const row of agenda) {
    const errors = [];
    if (row.expected && !planNumber(row.expected, 100000)) errors.push('分场预计人数须为有效正整数');
    if (row.date && row.date !== event.date) errors.push('环节日期与本次单日排程不一致');
    if (!isClock(row.start) || !isClock(row.end) || row.start >= row.end) errors.push('补齐有效起止时间');
    if (!rooms.has(row.room)) errors.push('选择已登记容量的会场');
    if (!errors.length) errors.push(...checkCandidate(state, { before: row }, row, undefined, undefined, true));
    for (const error of errors) issues.push(row.title + ' · ' + error);
  }
  return { issues: [...new Set(issues)], agenda, rooms: state.rooms };
}
