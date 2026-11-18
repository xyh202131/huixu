const fields = ['title', 'date', 'venue', 'capacity', 'budget', 'organizedPlan', 'executionPlan', 'tasks', 'organizationChoices', 'reviewConflicts', 'issues', 'teamLessons'];

export function workspaceDraft(event) {
  return Object.fromEntries(fields.filter(key => Object.hasOwn(event, key)).map(key => [key, event[key]]));
}

export function draftChanged(before, after) {
  return fields.some(key => before[key] !== after[key]);
}

export function restoreWorkspaceDraft(event, saved) {
  const restored = { ...event, ...saved.data, draftRevision: saved.revision, draftDirty: false };
  if (event.version > 0) {
    for (const key of ['title', 'date', 'venue', 'capacity']) restored[key] = event[key];
    restored.executionPlan = null;
  }
  return restored;
}
