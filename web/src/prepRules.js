import { roomKey } from './executionPlan.js';

export function taskDueDate(task, eventDate) {
  if (task.dueDate) return task.dueDate;
  if (!eventDate || task.offset == null || task.offset === '') return '';
  const deadline = new Date(eventDate + 'T12:00:00Z');
  deadline.setUTCDate(deadline.getUTCDate() - task.offset);
  return Number.isNaN(deadline.getTime()) ? '' : deadline.toISOString().slice(0, 10);
}

export function preparationRooms(event) {
  const rooms = new Map(event.rooms.map(room => [room.id, room]));
  if (!event.version) {
    for (const room of event.executionPlan?.rooms ?? []) rooms.set(room.id, room);
  }
  return [...rooms.values()];
}

export function saveDraftRoom(event, originalId, room) {
  if (!originalId) return { ...event, rooms: [...event.rooms, room] };
  // 采用后的待排程会场优先，改名时同时更新草稿中的会场引用。
  const replaceRoom = item => item.id === originalId ? room : item;
  const updateRoomRef = item => item.room === originalId ? { ...item, room: room.id } : item;
  const next = { ...event, rooms: event.rooms.map(replaceRoom), agenda: event.agenda.map(updateRoomRef) };
  if (event.executionPlan) {
    next.executionPlan = { ...event.executionPlan, rooms: event.executionPlan.rooms.map(replaceRoom),
      agenda: event.executionPlan.agenda.map(updateRoomRef) };
  }
  if (event.organizedPlan) {
    next.organizedPlan = {
      ...event.organizedPlan,
      venues: (event.organizedPlan.venues ?? []).map(venue => roomKey(venue.name) === originalId
        ? { ...venue, name: room.id, capacity: String(room.capacity), equipment: room.equipment.join('、') } : venue),
      agenda: event.organizedPlan.agenda.map(item => roomKey(item.room) === originalId && room.id !== originalId
        ? { ...item, room: room.id } : item),
    };
  }
  return next;
}
