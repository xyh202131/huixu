export const isClock = value => typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);

export function minutes(time) {
  const [hour, minute] = time.split(':').map(Number);
  return hour * 60 + minute;
}

export function clock(value) {
  const safeValue = Math.max(0, Math.min(1439, value));
  return String(Math.floor(safeValue / 60)).padStart(2, '0') + ':' + String(safeValue % 60).padStart(2, '0');
}

export function roomLabel(room) {
  return room ? room + ' 厅' : '待定';
}

export function timeRange(item) {
  return item.start + '–' + item.end;
}

export function checkinPoint(session) {
  return roomLabel(session.room) + '门口签到';
}

export function sameCandidate(candidate, other) {
  return Boolean(other && candidate.room === other.room && candidate.start === other.start && candidate.end === other.end);
}

export function moveCandidate(session, room, start) {
  const duration = minutes(session.end) - minutes(session.start);
  return { room, start, end: clock(minutes(start) + duration) };
}

function personKey(name) {
  return name?.normalize('NFKC').trim().toLowerCase() || '';
}

export function sessionPeople(event, session) {
  if (session.people) return session.people;
  const replies = event.replies ?? [];
  const guest = personKey(session.guest);
  const people = [];
  if (guest && guest !== '待确认' && guest !== '待定') {
    const reply = replies.findLast(item => item.role === 'guest' && item.sessionId === session.id && personKey(item.name) === guest);
    people.push({ id: guest, name: session.guest, role: '嘉宾', availability: reply?.availability });
  }
  for (const reply of replies) {
    if (reply.role !== 'volunteer' || reply.sessionId !== session.id) continue;
    people.push({ id: personKey(reply.name), name: reply.name, role: '分场引导', availability: reply.availability });
  }
  return people;
}

function roomIssues(room, change, equipment, confirmedCount) {
  const issues = [];
  if (room.id === change.closedRoom) issues.push('会场临时关闭');
  if (confirmedCount > room.capacity) issues.push('超出 ' + (confirmedCount - room.capacity) + ' 人（容量 ' + room.capacity + ' 人）');
  const missing = equipment.filter(name => !room.equipment.includes(name));
  if (missing.length) issues.push('缺少' + missing.join('、'));
  return issues;
}

export function checkCandidate(event, change, candidate, confirmedCount, personnel) {
  const room = event.rooms.find(item => item.id === candidate.room);
  if (!room) return ['会场待确认'];
  const session = change.before;
  const current = event.agenda.find(item => item.id === session.id);
  if (!current || current.start !== session.start || current.end !== session.end || current.room !== session.room) {
    return ['当前安排已更新，请从议程重新提出调整'];
  }
  if (!isClock(candidate.start) || !isClock(candidate.end) || candidate.start >= candidate.end) return ['结束时间须晚于开始时间'];
  if (candidate.room === current.room && candidate.start === current.start && candidate.end === current.end) return ['新安排与当前安排相同'];

  const confirmed = confirmedCount ?? (event.attendees ? event.attendees.filter(person =>
    person.sessionId === session.id && person.status === '已确认').length : current.confirmed ?? 0);
  const issues = roomIssues(room, change, current.equipment, confirmed);
  const duration = minutes(session.end) - minutes(session.start);
  if (minutes(candidate.end) - minutes(candidate.start) !== duration) issues.push('当天剩余时间不足，无法保留原环节时长');
  if (candidate.start < room.ready) issues.push('布置完成时间为 ' + room.ready);
  if (change.earliest && candidate.start < change.earliest) issues.push('最早可开始时间为 ' + change.earliest);
  if (event.actual?.[session.id]?.started || current.started) issues.push('环节已开始，请调整后续环节');

  const people = personnel?.get(session.id) ?? sessionPeople(event, current);
  const peopleById = new Map(people.map(person => [person.id, person]));
  for (const { role, availability } of people) {
    if (availability && (candidate.start < availability.start || candidate.end > availability.end)) {
      issues.push(`${role}可用时段为 ${timeRange(availability)}`);
    }
  }
  for (const other of event.agenda) {
    if (other.id === session.id) continue;
    const actualStart = other.started || event.actual?.[other.id]?.started;
    const actualEnd = other.ended || event.actual?.[other.id]?.ended;
    const ongoing = actualStart && !actualEnd;
    const otherStart = actualStart || other.start;
    const otherEnd = ongoing ? '23:59' : actualEnd || other.end;
    const overlaps = candidate.start < otherEnd && otherStart < candidate.end;
    if (overlaps && candidate.room === other.room) {
      issues.push(ongoing ? '「' + other.title + '」仍在该会场进行，结束时间待确认' : '会场与「' + other.title + '」撞场');
    }
    if (!people.length) continue;
    const others = personnel?.get(other.id) ?? sessionPeople(event, other);
    for (const person of others) {
      const assigned = peopleById.get(person.id);
      if (!assigned) continue;
      if (overlaps) issues.push(ongoing ? assigned.role + '仍在「' + other.title + '」，结束时间待确认' : assigned.role + '与「' + other.title + '」时间重叠');
      else if (candidate.room !== other.room) {
        const gap = Math.max(minutes(candidate.start) - minutes(otherEnd), minutes(otherStart) - minutes(candidate.end));
        if (gap < 10) issues.push(assigned.role + '跨厅转场不足 10 分钟（' + other.title + '）');
      }
    }
  }
  return [...new Set(issues)];
}

export function analyzeMove(event, session, { room, start, closedRoom = '', earliest = '' }, confirmedCount) {
  const change = { before: session, closedRoom, earliest };
  const confirmed = confirmedCount ?? (event.attendees ? event.attendees.filter(person =>
    person.sessionId === session.id && person.status === '已确认').length : session.confirmed ?? 0);
  const personnel = new Map(event.agenda.map(item => [item.id, sessionPeople(event, item)]));
  const assess = candidate => ({ candidate, issues: checkCandidate(event, change, candidate, confirmed, personnel) });
  const requested = assess(moveCandidate(session, room, start));
  const proposedTime = minutes(start);
  const from = Math.max(0, proposedTime - 120);
  const until = Math.min(1439, proposedTime + 120);
  const window = { start: clock(from), end: clock(until) };
  const current = event.agenda.find(item => item.id === session.id);
  if (!current || current.start !== session.start || current.end !== session.end || current.room !== session.room) {
    return { requested, alternatives: [], blocked: [], window };
  }
  const roomOnly = room !== session.room && start === session.start;
  const timeOnly = room === session.room && start !== session.start;
  const alternatives = [];
  const blocked = [];

  for (const availableRoom of event.rooms) {
    const roomId = availableRoom.id;
    if (roomOnly && roomId === session.room) continue;
    const firstStart = Math.max(from, minutes(availableRoom.ready || '00:00'), minutes(earliest || '00:00'));
    const nearest = Math.max(proposedTime, firstStart);
    const reference = assess(moveCandidate(session, roomId, clock(nearest)));
    const permanent = roomIssues(availableRoom, change, session.equipment, confirmed);
    if (permanent.length || event.actual?.[session.id]?.started || session.started || firstStart > until) {
      if (reference.issues.length || firstStart > until) {
        if (firstStart > until) reference.issues.push('该会场在备选搜索时段内尚未就绪');
        blocked.push(reference);
      }
      continue;
    }

    let found;
    for (let offset = 0; offset <= 120 && !found; offset += 1) {
      const times = offset ? [proposedTime + offset, proposedTime - offset] : [proposedTime];
      for (const minute of times) {
        if (minute < firstStart || minute > until) continue;
        const candidateStart = clock(minute);
        if (roomId === room && candidateStart === start) continue;
        if (candidateStart === session.start && (timeOnly || roomId === session.room)) continue;
        const option = assess(moveCandidate(session, roomId, candidateStart));
        if (option.issues.length) continue;
        found = option;
        break;
      }
    }
    if (found) alternatives.push(found);
    else if (reference.issues.length) blocked.push(reference);
  }

  alternatives.sort((left, right) => {
    const distance = option => Math.abs(minutes(option.candidate.start) - proposedTime);
    return distance(left) - distance(right) || Number(right.candidate.room === room) - Number(left.candidate.room === room);
  });
  return { requested, alternatives: alternatives.slice(0, 3), blocked, window };
}
