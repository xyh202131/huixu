import { activityTypes, newEvent, uid } from './model.js';
import { isClock, minutes } from './scheduling.js';

const templates = {
  企业培训: [['目标与入门', 10], ['主题讲解', 25], ['分组实操', 35], ['复盘与行动', 20]],
  行业论坛: [['开场与议题介绍', 10], ['主题分享', 30], ['圆桌交流', 35], ['提问与总结', 15]],
  展览: [['开场导览', 15], ['主题作品展示', 40], ['现场交流', 25], ['回顾与离场', 10]],
  市集: [['入场与摊位导览', 15], ['主题摊位体验', 45], ['互动交流', 20], ['收尾与撤场', 10]],
  校园活动: [['签到与破冰', 10], ['主题分享', 25], ['互动实践', 35], ['答疑与总结', 20]],
};

export function topicActivityType(topic) {
  if (/校园|学生|社团|大学|高校/.test(topic)) return '校园活动';
  if (/市集|摊位/.test(topic)) return '市集';
  if (/展览|展览会|作品展|展会/.test(topic)) return '展览';
  if (/培训|训练营|内训/.test(topic)) return '企业培训';
  return '行业论坛';
}

export function planNumber(value, maximum) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 && number <= maximum ? number : 0;
}

export function planDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return '';
  const date = new Date(value + 'T00:00:00Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : '';
}

export function topicEventDetails(event) {
  const budget = Number(event.budget);
  return {
    title: event.title?.trim(), date: planDate(event.date), capacity: planNumber(event.target, 100000),
    venue: event.venue?.trim() || '场地待确认',
    budget: Number.isFinite(budget) && budget >= 0 ? budget : 0,
  };
}

export function referencePlan(event) {
  if (!event) return null;
  const source = event.organizedPlan;
  const agenda = event.version || !source ? event.agenda.toSorted((a, b) => a.start.localeCompare(b.start)) : source.agenda;
  const slots = agenda.map(row => {
    if (isClock(row.start) && isClock(row.end)) return planNumber(minutes(row.end) - minutes(row.start), 480);
    return planNumber(row.duration, 480);
  }).filter(Boolean);
  const tasks = (event.version ? event.tasks : source?.tasks ?? event.tasks).map(task => ({
    name: task.name, offset: task.offset ?? '',
  })).filter(task => task.name?.trim()).slice(0, 12);
  const roles = event.version ? [] : (source?.roles ?? []).filter(row => row.name?.trim())
    .map(({ name, duty }) => ({ name, duty })).slice(0, 8);
  const supplies = event.version
    ? [...new Set(event.rooms.flatMap(room => room.equipment))].map(name => ({ name })).slice(0, 8)
    : (source?.supplies ?? []).filter(row => row.name?.trim()).map(({ name }) => ({ name })).slice(0, 8);
  const lessons = (event.teamLessons ?? []).slice(-8).map(({ condition, advice, version }) => ({ condition, advice, version }));
  return { title: event.title, version: event.version, slots: slots.slice(0, 8), tasks, roles, supplies, lessons };
}

function templatePlan(topic, type, slots) {
  const format = templates[type];
  const duration = format.map(([, minutes], index) => slots[index] ?? minutes);
  duration.push(...slots.slice(format.length));
  return {
    goal: '围绕「' + topic + '」安排介绍、体验与交流，收集反馈并明确后续行动。',
    agenda: duration.map((minutes, index) => ({
      name: index === 1 ? topic + ' · ' + format[1][0] : format[Math.min(format.length - 1, Math.floor(index * format.length / duration.length))][0],
      duration: minutes,
    })),
    roles: [
      { name: '活动统筹', duty: '确认方案、资源与现场决策' },
      { name: '内容负责人', duty: '准备「' + topic + '」的议程内容与材料' },
      { name: '现场执行', duty: '签到、设备检查及环节衔接' },
    ],
    supplies: [{ name: '签到与指引材料' }, { name: '展示与演示设备' }, { name: '反馈收集材料' }],
    tasks: [{ name: '确认活动时间、场地和人数', offset: '14' }, { name: '确认「' + topic + '」的环节方案和岗位', offset: '7' },
      { name: '核对物料并组织彩排', offset: '1' }, { name: '收集反馈并复盘', offset: '0' }],
    budgetItems: [{ name: '场地与设备' }, { name: '物料与布置' }, { name: '现场支持' }],
  };
}

export function createTopicEvent(input, reference, suggestions) {
  const type = activityTypes.includes(input.type) ? input.type : topicActivityType(input.topic);
  const capacity = planNumber(input.target, 100000);
  const date = planDate(input.date);
  const slots = reference?.slots ?? [];
  const template = templatePlan(input.topic, type, slots);
  const rows = list => list.map(row => ({ ...row, id: uid() }));
  const agenda = suggestions?.agenda ?? template.agenda;
  const tasks = reference?.tasks ?? [];
  const suggestedTasks = suggestions?.tasks ?? template.tasks;
  const reusedRoles = reference?.roles ?? [];
  const reusedSupplies = reference?.supplies ?? [];
  const merge = (reused, proposed) => rows([...reused, ...proposed.filter(row => !reused.some(item => item.name === row.name))]);
  const plan = {
    id: uid(), topicPlan: true, model: Boolean(suggestions),
    event: {
      title: input.topic, date, venue: input.venue, target: capacity ? String(capacity) : '', budget: input.budget, audience: input.audience,
      goal: suggestions?.goal || template.goal,
    },
    agenda: rows(agenda.map((item, index) => ({ name: item.name, duration: String(slots[index] ?? item.duration) }))),
    roster: rows(input.people.map(name => ({ name }))), venues: [], budgetItems: rows(suggestions?.budgetItems ?? template.budgetItems),
    roles: merge(reusedRoles, suggestions?.roles ?? template.roles),
    supplies: merge(reusedSupplies, suggestions?.supplies ?? template.supplies),
    tasks: merge(tasks, suggestedTasks),
    reference: reference && { title: reference.title, version: reference.version, durations: Math.min(slots.length, agenda.length),
      tasks: tasks.length, roles: reusedRoles.length, supplies: reusedSupplies.length, lessons: reference.lessons ?? [] },
  };
  return {
    ...newEvent({ title: input.topic, type, date, capacity }),
    ...topicEventDetails(plan.event), agenda: [], rooms: [], tasks: [], formOpen: false, organizedPlan: plan,
  };
}
