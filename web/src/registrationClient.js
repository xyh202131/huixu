import { useEffect, useState } from 'react';
import { sessionExpired } from './authClient';
import { signupSnapshot } from './registrationRules.js';

async function registrationRequest(base, path, method = 'GET', input, signal, token) {
  const headers = {};
  if (token) headers['X-Huixu-Confirmation'] = token;
  let body = input;
  if (input && !(input instanceof File)) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(input);
  }
  const response = await fetch(base + path, { method, headers, body, signal, cache: 'no-store' });
  if (response.status === 401 && base === '/api/registration') window.dispatchEvent(new Event(sessionExpired));
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
  return registrationRequest('/api/registration/events', path, method, body, signal);
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

export function useRegistrationWorkspace(enabled, event) {
  const [data, setData] = useState({});
  const [mailByEvent, setMailByEvent] = useState({});
  const [problem, setProblem] = useState('');
  const [reload, setReload] = useState(0);
  const eventId = event.id;
  const base = '/' + eventId;
  const current = data[eventId] ?? null;

  function accept(result) {
    setData(existing => {
      const id = result.event.id;
      if (existing[id]?.revision >= result.revision) return existing;
      return { ...existing, [id]: result };
    });
  }

  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    let holding = false;
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
        if (!controller.signal.aborted) { accept(result); setProblem(''); }
      } catch (error) {
        if (!controller.signal.aborted) setProblem(error.message);
      } finally {
        holding = false;
      }
    }
    setProblem('');
    const stopPolling = pollRegistration(load, 3500);
    return () => {
      controller.abort();
      stopPolling();
    };
  }, [enabled, eventId, reload]);

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

  return { current, problem, refresh: () => setReload(value => value + 1), change,
    mail: mailByEvent[eventId], legacyPeople: event.attendees ?? [] };
}
