import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { sessionExpired } from './authClient';
import { initialEvents, loadEvents, newEvent } from './model';

function initialWorkspace(account) {
  const events = account?.legacyWorkspace ? loadEvents().map(event => ({ ...newEvent(event, event.id), ...event })) : initialEvents();
  if (account && !account.legacyWorkspace) {
    for (const event of events) event.id = `sample-${account.id}-${event.id}`;
  }
  let activeId;
  if (account?.legacyWorkspace) {
    try { activeId = sessionStorage.getItem('huixu.active'); } catch { /* 浏览器可能禁用存储。 */ }
  }
  return { events, activeId: events.some(event => event.id === activeId) ? activeId : events[0].id, conversations: [] };
}

function pendingDraft(key) {
  try { return JSON.parse(sessionStorage.getItem(key)); } catch { return null; }
}

function rememberPending(key, state) {
  try {
    if (state.latest === state.saved) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, JSON.stringify({ revision: state.revision, data: state.latest }));
    return true;
  } catch { return false; }
}

async function workspaceRequest(accountId, input, signal) {
  const headers = { 'X-Huixu-Account': accountId };
  const options = { headers, cache: 'no-store', signal };
  if (input) {
    headers['Content-Type'] = 'application/json';
    options.method = 'POST';
    options.body = JSON.stringify({ accountId, ...input });
    options.keepalive = new Blob([options.body]).size < 60 * 1024;
  }
  const response = await fetch('/api/workspace', options);
  if (response.status === 401) window.dispatchEvent(new Event(sessionExpired));
  const result = response.headers.get('content-type')?.includes('application/json')
    ? await response.json().catch(() => null) : null;
  if (!response.ok) throw Object.assign(new Error(result?.error || '暂时无法访问工作区。'), { code: result?.code });
  const revision = result?.revision;
  const data = result?.data;
  let acknowledged;
  if (input) acknowledged = revision === input.revision + 1;
  else if (revision === 0) acknowledged = data === null;
  else acknowledged = Number.isSafeInteger(revision) && revision > 0 && Array.isArray(data?.events) &&
    Array.isArray(data.conversations) && data.events.some(event => event?.id === data.activeId);
  if (!acknowledged) throw new Error('工作区服务返回异常，请重试。');
  return result;
}

export function useWorkspace(account) {
  const accountId = account?.id;
  const key = `huixu.workspace.pending.${accountId}`;
  const [data, setData] = useState(() => accountId ? null : initialWorkspace());
  const [status, setStatus] = useState({ phase: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const record = useRef(null);

  useEffect(() => {
    if (!accountId) return;
    const controller = new AbortController();
    setStatus({ phase: 'loading' });
    workspaceRequest(accountId, null, controller.signal).then(remote => {
      if (controller.signal.aborted) return;
      const pending = pendingDraft(key);
      const unchanged = pending && JSON.stringify(pending.data) === JSON.stringify(remote.data);
      const current = (unchanged ? null : pending?.data) ?? remote.data ?? initialWorkspace(account);
      const conflict = Boolean(pending && !unchanged && pending.revision !== remote.revision);
      record.current = { revision: conflict ? pending.revision : remote.revision, saved: remote.data, latest: current, conflict, cached: true };
      record.current.cached = rememberPending(key, record.current);
      setStatus({ phase: conflict ? 'conflict' : current === remote.data ? 'saved' : 'saving' });
      setData(current);
    }).catch(error => {
      if (!controller.signal.aborted) setStatus({ phase: 'loadError', message: error.message });
    });
    return () => controller.abort();
  }, [accountId, attempt]);

  useLayoutEffect(() => {
    const current = record.current;
    if (!current || current.latest === data) return;
    current.latest = data;
    current.cached = rememberPending(key, current);
    if (!current.conflict) setStatus({ phase: 'saving' });
  }, [data, key]);

  const flush = useCallback(async function save() {
    const current = record.current;
    if (!current || current.latest === current.saved) return;
    if (current.conflict) throw new Error('工作区在另一窗口或设备上已更新，请先处理同步冲突。');
    if (current.inFlight) {
      await current.inFlight;
      return save();
    }
    const snapshot = current.latest;
    setStatus({ phase: 'saving' });
    current.inFlight = workspaceRequest(accountId, { revision: current.revision, data: snapshot }).then(result => {
      current.revision = result.revision;
      current.saved = snapshot;
      current.cached = rememberPending(key, current);
      setStatus({ phase: current.latest === snapshot ? 'saved' : 'saving' });
    }).catch(error => {
      current.conflict = error.code === 'WORKSPACE_CONFLICT';
      setStatus({ phase: current.conflict ? 'conflict' : 'error', message: error.message });
      throw error;
    }).finally(() => { current.inFlight = null; });
    await current.inFlight;
    if (current.latest !== snapshot) return save();
  }, [accountId, key]);

  useEffect(() => {
    const current = record.current;
    if (!current || current.conflict || current.latest === current.saved) return;
    const timer = setTimeout(() => void flush().catch(() => {}), 350);
    return () => clearTimeout(timer);
  }, [data, flush]);

  useEffect(() => {
    if (!accountId) return;
    function background() {
      if (document.visibilityState === 'hidden') void flush().catch(() => {});
    }
    function warn(event) {
      const current = record.current;
      if (current && current.latest !== current.saved && !current.cached) event.preventDefault();
    }
    document.addEventListener('visibilitychange', background);
    window.addEventListener('beforeunload', warn);
    return () => {
      document.removeEventListener('visibilitychange', background);
      window.removeEventListener('beforeunload', warn);
    };
  }, [accountId, flush]);

  function discardPending() {
    try { sessionStorage.removeItem(key); } catch { /* 存储不可用时只丢弃本页待同步修改。 */ }
    record.current = null;
    setData(null);
    setAttempt(value => value + 1);
  }

  function exportPending() {
    const draft = record.current?.latest;
    if (!draft) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(draft, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = '会序-待同步工作区.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  return { data, setData, status, flush, retryLoad: () => setAttempt(value => value + 1), discardPending, exportPending };
}
