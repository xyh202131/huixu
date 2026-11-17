import { checkinPoint, roomLabel, sameCandidate, sessionPeople, timeRange } from './scheduling.js';
import { reservesSeat } from './registrationRules.js';

export function sessionPosts(people) {
  const guides = people.filter(person => person.role === '分场引导').map(person => person.name);
  return [
    { role: '签到', assignees: [] },
    { role: '分场引导', assignees: guides },
    { role: '会场联络', assignees: [] },
  ];
}

export function describeChangeImpact(event, change, candidate) {
  const before = change.before;
  const session = event.agenda.find(item => item.id === change.sessionId) ?? before;
  const people = sessionPeople(event, session).map(({ name, role, availability }) => ({ name, role, availability }));
  const registrations = event.attendees.filter(person => person.sessionId === change.sessionId)
    .map(({ id, name, status, attendance }) => ({ id, name, status, attendance }));
  const checkedIn = event.checkins.filter(item => item.sessionId === change.sessionId).length;
  const checkin = { before: checkinPoint(before), after: checkinPoint(candidate) };
  const beforeLabel = `${roomLabel(before.room)} · ${timeRange(before)}`;
  const afterLabel = `${roomLabel(candidate.room)} · ${timeRange(candidate)}`;
  const posts = sessionPosts(people).map(post => ({ ...post, before: beforeLabel, after: afterLabel }));
  const summary = `【议程变更】${session.title}由 ${beforeLabel} 调整至 ${afterLabel}。`;
  const notice = {
    recipients: registrations.filter(reservesSeat),
    body: `${summary}请前往${checkin.after}，以最新议程为准。`,
  };
  const personnelNotices = [
    { role: '嘉宾', body: `${summary}请按新时间到${roomLabel(candidate.room)}，如有冲突请回复负责人。` },
    { role: '分场引导', body: `${summary}请核对新班次，并在${checkin.after}处引导观众。` },
  ].map(group => ({ ...group, recipients: [...new Set(people.filter(person => person.role === group.role).map(person => person.name))] }))
    .filter(group => group.recipients.length > 0);
  return { registrations, checkedIn, checkin, people, posts, notice, personnelNotices };
}

export function changeReviewKey(event, change, candidate, impact = describeChangeImpact(event, change, candidate)) {
  return JSON.stringify([change.id, event.version, candidate.room, candidate.start, candidate.end, impact]);
}

export function describeRescueImpact(event, plan) {
  const rows = [];
  const people = new Map();
  function add(role, id, name, body) {
    const key = role + ':' + id;
    if (!people.has(key)) people.set(key, { role, id, name, parts: [] });
    const entry = people.get(key);
    if (!entry.parts.includes(body)) entry.parts.push(body);
  }
  for (const move of plan.moves) {
    const before = event.agenda.find(session => session.id === move.sessionId);
    if (sameCandidate(move, before)) continue;
    const impact = describeChangeImpact(event, { before, sessionId: before.id }, move);
    rows.push({ before, after: move, impact });
    for (const recipient of impact.notice.recipients) add('观众', recipient.id, recipient.name, impact.notice.body);
    for (const notice of impact.personnelNotices) {
      for (const name of notice.recipients) add(notice.role, name.normalize('NFKC').trim().toLowerCase(), name, notice.body);
    }
  }
  const notices = new Map();
  for (const person of people.values()) {
    const body = person.parts.join('\n\n');
    const group = person.role + ':' + body;
    if (!notices.has(group)) notices.set(group, { role: person.role, body, recipients: [] });
    notices.get(group).recipients.push({ id: person.id, name: person.name });
  }
  return { rows, notices: [...notices.values()], count: people.size };
}
