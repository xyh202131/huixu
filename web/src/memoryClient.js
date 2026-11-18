import { sessionExpired } from './authClient';
import { browserModel } from './browserModels';

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

export function importSource(eventId, file, agentAccess, replacementId) {
  return memoryRequest(eventId, { name: file.name, agent: agentAccess ? '1' : '0', ...(replacementId && { view: 'replace', source: replacementId }) }, {
    method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file,
  });
}

export async function organizationRequest(eventId, method = 'GET', signal, ownerId) {
  if (method === 'POST' && !ownerId) throw new Error('请先登录负责人账号再整理资料。');
  const connection = method === 'POST' ? await browserModel('organization', ownerId) : null;
  const response = await fetch('/api/project-organization?' + new URLSearchParams({ event: eventId }), {
    method, signal, ...(connection && { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ connection }) }),
  });
  if (response.status === 401) window.dispatchEvent(new Event(sessionExpired));
  if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('本机智能整理接口不可用。');
  const result = await response.json();
  if (!response.ok) throw new Error(result.error ?? '智能整理失败。');
  return result;
}
