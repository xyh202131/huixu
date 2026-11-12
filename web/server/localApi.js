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
