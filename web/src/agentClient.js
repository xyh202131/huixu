import { sessionPeople } from './scheduling';

export async function askModel(question, event, signal) {
  const registrations = new Map();
  for (const person of event.attendees) {
    const totals = registrations.get(person.sessionId) ?? { confirmed: 0, waitlisted: 0, pending: 0 };
    if (person.status === '已确认') totals.confirmed += 1;
    if (person.status === '候补') totals.waitlisted += 1;
    if (person.status === '待审核') totals.pending += 1;
    registrations.set(person.sessionId, totals);
  }
  const aliases = new Map();
  const agenda = event.agenda.map(session => {
    const { id, title, start, end, room, equipment } = session;
    const people = sessionPeople(event, session).map(person => {
      if (!aliases.has(person.id)) aliases.set(person.id, `p${aliases.size + 1}`);
      return { id: aliases.get(person.id), role: person.role, availability: person.availability };
    });
    return { id, title, start, end, room, people, equipment, ...registrations.get(id),
      checkedIn: event.checkins.filter(item => item.sessionId === id).length, started: event.actual[id]?.started, ended: event.actual[id]?.ended };
  });
  const snapshot = {
    id: event.id, title: event.title, date: event.date, venue: event.venue, type: event.type, version: event.version,
    agenda,
    rooms: event.rooms.map(({ id, capacity, ready, equipment }) => ({ id, capacity, ready, equipment })),
    change: event.change && { sessionId: event.change.sessionId, closedRoom: event.change.closedRoom, earliest: event.change.earliest },
    status: {
      taskCount: event.tasks.length, completedTasks: event.tasks.filter(task => task.done).length,
      pendingTasks: event.tasks.filter(task => !task.done).slice(0, 24).map(task => task.name),
      budget: event.budget, actualCost: event.quotes.reduce((total, quote) => total + quote.actual, 0),
      capacity: event.capacity, formOpen: event.formOpen, registered: event.attendees.length,
      confirmed: event.attendees.filter(person => person.status === '已确认').length,
      waitlisted: event.attendees.filter(person => person.status === '候补').length,
      checkedIn: event.checkins.filter(item => !item.sessionId).length,
      pendingChange: event.change?.title, lastPublished: event.history[0]?.title,
    },
  };
  const response = await fetch('/api/agent', {
    method: 'POST', signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question, event: snapshot }),
  });
  if (response.status === 401) window.dispatchEvent(new Event(sessionExpired));
  if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('会序模型接口不可用，请通过工作台开发服务启动。');
  const result = await response.json();
  if (!response.ok && !result.error) throw new Error('会序模型接口未能完成请求。');
  return result;
}
import { sessionExpired } from './authClient';
