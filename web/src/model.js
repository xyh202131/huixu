import { changeReviewKey, describeChangeImpact, sessionPosts } from './changeImpact.js';
import { analyzeMove, checkCandidate, checkinPoint, clock, minutes, moveCandidate, roomLabel, sameCandidate, sessionPeople, timeRange } from './scheduling.js';

export { checkCandidate, clock, minutes, moveCandidate, roomLabel, timeRange } from './scheduling.js';

export const activityTypes = ['企业培训', '行业论坛', '展览', '市集', '校园活动'];
export const channels = ['邮件', '日历邀请', '站内公告', '飞书', '企微', '短信'];
export const materialKinds = ['观众议程', '嘉宾行程', '主持稿', '工作人员台本', '岗位清单'];
export const externalRoles = { guest: '嘉宾', vendor: '供应商', volunteer: '志愿者' };
export const incidentKinds = { closure: '场地关闭', late: '嘉宾迟到', overrun: '环节超时' };

const templates = {
  企业培训: ['开班说明', '专题课程', '分组实操', '课程总结'],
  行业论坛: ['开幕致辞', '主旨演讲', '城市共创圆桌', '创新工作坊'],
  展览: ['布展与检查', '展区开放', '展商导览', '闭馆与撤展'],
  市集: ['摊主分批进场', '市集开放', '互动体验', '摊位撤场'],
  校园活动: ['场地核验与领岗', '开场活动', '社团分场展示', '交接与撤场'],
};
const taskNames = ['确定活动方案', '预订主会场', '确定预算', '发送嘉宾邀约', '发布报名页', '核对设备清单', '确认供应商报价', '安排签到岗位', '收齐嘉宾课件', '确认志愿者班次', '完成现场彩排', '布置会场'];

export function uid() {
  return crypto.randomUUID();
}

function makeAgenda(type) {
  const times = [['09:00', '09:20'], ['09:30', '10:30'], ['13:00', '13:45'], ['14:00', '14:40']];
  return templates[type].map((title, index) => ({
    id: 'session-' + (index + 1), title, start: times[index][0], end: times[index][1], room: 'A',
    guest: ['林澄', '周越', '许宁', '沈禾'][index], equipment: index === 3 ? ['投影', '无线麦克风'] : [],
  }));
}

export function newEvent({ title, type, date, capacity }, id = uid()) {
  return {
    id, title, type, date, capacity, version: 0, venue: '场地待确认', agenda: makeAgenda(type),
    rooms: [
      { id: 'A', capacity: capacity, ready: '08:00', equipment: ['投影', '无线麦克风'] },
      { id: 'B', capacity: 60, ready: '08:00', equipment: ['投影'] },
      { id: 'C', capacity: 90, ready: '08:00', equipment: ['投影', '无线麦克风'] },
    ],
    tasks: taskNames.map((name, index) => ({ id: index + 1, name, owner: '待分配', offset: Math.min(21, 23 - index * 2), done: false })),
    files: [], issues: [], attendees: [], replies: [], actual: {}, checkins: [], history: [], messages: [],
    change: null, budget: 0, quotes: [], formOpen: true, onsite: false, isSample: false,
  };
}

export function initialEvents() {
  const forum = newEvent({ title: '2026 城市创新论坛', type: '行业论坛', date: '2026-11-28', capacity: 150 }, 'forum');
  forum.isSample = true;
  forum.version = 1;
  forum.venue = '虹桥会议中心';
  forum.rooms[2].ready = '14:20';
  forum.tasks = forum.tasks.map((task, index) => ({ ...task, done: index < 8, owner: ['林澄', '唐悦', '顾言'][index % 3] }));
  forum.issues = [
    { id: 'roundtable', title: '圆桌时间存在冲突', field: '城市共创圆桌 · 开始时间', sessionId: 'session-3',
      choices: [{ file: '城市创新论坛活动方案.pdf', location: '第 2 页 · 下午议程', value: '13:00', quote: '13:00–13:45  城市共创圆桌 · A 厅' },
        { file: '论坛发布海报.png', location: '海报中部 · 流程说明', value: '13:30', quote: '13:30  城市共创圆桌 · A 厅' }] },
    { id: 'budget', title: '预算上限待确认', field: '活动总预算', choices: [
      { file: '活动方案.pdf', location: '第 4 页 · 预算草案', value: '65000', quote: '建议预算上限为 ¥65,000，待负责人确认。' },
      { file: '供应商报价汇总.xlsx', location: '汇总 · 第 12 行', value: '70000', quote: '筹备预算暂按 ¥70,000 估算。' }] },
  ];
  forum.files = ['城市创新论坛活动方案.pdf', '观众名单.xlsx', '场地与设备.xlsx', '供应商报价汇总.xlsx', '论坛发布海报.png']
    .map((name, index) => ({ id: 'sample-' + index, name, status: '样例已整理' }));
  forum.attendees = Array.from({ length: 136 }, (_, index) => ({
    id: 'G' + String(index + 1).padStart(3, '0'), name: ['陈晓', '林霏', '宋楠', '许安', '乔俞', '赵晴'][index] ?? '观众 ' + (index + 1),
    status: index < 128 ? '已确认' : index < 132 ? '候补' : '待审核',
    sessionId: index < 72 || index >= 128 ? 'session-4' : '',
  }));
  forum.budget = 65000;
  forum.quotes = [{ name: '场地及基础设备', supplier: '虹桥会议中心', quote: 26000, actual: 25000 }, { name: '灯光与音响', supplier: '云桥活动服务', quote: 12000, actual: 0 }];
  forum.change = incidentChange(forum, 'closure', 'session-4');
  const samples = [
    ['training', '新员工协作训练营', '企业培训', 48], ['expo', '城市设计作品展', '展览', 120],
    ['market', '周末创意市集', '市集', 100], ['campus', '校园社团开放日', '校园活动', 80],
  ].map(([id, title, type, capacity]) => newEvent({ title, type, date: '', capacity }, id));
  return [forum, ...samples];
}

export function loadEvents() {
  try {
    const stored = localStorage.getItem('huixu.events.2');
    if (stored) {
      const events = JSON.parse(stored);
      if (Array.isArray(events) && events.length) return events;
    }
  } catch {
    // 存储不可用时继续使用演练样例。
  }
  return initialEvents();
}

export function dateLabel(date) {
  if (!date) return '日期待定';
  const [, month, day] = date.split('-').map(Number);
  return month + '月' + day + '日';
}

export function money(value) {
  return '¥' + Number(value).toLocaleString('zh-CN');
}

export function participantCount(event, sessionId) {
  return event.attendees.filter(person => person.status === '已确认' && (!sessionId || person.sessionId === sessionId)).length;
}

export function liveAgenda(event, sessions) {
  const current = sessions.find(item => event.actual[item.id]?.started && !event.actual[item.id]?.ended);
  const next = sessions.find(item => !event.actual[item.id]?.started);
  return { current, next };
}

export function makeChange(session, candidates, reason, closedRoom = '', earliest = '') {
  return { id: uid(), title: session.title + '调整', sessionId: session.id, before: { ...session },
    reason, candidates, closedRoom, earliest };
}

export function makeMoveChange(event, session, request, reason, preferredCandidate) {
  const existing = event.change?.sessionId === session.id ? event.change : null;
  const moveRequest = { ...request, closedRoom: existing?.closedRoom || request.closedRoom, earliest: existing?.earliest || request.earliest };
  const analysis = analyzeMove(event, session, moveRequest);
  const candidates = [analysis.requested.candidate, ...analysis.alternatives.map(option => option.candidate)];
  if (preferredCandidate && !candidates.some(candidate => sameCandidate(candidate, preferredCandidate))) {
    candidates.push(preferredCandidate);
  }
  return { ...makeChange(session, candidates, reason, moveRequest.closedRoom, moveRequest.earliest), moveRequest, preferredCandidate };
}

export function incidentChange(event, kind, sessionId) {
  const session = event.agenda.find(item => item.id === sessionId);
  if (!session) return null;
  if (kind === 'closure') {
    const candidates = event.rooms.filter(room => room.id !== session.room)
      .map(room => moveCandidate(session, room.id, room.ready > session.start ? room.ready : session.start));
    return { ...makeChange(session, candidates, roomLabel(session.room) + '临时关闭', session.room), title: session.title + '换厅' };
  }
  const earliest = clock(minutes(session.start) + (kind === 'late' ? 20 : 15));
  const candidates = event.rooms.map(room => moveCandidate(session, room.id, room.ready > earliest ? room.ready : earliest));
  return makeChange(session, candidates, incidentKinds[kind] + ' · 最早 ' + earliest, '', earliest);
}

export function publishChange(event, candidate, recordMessage, reviewed) {
  const change = event.change;
  if (!change || !change.candidates.some(item => sameCandidate(item, candidate))) return event;
  if (checkCandidate(event, change, candidate).length) return event;
  const impact = describeChangeImpact(event, change, candidate);
  if (changeReviewKey(event, change, candidate, impact) !== reviewed) return event;
  const version = event.version + 1;
  const count = impact.notice.recipients.length;
  const messages = [];
  if (recordMessage) {
    const metadata = { channel: '演练通知', date: new Date().toLocaleString('zh-CN'), version };
    if (count) messages.push({ ...metadata, id: change.id, subject: change.title, body: impact.notice.body,
      recipientIds: impact.notice.recipients.map(person => person.id), count });
    for (const { role, body, recipients } of impact.personnelNotices) {
      messages.push({ ...metadata, id: `${change.id}-${role}`, subject: `${change.title} · ${role}`, body,
        recipientNames: recipients, count: recipients.length });
    }
    if (!messages.length) return event;
  }
  return {
    ...event, version, change: null,
    agenda: event.agenda.map(item => item.id === change.sessionId ? { ...item, ...candidate } : item),
    history: [{ id: change.id, title: change.title, before: change.before, after: candidate, impact, version, count, notified: messages.length > 0 }, ...event.history],
    messages: messages.length ? [...messages, ...event.messages] : event.messages,
  };
}

export function planFromText(text, fallbackType) {
  const type = activityTypes.find(value => text.includes(value))
    ?? (text.includes('论坛') ? '行业论坛' : fallbackType);
  const number = text.match(/(\d+)\s*(?:人|位)/);
  return { type, capacity: number ? Number(number[1]) : 150 };
}

export function materialText(event, kind) {
  const lines = [...event.agenda].sort((a, b) => a.start.localeCompare(b.start)).map(session => {
    const time = timeRange(session) + ' · ' + roomLabel(session.room);
    if (kind === '嘉宾行程') return time + '｜' + session.guest + ' · ' + session.title;
    if (kind === '主持稿') return time + '\n各位来宾，接下来是「' + session.title + '」，有请' + session.guest + '。';
    if (kind === '工作人员台本') return time + '｜' + session.title + '\n' + checkinPoint(session) + '，核对会场及设备。';
    if (kind === '岗位清单') {
      const posts = sessionPosts(sessionPeople(event, session));
      return `${time}｜${session.title}\n${posts.map(({ role, assignees }) => role + ' · ' + (assignees.join('、') || '待分配')).join('\n')}`;
    }
    return time + '｜' + session.title;
  });
  return [event.title + ' · ' + kind, event.version ? '发布版本 v' + event.version : '计划草稿', '', ...lines].join('\n');
}
