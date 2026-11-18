import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { betterAuth } from 'better-auth';
import { getMigrations } from 'better-auth/db/migration';
import { fromNodeHeaders } from 'better-auth/node';
import { isWorkbenchRequest, readBody, sendJson } from './localApi.js';
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

function codeMatches(input, expected) {
  const digest = value => createHash('sha256').update(value).digest();
  return typeof input === 'string' && timingSafeEqual(digest(input), digest(expected));
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

export function createWorkbenchAuth(root, databaseOverride, { publicOrigin, setupCode, signupCode } = {}) {
  const databasePath = localDatabasePath(root, databaseOverride, 'auth.sqlite');
  const cookiePrefix = 'huixu-' + createHash('sha256').update(databasePath).digest('hex').slice(0, 10);
  let connection;
  let ready;
  const registrationEnabled = Boolean(signupCode?.length >= 32 && signupCode !== setupCode);

  function recordPrimaryOwner() {
    connection.exec(`INSERT OR IGNORE INTO huixu_auth_config (key, value)
      SELECT 'primary_owner', id FROM "user" ORDER BY "createdAt", id LIMIT 1`);
  }

  function publicUser(user) {
    if (!user) return null;
    const primary = connection.prepare("SELECT value FROM huixu_auth_config WHERE key = 'primary_owner'").get();
    return { id: user.id, name: user.name, email: user.email, ...(user.id === primary?.value && { legacyWorkspace: true }) };
  }

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
      baseURL: publicOrigin || { allowedHosts: loopbackHosts, protocol: 'http' },
      ...(publicOrigin && { trustedOrigins: [publicOrigin] }),
      database: connection,
      secret,
      emailAndPassword: { enabled: true, autoSignIn: false, minPasswordLength: 12, maxPasswordLength: 128 },
      session: { expiresIn: sessionLifetime, disableSessionRefresh: true },
      rateLimit: { enabled: true, customRules: { '/sign-in/email': { window: 60, max: 8 } } },
      advanced: {
        cookiePrefix,
        ipAddress: { ipAddressHeaders: ['x-huixu-client-ip'] },
        // 魔搭账号页和应用分属不同站点。仅云端使用分区 Cookie，允许在创空间内保持会话。
        ...(publicOrigin && { defaultCookieAttributes: { sameSite: 'none', partitioned: true } }),
      },
      logger: { disabled: true },
    });
    const migration = await getMigrations(auth.options);
    await migration.runMigrations();
    recordPrimaryOwner();
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
    return Boolean(connection.prepare("SELECT 1 FROM huixu_auth_config WHERE key = 'primary_owner'").get());
  }

  async function session(request, response) {
    if (!isWorkbenchRequest(request)) return sendJson(response, 403, { error: '请通过会序工作台访问。' });
    const path = new URL(request.url, 'http://localhost').pathname;
    const registering = path === '/register';
    if (!registering && path !== '/') return sendJson(response, 404, { error: '没有此账号操作。' });
    if (request.method !== 'POST' && (registering || request.method !== 'GET')) return sendJson(response, 405, { error: '不支持此操作。' });
    try {
      const auth = await getAuth();
      const ownerExists = hasOwner();
      if (request.method === 'GET') return sendJson(response, 200, { user: await currentUser(request, auth), setupRequired: !ownerExists,
        ...(publicOrigin && { setupCodeRequired: true }), ...(ownerExists && registrationEnabled && { signupEnabled: true }) });

      const data = await readAccountInput(request);
      if (data.error) return sendJson(response, data.status, { error: data.error });
      if (registering) {
        if (!ownerExists || !registrationEnabled) return sendJson(response, 403, { error: '当前未开放邀请码注册。' });
        if (!codeMatches(data.input.signupCode, signupCode)) return sendJson(response, 403, { error: '注册邀请码无效。' });
        if (await currentUser(request, auth)) return sendJson(response, 409, { error: '请先退出当前账号。' });
      } else if (publicOrigin && !ownerExists) {
        if (!setupCode || setupCode.length < 32) return sendJson(response, 503, { error: '请在创空间设置中配置至少 32 位的负责人初始化码。' });
        if (!codeMatches(data.input.setupCode, setupCode)) return sendJson(response, 403, { error: '负责人初始化码无效。' });
      }
      const { name, email, password } = data.input;
      if (typeof name !== 'string' || !name.trim() || name.trim().length > 60 || typeof email !== 'string' ||
          !email.trim() || email.trim().length > 254 || typeof password !== 'string' || password.length < 12 || password.length > 128) {
        return sendJson(response, 400, { error: '请填写姓名、邮箱和 12–128 位密码。' });
      }
      async function createAccount() {
        const created = await auth.api.signUpEmail({
          body: { name: name.trim(), email: email.trim().toLowerCase(), password },
          headers: authHeaders(request), asResponse: true,
        });
        if (!created.ok) return sendJson(response, 400, { error: '账号创建失败，请核对邮箱和密码，或使用已有账号登录。' });
        if (!registering) recordPrimaryOwner();
        return sendJson(response, 201, { created: true });
      }
      if (registering) return await createAccount();
      const token = randomUUID();
      const now = Date.now();
      // 首次设置可能同时从两个页面提交，用数据库租约保证只有一个请求创建账号。
      const lease = connection.prepare(`INSERT INTO huixu_owner_setup (id, token, expires_at)
        SELECT 1, ?, ? WHERE NOT EXISTS (SELECT 1 FROM "user")
        ON CONFLICT(id) DO UPDATE SET token = excluded.token, expires_at = excluded.expires_at
        WHERE huixu_owner_setup.expires_at < ?`).run(token, now + setupLease, now);
      if (!lease.changes) return sendJson(response, 409, { error: '工作台已有账号，或另一个窗口正在设置账号。' });
      try {
        return await createAccount();
      } finally {
        connection.prepare('DELETE FROM huixu_owner_setup WHERE id = 1 AND token = ?').run(token);
      }
    } catch {
      if (!response.headersSent) sendJson(response, 500, { error: '本机账号服务暂时不可用。' });
    }
  }

  async function handle(request, response) {
    if (!isWorkbenchRequest(request)) return sendJson(response, 403, { error: '请通过会序工作台访问。' });
    const path = new URL(request.url, 'http://localhost').pathname;
    if (!nativePaths.has(path)) return sendJson(response, 404, { error: '没有此账号操作。' });
    if (request.method !== 'POST') return sendJson(response, 405, { error: '不支持此操作。' });

    try {
      const data = await readAccountInput(request);
      if (data.error) return sendJson(response, data.status, { error: data.error });
      const auth = await getAuth();
      const requestedAccount = request.headers['x-huixu-account'];
      if (path === '/sign-out' && requestedAccount !== undefined && requestedAccount !== (await currentUser(request, auth))?.id) {
        return sendJson(response, 401, { error: '当前账号已切换，正在刷新工作台。' });
      }
      const headers = authHeaders(request);
      headers.delete('content-length');
      const input = path === '/sign-in/email' ? { email: data.input.email, password: data.input.password } : {};
      const result = await auth.handler(new Request((publicOrigin || 'http://' + request.headers.host) + authPath + path, {
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
      if (!isWorkbenchRequest(request)) return sendJson(response, 403, { error: '请通过会序工作台访问。' });
      if (!request.headers.cookie) return sendJson(response, 401, { error: '请先登录会序。' });
      let user;
      try {
        user = await currentUser(request, await getAuth());
        if (!user) return sendJson(response, 401, { error: '登录已失效，请重新登录。' });
        const requestedAccount = request.headers['x-huixu-account'];
        if (requestedAccount !== undefined && requestedAccount !== user.id) {
          return sendJson(response, 401, { error: '当前账号已切换，请重新打开工作台。' });
        }
      } catch {
        return sendJson(response, 503, { error: '暂时无法验证登录状态。' });
      }
      return handler(request, response, user);
    };
  }

  function close() {
    connection?.close();
    connection = undefined;
    ready = undefined;
  }

  return { handle, session, requireSession, close };
}
