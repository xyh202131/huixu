import assert from 'node:assert/strict';
import { mkdtemp, unlink, rmdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createWorkbenchAuth } from './auth.js';
import { allowHostedRequest, restoreHostedMethod, sendJson } from './localApi.js';

test('首次建号、会话保护和退出撤销', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'huixu-auth-test-'));
  const database = join(directory, 'auth.sqlite');
  const auth = createWorkbenchAuth(process.cwd(), database);
  const protectedRoute = auth.requireSession((request, response) => sendJson(response, 200, { allowed: true }));
  const server = createServer((request, response) => {
    if (request.url.startsWith('/api/auth/')) {
      request.url = request.url.slice('/api/auth'.length);
      return auth.handle(request, response);
    }
    if (request.url === '/api/workbench-session') {
      request.url = '/';
      return auth.session(request, response);
    }
    return protectedRoute(request, response);
  });
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    auth.close();
    for (const path of [database, database + '-shm', database + '-wal']) {
      await unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
    await rmdir(directory);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + server.address().port;
  function request(path, { input, cookie, requestOrigin = origin } = {}) {
    const headers = { Origin: requestOrigin };
    if (cookie) headers.Cookie = cookie;
    if (input === undefined) return fetch(origin + path, { headers });
    headers['Content-Type'] = 'application/json';
    return fetch(origin + path, { method: 'POST', headers, body: JSON.stringify(input) });
  }

  const statusPath = '/api/workbench-session';
  const credentials = { email: 'owner@example.test', password: 'Example-only-Local-826!', name: '演练负责人' };
  assert.deepEqual(await (await request(statusPath)).json(), { user: null, setupRequired: true });
  assert.equal((await request('/private')).status, 401);
  assert.equal((await request(statusPath, { input: credentials, requestOrigin: 'https://example.test' })).status, 403);
  assert.equal((await request('/api/auth/sign-up/email', { input: credentials })).status, 404);
  const attempts = await Promise.all([request(statusPath, { input: credentials }), request(statusPath, { input: credentials })]);
  assert.deepEqual(attempts.map(response => response.status).sort(), [201, 409]);
  assert.equal((await request(statusPath, { input: { ...credentials, email: 'second@example.test' } })).status, 409);
  assert.equal((await request('/api/auth/sign-in/email', { input: { ...credentials, password: 'wrong-password-123' } })).status, 401);

  const login = await request('/api/auth/sign-in/email', { input: credentials });
  assert.equal(login.status, 200);
  const signedIn = await login.json();
  assert.deepEqual(Object.keys(signedIn), ['user']);
  assert.equal(signedIn.user.name, credentials.name);
  const cookies = login.headers.getSetCookie();
  assert.ok(cookies.some(cookie => cookie.includes('HttpOnly') && cookie.includes('SameSite=Lax')));
  const cookie = cookies.map(item => item.split(';', 1)[0]).join('; ');
  assert.equal((await request('/private', { cookie })).status, 200);
  assert.equal((await request('/private', { cookie, requestOrigin: 'https://example.test' })).status, 403);
  assert.deepEqual(await (await request(statusPath, { cookie })).json(), { user: signedIn.user, setupRequired: false });
  assert.equal((await request('/api/auth/sign-out', { input: {}, cookie })).status, 200);
  assert.equal((await request('/private', { cookie })).status, 401);

  let limited = false;
  for (let attempt = 0; attempt < 9; attempt += 1) {
    const response = await request('/api/auth/sign-in/email', { input: { ...credentials, password: 'wrong-password-123' } });
    if (response.status === 429) {
      limited = true;
      break;
    }
    assert.equal(response.status, 401);
  }
  assert.ok(limited, '连续失败的登录请求应触发限流');
});

test('创空间只采用部署预设的首位负责人，重启保留原账号及 HTTPS 会话', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'huixu-studio-auth-'));
  const database = join(directory, 'auth.sqlite');
  const publicOrigin = 'https://example.ms.show';
  const signupCode = 'fixture-invite-abcdefghijklmnopqrstuv';
  let auth = createWorkbenchAuth(process.cwd(), database, { publicOrigin, signupCode });
  const server = createServer((request, response) => {
    if (!allowHostedRequest(request, publicOrigin)) return sendJson(response, 403, {});
    if (request.url === '/session' || request.url === '/session/register') {
      request.url = request.url.slice('/session'.length) || '/';
      return auth.session(request, response);
    }
    return auth.handle(request, response);
  });
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    auth.close();
    await unlink(database);
    await rmdir(directory);
  });
  await new Promise(resolve => server.listen(0, '::1', resolve));
  const url = 'http://[::1]:' + server.address().port;
  function post(path, input, origin = publicOrigin) {
    return fetch(url + path, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
  }
  function loadSession(cookie) {
    return fetch(url + '/session', { headers: cookie ? { Cookie: cookie } : {} }).then(response => response.json());
  }
  const credentials = { email: 'owner@example.test', password: 'Fixture-only-studio-123!' };
  const visitor = { ...credentials, email: 'visitor@example.test', name: '演练访客' };
  assert.deepEqual(await loadSession(), { user: null, setupRequired: false, ownerSetupPending: true });
  assert.equal((await post('/session', visitor, 'https://other.example.test')).status, 403);
  assert.equal((await post('/session', visitor)).status, 403);
  assert.equal((await post('/session/register', { ...visitor, signupCode })).status, 403);

  auth.close();
  auth = createWorkbenchAuth(process.cwd(), database, { publicOrigin, signupCode,
    ownerEmail: ' OWNER@example.test ', ownerPassword: credentials.password });
  assert.deepEqual(await loadSession(), { user: null, setupRequired: false, signupEnabled: true });
  assert.equal((await post('/session', visitor)).status, 403);
  const signIn = await post('/sign-in/email', credentials);
  assert.equal(signIn.status, 200);
  const cookies = signIn.headers.getSetCookie();
  assert.ok(cookies.some(cookie => /; Secure(?:;|$)/i.test(cookie) && cookie.includes('HttpOnly') &&
    /; SameSite=None(?:;|$)/i.test(cookie) && /; Partitioned(?:;|$)/i.test(cookie)));
  const cookie = cookies.map(value => value.split(';', 1)[0]).join('; ');
  const { user } = await loadSession(cookie);
  assert.equal(user.email, credentials.email);
  assert.equal(user.legacyWorkspace, true);
  assert.equal((await post('/session/register', { ...visitor, signupCode })).status, 201);

  auth.close();
  auth = createWorkbenchAuth(process.cwd(), database, { publicOrigin, ownerEmail: 'other@example.test',
    ownerPassword: 'Fixture-only-different-owner-123!' });
  assert.deepEqual((await loadSession(cookie)).user, user);
  assert.equal((await post('/sign-in/email', credentials)).status, 200);
  assert.equal((await post('/sign-in/email', { email: 'other@example.test', password: 'Fixture-only-different-owner-123!' })).status, 401);
});

test('创空间仅允许同源写请求转换受保护接口的方法', () => {
  const origin = 'https://example.ms.show';
  const request = { method: 'POST', headers: { origin, 'x-huixu-method': 'PATCH' } };
  assert.equal(restoreHostedMethod(request, '/api/registration'), false);
  assert.equal(allowHostedRequest(request, origin), true);
  assert.equal(restoreHostedMethod(request, '/api/registration-public'), false);
  assert.equal(restoreHostedMethod(request, '/api/registration'), true);
  assert.equal(request.method, 'PATCH');
  const invalid = { method: 'POST', headers: { origin, 'x-huixu-method': 'GET' } };
  assert.equal(allowHostedRequest(invalid, origin), true);
  assert.equal(restoreHostedMethod(invalid, '/api/project-memory'), false);
});
