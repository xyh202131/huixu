export { sourceAccept } from './sourceFormats';

export function memoryUrl(eventId, parameters = {}) {
  return '/api/project-memory?' + new URLSearchParams({ event: eventId, ...parameters });
}

export async function memoryRequest(eventId, parameters, options) {
  const response = await fetch(memoryUrl(eventId, parameters), options);
  if (response.status === 401) window.dispatchEvent(new Event(sessionExpired));
  if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('本机资料索引接口不可用。');
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? '本机资料索引请求失败。');
  return result;
}

export function importSource(eventId, file, agentAccess) {
  return memoryRequest(eventId, { name: file.name, agent: agentAccess ? '1' : '0' }, {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file,
  });
}

export async function organizationRequest(eventId, method = 'GET', signal) {
  const response = await fetch('/api/project-organization?' + new URLSearchParams({ event: eventId }), { method, signal });
  if (response.status === 401) window.dispatchEvent(new Event(sessionExpired));
  if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('本机智能整理接口不可用。');
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? '智能整理失败。');
  return result;
}
import { sessionExpired } from './authClient';
