export const reviewStatuses = ['待审核', '已确认', '候补', '已取消'];

export function reservesSeat(person) {
  return person.status === '已确认' && person.attendance !== '无法参加';
}

export function signupSnapshot(event) {
  return {
    id: event.id, title: event.title, type: event.type, date: event.date, venue: event.venue,
    version: event.version, capacity: event.capacity, formOpen: event.formOpen,
    agenda: event.agenda.map(({ id, title, start, end, room, guest, equipment }) => ({ id, title, start, end, room, guest, equipment })),
    rooms: event.rooms.map(({ id, capacity, ready, equipment }) => ({ id, capacity, ready, equipment })),
  };
}

export function rescueOperations(event) {
  return {
    actual: event.actual,
    sessions: event.agenda.map(({ id, guest, equipment }) => ({ id, guest: guest || '待确认', equipment: equipment ?? [] })),
    replies: event.replies.filter(reply => reply.role === 'guest' || reply.role === 'volunteer')
      .filter(reply => reply.id && reply.sessionId)
      .map(({ id, role, name, sessionId, availability }) => ({ id, role, name, sessionId, availability }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  };
}
