import { reservesSeat } from './registrationRules.js';
import { checkCandidate, clock, isClock, minutes, moveCandidate, roomLabel, sameCandidate, sessionPeople, timeRange } from './scheduling.js';

export const rescueKinds = { closure: '会场关闭', late: '嘉宾迟到', overrun: '环节超时' };
export const rescueProofVersion = 2;

export function rescueScope(event, input) {
  const { kind, at, until } = input ?? {};
  if (!Object.hasOwn(rescueKinds, kind) || !isClock(at) || !isClock(until) || at >= until) {
    return { error: '请填写有效的问题类型、事件时间和当天最晚结束时间。' };
  }
  const incident = { kind, at, until };
  const anchor = event.agenda.find(item => item.id === input.sessionId);
  const actual = session => event.actual?.[session.id] ?? { started: session.started, ended: session.ended };
  const personnel = new Map(event.agenda.map(session => [session.id, sessionPeople(event, session)]));
  let affected;
  let locked = [];
  let projected = event;
  if (kind === 'closure') {
    if (!event.rooms.some(room => room.id === input.room)) return { error: '请选择临时关闭的会场。' };
    incident.room = input.room;
    const inRoom = event.agenda.filter(session => session.room === incident.room && !actual(session).ended);
    locked = inRoom.filter(session => actual(session).started);
    affected = inRoom.filter(session => !actual(session).started && session.end > at);
  } else {
    if (!anchor || !isClock(input.resume) || input.resume <= at || input.resume > until) {
      return { error: '请选择相关环节，并填写晚于事件时间、在搜索时段内的预计时间。' };
    }
    incident.sessionId = anchor.id;
    incident.resume = input.resume;
    if (kind === 'late') {
      if (actual(anchor).started || actual(anchor).ended) return { error: '该环节已记录开始，请从超时或其他后续问题处理。' };
      const shifted = moveCandidate(anchor, anchor.room, input.resume);
      const anchorPeople = new Set(personnel.get(anchor.id).map(person => person.id));
      affected = event.agenda.filter(session => {
        if (session.id === anchor.id) return true;
        if (actual(session).started || actual(session).ended || session.end <= at) return false;
        if (session.room === anchor.room) return session.start < shifted.end && shifted.start < session.end;
        return personnel.get(session.id).some(person => anchorPeople.has(person.id)) &&
          minutes(session.start) < minutes(shifted.end) + 10 && minutes(session.end) + 10 > minutes(shifted.start);
      });
    } else {
      const started = actual(anchor).started;
      if (!started || actual(anchor).ended || input.resume <= started) return { error: '请为仍在进行的环节填写预计结束时间。' };
      const anchorPeople = new Set(personnel.get(anchor.id).map(person => person.id));
      affected = event.agenda.filter(session => {
        if (session.id === anchor.id || actual(session).started || actual(session).ended || session.end <= at) return false;
        if (session.room === anchor.room) return session.start < input.resume;
        return personnel.get(session.id).some(person => anchorPeople.has(person.id)) &&
          minutes(session.start) < minutes(input.resume) + 10;
      });
      // 预计结束只参与求解，实际结束时间仍由现场人员记录。
      projected = { ...event, actual: { ...event.actual, [anchor.id]: { started, ended: input.resume } } };
    }
  }
  affected.sort((a, b) => a.start.localeCompare(b.start) || a.id.localeCompare(b.id));
  const affectedIds = new Set(affected.map(session => session.id));
  return {
    incident, projected, affected, locked, personnel,
    unchanged: event.agenda.filter(session => !affectedIds.has(session.id)),
  };
}

function confirmedBySession(event) {
  if (!event.attendees) return new Map(event.agenda.map(session => [session.id, session.confirmed ?? 0]));
  const counts = new Map();
  for (const person of event.attendees) {
    if (!reservesSeat(person)) continue;
    counts.set(person.sessionId, (counts.get(person.sessionId) ?? 0) + 1);
  }
  return counts;
}

function placementIssues(scope, agenda, session, move, confirmed) {
  const { projected, personnel, incident } = scope;
  const change = { before: session, closedRoom: incident.room,
    earliest: incident.kind === 'late' && incident.sessionId === session.id ? incident.resume : incident.at };
  return checkCandidate({ ...projected, agenda }, change, move, confirmed.get(session.id) ?? 0, personnel, true);
}

export function validateRescuePlan(event, incident, plan) {
  const scope = rescueScope(event, incident);
  if (scope.error) return [scope.error];
  if (scope.locked.length) return ['关闭会场仍有进行中的环节。请先现场处置并记录实绩。'];
  if (!Array.isArray(plan?.moves) || plan.moves.length !== scope.affected.length || !scope.affected.length) {
    return ['方案须包含全部受影响环节。'];
  }
  const byId = new Map(plan.moves.map(move => [move?.sessionId, move]));
  if (scope.affected.some(session => !byId.has(session.id))) return ['受影响环节已变更，请重新计算。'];
  const confirmed = confirmedBySession(event);
  const moved = scope.affected.map(session => {
    const { room, start, end } = byId.get(session.id);
    return { ...session, room, start, end };
  });
  if (moved.every((candidate, index) => sameCandidate(candidate, scope.affected[index]))) return ['新安排与当前安排相同。'];
  const issues = [];
  for (const session of scope.affected) {
    const move = byId.get(session.id);
    if (!isClock(move.start) || !isClock(move.end) || move.end > scope.incident.until) {
      issues.push(session.title + '须在搜索时段内结束。');
      continue;
    }
    const agenda = [...scope.unchanged, ...moved.filter(item => item.id !== session.id), session];
    for (const issue of placementIssues(scope, agenda, session, move, confirmed)) issues.push(session.title + ' · ' + issue);
  }
  return [...new Set(issues)];
}

export function analyzeRescue(event, input) {
  const scope = rescueScope(event, input);
  if (scope.error) return { error: scope.error };
  const { incident, affected, unchanged, locked, personnel } = scope;
  const confirmed = confirmedBySession(event);
  const result = {
    incident, unchanged: unchanged.map(({ id, title, room, start, end }) => ({ id, title, room, start, end })),
    affected: affected.map(({ id, title, room, start, end, equipment }) => ({
      id, title, room, start, end, equipment: equipment ?? [], confirmed: confirmed.get(id) ?? 0,
      uncheckedPeople: personnel.get(id).filter(person => !person.availability).length,
    })),
    plans: [], blocked: [], limited: false,
  };
  if (locked.length) {
    result.blocked = locked.map(session => ({ title: session.title, room: session.room, reasons: ['环节仍在进行。请先安排现场处置，记录实际结束后重新计算。'] }));
    return result;
  }
  if (!affected.length) return result;

  const domains = new Map();
  const diagnostics = [];
  const lastMinute = minutes(incident.until);
  let domainChecks = 0;
  for (const session of affected) {
    const entries = [];
    const duration = minutes(session.end) - minutes(session.start);
    const before = minutes(session.start);
    const firstMinute = minutes(incident.kind === 'late' && incident.sessionId === session.id ? incident.resume : incident.at);
    for (const room of event.rooms) {
      const reasons = new Set();
      let available = false;
      const roomReady = isClock(room.ready) ? minutes(room.ready) : 0;
      const earliest = Math.max(firstMinute, roomReady);
      const latest = lastMinute - duration;
      if (earliest > latest || room.id === incident.room || (confirmed.get(session.id) ?? 0) > room.capacity ||
          (session.equipment ?? []).some(item => !room.equipment.includes(item))) {
        const candidate = moveCandidate(session, room.id, clock(Math.min(earliest, lastMinute)));
        for (const issue of placementIssues(scope, [...unchanged, session], session, candidate, confirmed)) reasons.add(issue);
        if (earliest > latest) reasons.add('按现有布置时间和环节时长，无法在 ' + incident.until + ' 前结束');
      } else {
        for (let time = earliest; time <= latest; time += 1) {
          if (++domainChecks > 60000) {
            result.limited = true;
            result.blocked = diagnostics;
            return result;
          }
          const move = { sessionId: session.id, ...moveCandidate(session, room.id, clock(time)) };
          const issues = placementIssues(scope, [...unchanged, session], session, move, confirmed);
          if (issues.length) {
            for (const issue of issues) reasons.add(issue);
            continue;
          }
          available = true;
          entries.push({ move, score: Math.abs(time - before) + (time < before ? 12 : 0) + (room.id !== session.room ? 2 : 0) });
        }
      }
      if (!available && reasons.size) diagnostics.push({ title: session.title, room: room.id, reasons: [...reasons].slice(0, 6) });
    }
    entries.sort((a, b) => a.score - b.score);
    domains.set(session.id, entries);
  }
  result.blocked = diagnostics;
  if (affected.some(session => !domains.get(session.id).length)) return result;

  const order = affected.toSorted((a, b) => domains.get(a.id).length - domains.get(b.id).length);
  const selected = new Map();
  const distinctPlans = new Set();
  const jointProblems = new Set();
  let checks = 0;
  function search(index) {
    if (result.plans.length === 3 || result.limited) return;
    if (index === order.length) {
      const moves = affected.map(session => selected.get(session.id));
      if (moves.every((move, position) => sameCandidate(move, affected[position]))) return;
      const key = JSON.stringify(moves.map(move => [move.room, Math.floor(minutes(move.start) / 20)]));
      if (!distinctPlans.has(key)) {
        distinctPlans.add(key);
        result.plans.push({ moves });
      }
      return;
    }
    const session = order[index];
    const placed = order.slice(0, index).map(item => ({ ...item, ...selected.get(item.id) }));
    for (const { move } of domains.get(session.id)) {
      if (++checks > 30000) { result.limited = true; return; }
      const issues = placementIssues(scope, [...placed, session], session, move, confirmed);
      if (issues.length) {
        for (const issue of issues) jointProblems.add(session.title + ' · ' + issue);
        continue;
      }
      selected.set(session.id, move);
      search(index + 1);
      selected.delete(session.id);
      if (result.plans.length === 3 || result.limited) return;
    }
  }
  search(0);
  if (jointProblems.size) result.blocked.push({ title: '组合校验', reasons: [...jointProblems].slice(0, 8) });
  return result;
}

export function rescueSummary(analysis) {
  if (analysis.error) return analysis.error;
  const { affected, plans, incident, limited, blocked } = analysis;
  if (plans.length) return '已联合校验 ' + affected.length + ' 个受影响环节，找到 ' + plans.length + ' 套可核对的方案。';
  if (!affected.length && !blocked.length) return '该时段没有需要重新排程的环节。';
  if (limited) return '在 ' + timeRange({ start: incident.at, end: incident.until }) + ' 内暂未找到可行方案，搜索达到上限。';
  if (!affected.length) return '需要先处理仍在进行的环节。';
  return '在 ' + timeRange({ start: incident.at, end: incident.until }) + ' 内无可行组合。请核对下方卡点，再调整可接受的条件。';
}

export function rescueTitle(incident) {
  return incident.kind === 'closure' ? roomLabel(incident.room) + '关闭 · 整场调整' : rescueKinds[incident.kind] + ' · 整场调整';
}
