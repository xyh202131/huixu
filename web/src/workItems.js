import { isClock } from './scheduling.js';

export function workItems(event) {
  const sources = event.issues.filter(issue => !issue.resolved).map(issue => ({
    id: issue.id, title: issue.title, route: 'sources/issue/' + issue.id,
  }));
  for (const fact of event.reviewConflicts ?? []) {
    sources.push({ id: fact.key, title: fact.label, route: 'sources/conflict/' + encodeURIComponent(fact.key) });
  }
  const candidates = [event.change, ...(event.draftChanges ?? [])].filter(Boolean);
  const byId = new Map();
  for (const change of candidates) if (!byId.has(change.id)) byId.set(change.id, change);
  const changes = [...byId.values()];
  return { sources, changes };
}

export function agendaHours(agenda) {
  const valid = agenda.filter(row => isClock(row.start) && isClock(row.end) && row.start < row.end);
  if (!valid.length) return '时段待定';
  return valid.map(item => item.start).sort()[0] + '–' + valid.map(item => item.end).sort().at(-1);
}
