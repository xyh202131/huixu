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
      else if (action === 'draft' && !id && method === 'GET') result = store.readDraft(owner, eventId);
      else if (action === 'draft' && !id && method === 'PUT') result = store.saveDraft(owner, eventId, await readJson(request, 1024 * 1024));
      else if (action === 'handoff' && !id && method === 'POST') {
        const link = store.issueHandoff(owner, eventId);
        result = { url: (mail.origin || 'http://' + request.headers.host) + '/#/tasks/' + link.token };
      } else if (action === 'handoff' && !id && method === 'DELETE') result = store.revokeHandoff(owner, eventId);
      else if (action === 'guests' && !id && method === 'POST') {
        const link = store.guests.issue(owner, eventId, await readJson(request));
        result = { url: (mail.origin || 'http://' + request.headers.host) + '/#/guest/' + link.token, expires: link.expires };
      } else if (action === 'guests' && id && !operation && method === 'DELETE') {
        result = store.guests.revoke(owner, eventId, id);
      } else if (action === 'guests' && id && operation === 'file' && method === 'GET') {
        const file = store.guests.download(owner, eventId, id);
        response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff', 'Content-Disposition': "attachment; filename*=UTF-8''" + encodeURIComponent(file.filename) });
        return response.end(Buffer.from(file.attachment));
      }
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

export function guestUploadLimiter(now = Date.now) {
  const counters = new Map();
  let active = 0;
  return function reserve(token, address) {
    if (active >= 4) throw new RegistrationError(429, '正在接收其他课件，请稍后重试。');
    const time = now();
    // 同一窗口内不续期，按插入顺序清理已到期的计数。
    for (const [key, entry] of counters) {
      if (time < entry.until) break;
      counters.delete(key);
    }
    const keys = ['link:' + token, 'ip:' + address];
    if ((counters.get(keys[0])?.count ?? 0) >= 12 || (counters.get(keys[1])?.count ?? 0) >= 60) {
      throw new RegistrationError(429, '课件提交过于频繁，请稍后重试。');
    }
    for (const key of keys) {
      const entry = counters.get(key) ?? { count: 0, until: time + 60000 };
      entry.count += 1;
      counters.set(key, entry);
    }
    active += 1;
    return () => { active -= 1; };
  };
}

export function registrationPublicApi(store, origin) {
  const attempts = new Map();
  const reserveGuestUpload = guestUploadLimiter();
  return async (request, response) => {
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Robots-Tag', 'noindex, nofollow');
    try {
      const [section, id, extra] = new URL(request.url, 'http://localhost').pathname.split('/').filter(Boolean);
      const token = request.headers['x-huixu-confirmation'];
      if (extra || (section === 'events' ? !id : id) ||
          !['events', 'attendance', 'guest', 'handoff'].includes(section)) throw new RegistrationError(404, '活动链接不可用。');
      if (request.method === 'GET') {
        if (section === 'handoff') return sendJson(response, 200, store.taskHandoff(token));
        if (section === 'guest') return sendJson(response, 200, store.guests.view(token));
        const result = section === 'events' ? store.publicEvent(id) : store.confirmation(token);
        return sendJson(response, 200, result);
      }
      if (request.method !== 'POST') throw new RegistrationError(405, '不支持此操作。');
      const requestOrigin = request.headers.origin;
      if (!isLocalRequest(request) && (!origin || requestOrigin !== origin || request.headers.host !== new URL(origin).host)) {
        throw new RegistrationError(403, '请从活动确认页提交。');
      }
      if (section === 'guest') {
        store.guests.view(token);
        const release = reserveGuestUpload(token, request.socket.remoteAddress);
        try {
          let details;
          try { details = JSON.parse(decodeURIComponent(request.headers['x-huixu-submission'])); } catch { throw new RegistrationError(400, '课件提交信息无效。'); }
          if (!details || typeof details !== 'object') throw new RegistrationError(400, '课件提交信息无效。');
          const maxBytes = 16 * 1024 * 1024;
          if (Number(request.headers['content-length']) > maxBytes) throw new RegistrationError(413, '课件上限为 16 MB。');
          const bytes = await readBody(request, maxBytes);
          if (!bytes) throw new RegistrationError(413, '课件上限为 16 MB。');
          return sendJson(response, 200, store.guests.submit(token, details, bytes));
        } finally {
          release();
        }
      }
      const input = await readJson(request, 4096);
      if (section === 'handoff') return sendJson(response, 200, store.taskHandoff(token, input));
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
