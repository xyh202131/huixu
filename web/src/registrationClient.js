import { useEffect, useState } from 'react';
import { sessionExpired } from './authClient';
import { signupSnapshot } from './registrationRules.js';

const ownerBase = '/api/registration/events';

export function localOnlyLink(value) {
  return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(value).hostname);
}

async function registrationRequest(base, path, method = 'GET', input, signal, token) {
  const headers = {};
  if (token) headers['X-Huixu-Confirmation'] = token;
  let body = input;
  if (input && !(input instanceof File)) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(input);
  }
  const response = await fetch(base + path, { method, headers, body, signal, cache: 'no-store' });
  if (response.status === 401 && base === ownerBase) window.dispatchEvent(new Event(sessionExpired));
  if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('报名服务暂时不可用。');
  const result = await response.json();
  if (!response.ok) {
    const error = new Error(result.error || '报名服务未完成此操作。');
    error.status = response.status;
    throw error;
  }
  return result;
}

export function ownerRegistration(path, method, body, signal) {
  return registrationRequest(ownerBase, path, method, body, signal);
}

export function publicRegistration(path, method, body, signal) {
  return registrationRequest('/api/registration-public', path, method, body, signal);
}

export function attendeeConfirmation(token, method, body, signal) {
  return registrationRequest('/api/registration-public', '/attendance', method, body, signal, token);
}

export function pollRegistration(load, interval) {
  let timer;
  function refresh() {
    if (!document.hidden) void load();
  }
  function syncVisibility() {
    clearInterval(timer);
    if (document.hidden) return;
    refresh();
    timer = setInterval(refresh, interval);
  }
  document.addEventListener('visibilitychange', syncVisibility);
  window.addEventListener('focus', refresh);
  syncVisibility();
  return () => {
    clearInterval(timer);
    document.removeEventListener('visibilitychange', syncVisibility);
    window.removeEventListener('focus', refresh);
  };
}

function unsharedCheckins(legacy, saved) {
  if (!legacy.length) return [];
  const key = ({ personId, sessionId }) => JSON.stringify([personId.toUpperCase(), sessionId]);
  const known = new Set(saved.map(key));
  return legacy.filter(record => {
    if (typeof record?.personId !== 'string' || typeof record.sessionId !== 'string') return false;
    const id = key(record);
    if (known.has(id)) return false;
    known.add(id);
    return true;
  });
}

export function useRegistrationWorkspace(enabled, event) {
  const [data, setData] = useState({});
  const [mailByEvent, setMailByEvent] = useState({});
  const [problem, setProblem] = useState('');
  const [migrationProblem, setMigrationProblem] = useState('');
  const [reload, setReload] = useState(0);
  const eventId = event.id;
  const base = '/' + eventId;
  const current = data[eventId] ?? null;
  const legacyKey = JSON.stringify(event.checkins ?? []);
  const pendingCheckins = enabled && current ? unsharedCheckins(event.checkins ?? [], current.checkins).length : 0;

  function accept(result) {
    setData(existing => {
      const id = result.event.id;
      const previous = existing[id];
      if (previous && (previous.revision > result.revision ||
        previous.revision === result.revision && (previous.workspaceRevision ?? 0) >= (result.workspaceRevision ?? 0))) return existing;
      return { ...existing, [id]: result };
    });
  }

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    const legacy = JSON.parse(legacyKey);
    let holding = false;
    let migratedRevision;
    async function load() {
      if (holding || controller.signal.aborted) return;
      holding = true;
      try {
        let result;
        try {
          result = await ownerRegistration(base, 'GET', undefined, controller.signal);
        } catch (error) {
          if (error.status !== 404) throw error;
          result = await ownerRegistration('', 'POST', signupSnapshot(event), controller.signal);
        }
        const remaining = unsharedCheckins(legacy, result.checkins);
        if (remaining.length && migratedRevision !== result.revision && !controller.signal.aborted) {
          try {
            for (let offset = 0; offset < remaining.length && !controller.signal.aborted; offset += 1000) {
              result = await ownerRegistration(base + '/checkins/migrate', 'POST',
                { records: remaining.slice(offset, offset + 1000) }, controller.signal);
            }
            migratedRevision = result.revision;
            if (!controller.signal.aborted) setMigrationProblem('');
          } catch (error) {
            if (!controller.signal.aborted) setMigrationProblem(error.message);
          }
        }
        if (!controller.signal.aborted) { accept(result); setProblem(''); }
      } catch (error) {
        if (!controller.signal.aborted) setProblem(error.message);
      } finally {
        holding = false;
      }
    }
    setProblem('');
    setMigrationProblem('');
    const stopPolling = pollRegistration(load, 3500);
    return () => {
      controller.abort();
      stopPolling();
    };
  }, [enabled, eventId, legacyKey, reload]);

  async function change(path, method, body) {
    try {
      const result = await ownerRegistration(base + path, method, body);
      if (result.event) accept(result);
      if (result.state) accept(result.state);
      if (result.records) setMailByEvent(current => ({ ...current, [eventId]: result }));
      return result;
    } catch (error) {
      if (error.status === 409) {
        const latest = await ownerRegistration(base).catch(() => null);
        if (latest) accept(latest);
      }
      throw error;
    }
  }

  return { current, problem, migrationProblem, pendingCheckins, refresh: () => setReload(value => value + 1), change,
    mail: mailByEvent[eventId], legacyPeople: event.attendees ?? [] };
}
