import { isLocalRequest, readBody, sendJson } from './localApi.js';
import { registrationSpreadsheet } from './registrationImport.js';
import { RegistrationError, validId } from './registrationStore.js';

async function readJson(request, limit = 16000) {
  if (request.headers['content-type']?.split(';')[0] !== 'application/json') {
    throw new RegistrationError(415, '请提交 JSON 数据。');
  }
  const body = await readBody(request, limit);
  if (!body) throw new RegistrationError(413, '请求过大。');
  try {
    const input = JSON.parse(body.toString('utf8'));
    if (input && typeof input === 'object' && !Array.isArray(input)) return input;
  } catch {
    // 下方统一返回格式错误。
  }
  throw new RegistrationError(400, '请求格式无效。');
}

function respondError(response, error) {
  if (response.destroyed || response.headersSent) return;
  if (error instanceof RegistrationError) return sendJson(response, error.status, { error: error.message });
  return sendJson(response, 500, { error: '报名服务暂时不可用，请稍后重试。' });
}

export function registrationOwnerApi(store, mail) {
  return async (request, response, user) => {
    try {
      const owner = user.id;
      const url = new URL(request.url, 'http://localhost');
      const [section, eventId, action, id, operation, extra] = url.pathname.split('/').filter(Boolean);
      const method = request.method;
      let result;
      if (section !== 'events' || extra || (eventId && !validId(eventId)) || (id && !validId(id))) {
        throw new RegistrationError(404, '接口不存在。');
      }
      if (!eventId && method === 'GET') result = { events: store.list(owner) };
      else if (!eventId && method === 'POST') result = store.open(owner, await readJson(request, 180000));
      else if (!action && method === 'GET') result = store.get(owner, eventId);
      else if (action === 'people' && (method === 'PATCH' && id && !operation || method === 'POST' && !id)) {
        result = store.savePerson(owner, eventId, id, await readJson(request));
      } else if ((action === 'settings' || action === 'schedule') && method === 'PATCH' && !id) {
        result = store.changeEvent(owner, eventId, await readJson(request, 180000), action === 'schedule');
      } else if (action === 'checkins' && method === 'POST' && !id) {
        result = store.checkIn(owner, eventId, await readJson(request));
      } else if (action === 'checkins' && method === 'POST' && id === 'migrate' && !operation) {
        const input = await readJson(request, 512 * 1024);
        result = store.migrateCheckins(owner, eventId, input.records);
      } else if (action === 'actual' && method === 'POST' && !id) {
        result = store.recordActual(owner, eventId, await readJson(request));
      } else if (action === 'rescue' && method === 'POST' && !operation) {
        if (id === 'preview') result = store.rescuePreview(owner, eventId, await readJson(request, 512 * 1024));
        else if (id === 'publish') result = store.publishRescue(owner, eventId, await readJson(request, 128 * 1024));
      } else if (action === 'links' && id && method === 'POST' && !operation) {
        const link = store.issueLink(owner, eventId, id);
        const origin = mail.origin || 'http://' + request.headers.host;
        result = { url: origin + '/#/attendance/' + link.token, expires: link.expires, local: !mail.origin };
      } else if (action === 'links' && id && method === 'DELETE' && !operation) {
        result = store.revoke(owner, eventId, id);
      } else if (action === 'mail' && !id && method === 'GET') {
        result = mail.records(owner, eventId);
      } else if (action === 'mail' && id && method === 'POST') {
        if (operation === 'preview') result = mail.preview(owner, eventId, id);
        else if (operation === 'send' || operation === 'retry') result = await mail.send(owner, eventId, id, operation === 'retry');
        else if (operation === 'refresh') result = await mail.refresh(owner, eventId, id);
      } else if (action === 'import' && method === 'POST' && !operation) {
        if (id === 'file') {
          store.get(owner, eventId);
          const file = await readBody(request, 4 * 1024 * 1024);
          if (!file) throw new RegistrationError(413, '名单文件须小于 4 MB。');
          result = store.importPeople(owner, eventId, await registrationSpreadsheet(url.searchParams.get('name') ?? '', file));
        } else if (id === 'preview' || id === 'commit') {
          const input = await readJson(request, 2 * 1024 * 1024);
          if (id === 'commit' && typeof input.previewKey !== 'string') throw new RegistrationError(400, '请先预览名单。');
          result = store.importPeople(owner, eventId, input.rows, id === 'commit' ? input.previewKey : undefined);
        }
      }
      if (!result) throw new RegistrationError(404, '接口不存在。');
      if (result.event) result.publicOrigin = mail.origin;
      if (result.state) result.state.publicOrigin = mail.origin;
      if (!response.destroyed) return sendJson(response, 200, result);
    } catch (error) {
      return respondError(response, error);
    }
  };
}

export function registrationPublicApi(store, origin) {
  const attempts = new Map();
  return async (request, response) => {
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Robots-Tag', 'noindex, nofollow');
    try {
      const [section, id, extra] = new URL(request.url, 'http://localhost').pathname.split('/').filter(Boolean);
      const token = request.headers['x-huixu-confirmation'];
      if (extra || (section === 'events' && !id) || (section === 'attendance' && id) ||
          !['events', 'attendance'].includes(section)) throw new RegistrationError(404, '活动链接不可用。');
      if (request.method === 'GET') {
        const result = section === 'events' ? store.publicEvent(id) : store.confirmation(token);
        return sendJson(response, 200, result);
      }
      if (request.method !== 'POST') throw new RegistrationError(405, '不支持此操作。');
      const requestOrigin = request.headers.origin;
      if (!isLocalRequest(request) && (!origin || requestOrigin !== origin || request.headers.host !== new URL(origin).host)) {
        throw new RegistrationError(403, '请从活动确认页提交。');
      }
      const input = await readJson(request, 4096);
      if (section === 'attendance') return sendJson(response, 200, store.respond(token, input));
      const now = Date.now();
      for (const [key, entry] of attempts) if (entry.until <= now) attempts.delete(key);
      const key = request.socket.remoteAddress + ':' + id;
      const counter = attempts.get(key) ?? { count: 0, until: now + 60000 };
      if (counter.count >= 30) throw new RegistrationError(429, '提交过于频繁，请稍后再试。');
      counter.count += 1;
      const result = store.publicSignup(id, input);
      attempts.set(key, counter);
      return sendJson(response, 200, result);
    } catch (error) {
      return respondError(response, error);
    }
  };
}
