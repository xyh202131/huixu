import { sessionExpired } from './authClient';
import { sessionPeople } from './scheduling';
import { reservesSeat } from './registrationRules';
import { browserModel } from './browserModels';
import { workItems } from './workItems';

export async function askModel(question, event, signal, ownerId, history = []) {
  const connection = await browserModel('chat', ownerId);
  if (!ownerId && !connection) return { code: 'MODEL_NOT_CONFIGURED', error: '请先在右上角模型设置中填写并保存 API Key，即可开始使用 Agent。' };
  const registrations = new Map();
  for (const person of event.attendees) {
    const totals = registrations.get(person.sessionId) ?? { confirmed: 0, waitlisted: 0, pending: 0 };
    if (reservesSeat(person)) totals.confirmed += 1;
    if (person.status === '候补') totals.waitlisted += 1;
    if (person.status === '待审核') totals.pending += 1;
    registrations.set(person.sessionId, totals);
  }
  const aliases = new Map();
  const agenda = event.agenda.map(session => {
    const { id, title, start, end, room, expected, equipment } = session;
    const people = sessionPeople(event, session).map(person => {
      if (!aliases.has(person.id)) aliases.set(person.id, `p${aliases.size + 1}`);
      return { id: aliases.get(person.id), role: person.role, availability: person.availability };
    });
    return { id, title, start, end, room, expected, people, equipment, ...registrations.get(id),
      checkedIn: event.checkins.filter(item => item.sessionId === id).length, started: event.actual[id]?.started, ended: event.actual[id]?.ended };
  });
  const pending = workItems(event);
  const snapshot = {
    id: event.id, title: event.title, date: event.date, venue: event.venue, type: event.type, version: event.version,
    choices: ownerId ? Object.fromEntries(Object.entries(event.organizationChoices ?? {}).filter(([key, choice]) =>
      choice?.value && (!choice.status || choice.status === '已确认') && !key.startsWith('["roster",')).slice(0, 120)
      .map(([key, { value, evidence }]) => [key, { value, evidence }])) : undefined,
    agenda,
    rooms: event.rooms.map(({ id, capacity, ready, equipment }) => ({ id, capacity, ready, equipment })),
    change: event.change && { sessionId: event.change.sessionId, closedRoom: event.change.closedRoom, earliest: event.change.earliest },
    status: {
      taskCount: event.tasks.length, completedTasks: event.tasks.filter(task => task.done).length,
      pendingTasks: event.tasks.filter(task => !task.done).slice(0, 24).map(task => task.name),
      budget: event.budget, actualCost: event.quotes.reduce((total, quote) => total + quote.actual, 0),
      capacity: event.capacity, formOpen: event.formOpen, registered: event.attendees.length,
      confirmed: event.attendees.filter(reservesSeat).length,
      waitlisted: event.attendees.filter(person => person.status === '候补').length,
      checkedIn: event.checkins.filter(item => !item.sessionId).length,
      pendingChange: event.change?.title, lastPublished: event.history[0]?.title,
      changeCount: pending.changes.length, sourceCount: pending.sources.length,
      stagedSessions: (event.executionPlan?.agenda ?? []).slice(0, 24).map(row => row.title),
      lessons: (event.organizedPlan?.reference?.lessons ?? []).map(item => item.condition + ' · ' + item.advice),
    },
  };
  const response = await fetch(ownerId ? '/api/agent' : '/api/browser-agent', {
    method: 'POST', signal, headers: { 'Content-Type': 'application/json', ...(ownerId && { 'X-Huixu-Account': ownerId }) },
    body: JSON.stringify({ question, event: snapshot, history, connection: connection ?? undefined }),
  });
  if (response.status === 401) window.dispatchEvent(new Event(sessionExpired));
  if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('会序模型接口不可用，请通过工作台开发服务启动。');
  const result = await response.json();
  if (!response.ok && !result.error) throw new Error('会序模型接口未能完成请求。');
  return result;
}
