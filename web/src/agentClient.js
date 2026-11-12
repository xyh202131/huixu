export async function askModel(question, event, signal) {
  const confirmed = new Map();
  for (const person of event.attendees) {
    if (person.status === '已确认') confirmed.set(person.sessionId, (confirmed.get(person.sessionId) ?? 0) + 1);
  }
  const guests = new Map();
  const agenda = event.agenda.map(({ id, title, start, end, room, guest, equipment }) => {
    if (guest && !guests.has(guest)) guests.set(guest, `g${guests.size + 1}`);
    return { id, title, start, end, room, guest: guests.get(guest) ?? '', equipment,
      confirmed: confirmed.get(id) ?? 0, started: event.actual[id]?.started, ended: event.actual[id]?.ended };
  });
  const snapshot = {
    id: event.id, title: event.title, date: event.date, venue: event.venue, type: event.type, version: event.version,
    agenda,
    rooms: event.rooms.map(({ id, capacity, ready, equipment }) => ({ id, capacity, ready, equipment })),
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
