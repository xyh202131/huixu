import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { betterAuth } from 'better-auth';
import { getMigrations } from 'better-auth/db/migration';
import { fromNodeHeaders } from 'better-auth/node';
import { isLocalRequest, readBody, sendJson } from './localApi.js';
import { localDatabasePath } from './localData.js';

const authPath = '/api/auth';
const sessionLifetime = 7 * 24 * 60 * 60;
const setupLease = 5 * 60 * 1000;
const loopbackHosts = ['127.0.0.1', 'localhost', '[::1]'].flatMap(host => [host, host + ':*']);
const nativePaths = new Set(['/sign-in/email', '/sign-out']);

function authHeaders(request) {
  const headers = fromNodeHeaders(request.headers);
  headers.set('x-huixu-client-ip', request.socket.remoteAddress);
  return headers;
}

function publicUser(user) {
  return user ? { id: user.id, name: user.name, email: user.email } : null;
}

async function readAccountInput(request) {
  const type = request.headers['content-type']?.split(';', 1)[0];
  if (type !== 'application/json') return { status: 415, error: '请提交 JSON 格式的账号信息。' };
  const body = await readBody(request, 4096);
  if (!body) return { status: 413, error: '请求内容过大。' };
  try {
    const input = JSON.parse(body.toString('utf8'));
    if (input && typeof input === 'object' && !Array.isArray(input)) return { input };
  } catch { /* 统一返回格式错误。 */ }
  return { status: 400, error: '请求内容无效。' };
}

export function createWorkbenchAuth(root, databaseOverride) {
  const databasePath = localDatabasePath(root, databaseOverride, 'auth.sqlite');
  const cookiePrefix = 'huixu-' + createHash('sha256').update(databasePath).digest('hex').slice(0, 10);
  let connection;
  let ready;

  async function initialize() {
    mkdirSync(dirname(databasePath), { recursive: true });
    connection = new DatabaseSync(databasePath);
    connection.exec(`
      PRAGMA busy_timeout = 5000;
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS huixu_auth_config (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS huixu_owner_setup (
        id INTEGER PRIMARY KEY CHECK (id = 1), token TEXT NOT NULL, expires_at INTEGER NOT NULL
      );
    `);
    connection.prepare('INSERT OR IGNORE INTO huixu_auth_config VALUES (?, ?)').run('secret', randomBytes(32).toString('base64url'));
    const { value: secret } = connection.prepare('SELECT value FROM huixu_auth_config WHERE key = ?').get('secret');
    const auth = betterAuth({
      appName: '会序',
      basePath: authPath,
      baseURL: { allowedHosts: loopbackHosts, protocol: 'http' },
      database: connection,
      secret,
      emailAndPassword: { enabled: true, autoSignIn: false, minPasswordLength: 12, maxPasswordLength: 128 },
      session: { expiresIn: sessionLifetime, disableSessionRefresh: true },
      rateLimit: { enabled: true, customRules: { '/sign-in/email': { window: 60, max: 8 } } },
      advanced: { cookiePrefix, ipAddress: { ipAddressHeaders: ['x-huixu-client-ip'] } },
      logger: { disabled: true },
    });
    const migration = await getMigrations(auth.options);
    await migration.runMigrations();
    return auth;
  }

  function getAuth() {
    ready ??= initialize().catch(error => {
      connection?.close();
      connection = undefined;
      ready = undefined;
      throw error;
    });
    return ready;
  }

  async function currentUser(request, auth) {
    if (!request.headers.cookie) return null;
    const session = await auth.api.getSession({ headers: authHeaders(request) });
    return publicUser(session?.user);
  }

  function hasOwner() {
    return Boolean(connection.prepare('SELECT 1 FROM "user" LIMIT 1').get());
  }

  async function session(request, response) {
    if (!isLocalRequest(request)) return sendJson(response, 403, { error: '登录仅供本机工作台访问。' });
    if (new URL(request.url, 'http://localhost').pathname !== '/') return sendJson(response, 404, { error: '没有此账号操作。' });
    if (!['GET', 'POST'].includes(request.method)) return sendJson(response, 405, { error: '不支持此操作。' });
    try {
      const auth = await getAuth();
      if (request.method === 'GET') return sendJson(response, 200, { user: await currentUser(request, auth), setupRequired: !hasOwner() });

      const data = await readAccountInput(request);
      if (data.error) return sendJson(response, data.status, { error: data.error });
      const { name, email, password } = data.input;
      if (typeof name !== 'string' || !name.trim() || name.trim().length > 60 || typeof email !== 'string' ||
          !email.trim() || email.trim().length > 254 || typeof password !== 'string' || password.length < 12 || password.length > 128) {
        return sendJson(response, 400, { error: '请填写姓名、邮箱和 12–128 位密码。' });
      }
      const token = randomUUID();
      const now = Date.now();
      // 首次设置可能同时从两个页面提交，用数据库租约保证只有一个请求创建账号。
      const lease = connection.prepare(`INSERT INTO huixu_owner_setup (id, token, expires_at)
        SELECT 1, ?, ? WHERE NOT EXISTS (SELECT 1 FROM "user")
        ON CONFLICT(id) DO UPDATE SET token = excluded.token, expires_at = excluded.expires_at
        WHERE huixu_owner_setup.expires_at < ?`).run(token, now + setupLease, now);
      if (!lease.changes) return sendJson(response, 409, { error: '工作台已有账号，或另一个窗口正在设置账号。' });
      try {
        const created = await auth.api.signUpEmail({
          body: { name: name.trim(), email: email.trim().toLowerCase(), password },
          headers: authHeaders(request), asResponse: true,
        });
        if (!created.ok) return sendJson(response, 400, { error: '账号创建失败，请核对邮箱和密码。' });
        return sendJson(response, 201, { created: true });
      } finally {
        connection.prepare('DELETE FROM huixu_owner_setup WHERE id = 1 AND token = ?').run(token);
      }
    } catch {
      if (!response.headersSent) sendJson(response, 500, { error: '本机账号服务暂时不可用。' });
    }
  }

  async function handle(request, response) {
    if (!isLocalRequest(request)) return sendJson(response, 403, { error: '登录仅供本机工作台访问。' });
    const path = new URL(request.url, 'http://localhost').pathname;
    if (!nativePaths.has(path)) return sendJson(response, 404, { error: '没有此账号操作。' });
    if (request.method !== 'POST') return sendJson(response, 405, { error: '不支持此操作。' });

    try {
      const data = await readAccountInput(request);
      if (data.error) return sendJson(response, data.status, { error: data.error });
      const auth = await getAuth();
      const headers = authHeaders(request);
      headers.delete('content-length');
      const input = path === '/sign-in/email' ? { email: data.input.email, password: data.input.password } : {};
      const result = await auth.handler(new Request('http://' + request.headers.host + authPath + path, {
        method: 'POST', headers, body: JSON.stringify(input),
      }));
      const cookies = result.headers.getSetCookie();
      if (cookies.length) response.setHeader('Set-Cookie', cookies);
      if (result.ok) {
        if (path === '/sign-out') return sendJson(response, 200, { user: null });
        const payload = await result.json();
        return sendJson(response, 200, { user: publicUser(payload.user) });
      }
      if (result.status === 429) {
        const retryAfter = result.headers.get('retry-after');
        if (retryAfter) response.setHeader('Retry-After', retryAfter);
        return sendJson(response, 429, { error: '登录尝试过多，请稍后重试。' });
      }
      if (result.status >= 500) return sendJson(response, 500, { error: '本机账号服务暂时不可用。' });
      const error = path === '/sign-out' ? '退出失败，请刷新后重试。' : '邮箱或密码不正确。';
      return sendJson(response, result.status, { error });
    } catch {
      if (!response.headersSent) sendJson(response, 500, { error: '本机账号服务暂时不可用。' });
    }
  }

  function requireSession(handler) {
    return async (request, response) => {
      if (!isLocalRequest(request)) return sendJson(response, 403, { error: '此接口仅供本机工作台访问。' });
      if (!request.headers.cookie) return sendJson(response, 401, { error: '请先登录会序。' });
      try {
        if (!await currentUser(request, await getAuth())) return sendJson(response, 401, { error: '登录已失效，请重新登录。' });
      } catch {
        return sendJson(response, 503, { error: '暂时无法验证登录状态。' });
      }
      return handler(request, response);
    };
  }

  function close() {
    connection?.close();
    connection = undefined;
    ready = undefined;
  }

  return { handle, session, requireSession, close };
}
