import assert from 'node:assert/strict';
import { mkdtemp, unlink, rmdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createWorkbenchAuth } from './auth.js';
import { sendJson } from './localApi.js';

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
