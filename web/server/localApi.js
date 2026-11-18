import { workbenchMethodHeader } from '../src/workbenchFetch.js';

const hostedRequests = new WeakSet();
const writableRoutes = new Set(['/api/registration', '/api/project-memory', '/api/model-settings']);

export function restoreHostedMethod(request, route) {
  const method = request.headers[workbenchMethodHeader.toLowerCase()];
  if (method === undefined) return true;
  // 魔搭转发层拦截 PATCH。仅将同源的 POST 恢复为指定受保护接口的更新或撤销操作。
  if (!hostedRequests.has(request) || request.method !== 'POST' || !writableRoutes.has(route) ||
      !['PATCH', 'DELETE'].includes(method)) return false;
  request.method = method;
  return true;
}

export function allowHostedRequest(request, origin) {
  const supplied = request.headers.origin;
  const readOnly = request.method === 'GET' || request.method === 'HEAD';
  // 创空间代理会改写 Host。只信任部署时配置的应用源，不读取转发头来猜测。
  if (!origin || (supplied !== origin && !(readOnly && supplied === undefined))) return false;
  hostedRequests.add(request);
  return true;
}

export function isWorkbenchRequest(request) {
  return hostedRequests.has(request) || isLocalRequest(request);
}

export function isLocalRequest(request) {
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(request.socket.remoteAddress)) return false;
  const host = request.headers.host;
  if (!/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(host ?? '')) return false;
  const origin = request.headers.origin;
  return !origin || origin === `http://${host}` || origin === `https://${host}`;
}

export function sendJson(response, status, data) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(data));
}

export async function readBody(request, maxBytes) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    length += chunk.length;
    if (length > maxBytes) {
      request.resume();
      return null;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
