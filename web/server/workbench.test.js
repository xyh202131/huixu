import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { newEvent } from '../src/model.js';
import { signupSnapshot } from '../src/registrationRules.js';
import { sendJson } from './localApi.js';
import { createWorkbench } from './workbench.js';

test('邀请码账号独立保存活动、对话、模型和资料，服务重启后能读取', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'huixu-account-test-'));
  const env = {
    HUIXU_AUTH_DB: join(directory, 'auth.sqlite'), HUIXU_REGISTRATION_DB: join(directory, 'registration.sqlite'),
    HUIXU_MEMORY_DB: join(directory, 'previous-index.sqlite'), HUIXU_MODEL_DB: join(directory, 'previous-model.sqlite'),
    HUIXU_SIGNUP_CODE: 'sample-signup-integration-1234567890',
  };
  let server;
  let base;
  async function stop() {
    if (!server) return;
    await new Promise(resolve => server.close(resolve));
    server = null;
  }
  async function start() {
    const workbench = createWorkbench(process.cwd(), env);
    server = createServer(async (request, response) => {
      const route = Object.keys(workbench.routes).find(prefix => request.url === prefix ||
        request.url.startsWith(prefix + '/') || request.url.startsWith(prefix + '?'));
      if (!route) return sendJson(response, 404, {});
      request.url = request.url.slice(route.length) || '/';
      if (request.url.startsWith('?')) request.url = '/' + request.url;
      await workbench.routes[route](request, response);
    });
    server.once('close', workbench.close);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = 'http://127.0.0.1:' + server.address().port;
  }
  t.after(async () => {
    await stop();
    await rm(directory, { recursive: true, force: true });
  });
  await start();

  async function request(path, { account, input, method, headers, body } = {}) {
    const response = await fetch(base + path, { method: method ?? (input === undefined ? 'GET' : 'POST'), headers: {
      Origin: base, ...(input !== undefined && { 'Content-Type': 'application/json' }),
      ...(account && { Cookie: account.cookie, 'X-Huixu-Account': account.id }), ...headers,
    }, body: input === undefined ? body : JSON.stringify(input) });
    return { status: response.status, result: await response.json(), cookies: response.headers.getSetCookie() };
  }
  async function login(credentials) {
    const response = await request('/api/auth/sign-in/email', { input: credentials });
    assert.equal(response.status, 200);
    return { ...response.result.user, cookie: response.cookies.map(item => item.split(';', 1)[0]).join('; ') };
  }

  const owner = { name: '演练负责人甲', email: 'owner@example.test', password: 'Fixture-Only123-owner!' };
  const member = { name: '演练负责人乙', email: 'member@example.test', password: 'Fixture-Only123-member!' };
  const session = '/api/workbench-session';
  const register = session + '/register';
  const workspace = '/api/workspace';
  const index = '/api/project-memory?event=exercise';
  const registrations = '/api/registration/events';
  assert.equal((await request(workspace)).status, 401);
  assert.equal((await request(register, { input: { ...member, signupCode: env.HUIXU_SIGNUP_CODE } })).status, 403);
  assert.equal((await request(session, { input: owner })).status, 201);
  assert.equal((await request(session)).result.signupEnabled, true);
  assert.equal((await request(register, { input: { ...member, signupCode: 'wrong' } })).status, 403);
  assert.equal((await request(register, { input: { ...member, signupCode: env.HUIXU_SIGNUP_CODE } })).status, 201);
  const a = await login(owner);
  const b = await login(member);
  assert.equal(a.legacyWorkspace, true);
  assert.equal(b.legacyWorkspace, undefined);

  const event = { ...newEvent({ title: '演练活动甲', type: '行业论坛', date: '2027-01-01', capacity: 100 }, 'exercise'),
    tasks: [{ id: 't1', name: '测试筹备任务', done: true }], history: [{ id: 'c1', title: '演练变更记录', version: 1 }] };
  const data = { events: [event], activeId: event.id,
    conversations: [[event.id, [{ eventId: event.id, question: '如何安排演练？', answer: '演练答复' }]]] };
  const initial = { accountId: a.id, revision: 0, data };
  assert.equal((await request(workspace, { account: b, input: initial })).status, 409);
  assert.equal((await request(workspace, { account: b, headers: { 'X-Huixu-Account': a.id } })).status, 401);
  assert.deepEqual((await request(workspace, { account: a, input: initial })).result, { revision: 1 });
  assert.deepEqual((await request(workspace, { account: a, input: initial })).result, { revision: 1 });
  const outdated = { ...initial, data: { ...data, conversations: [] } };
  assert.equal((await request(workspace, { account: a, input: outdated })).result.code, 'WORKSPACE_CONFLICT');
  assert.equal((await request(workspace, { account: b })).result.data, null);
  const eventB = { ...newEvent({ title: '演练活动乙', type: '企业培训', date: '', capacity: 40 }, 'exercise-b') };
  const dataB = { events: [eventB], activeId: eventB.id, conversations: [] };
  assert.deepEqual((await request(workspace, { account: b, input: { accountId: b.id, revision: 0, data: dataB } })).result, { revision: 1 });

  assert.equal((await request(registrations, { account: a, input: signupSnapshot(event) })).status, 200);
  assert.equal((await request(registrations + '/exercise', { account: b })).status, 404);
  assert.equal((await request(index + '&name=owner-notes.md&agent=1', { method: 'POST', account: a,
    headers: { 'Content-Type': 'application/octet-stream' }, body: '负责人甲的虚构索引原文。' })).status, 200);
  assert.equal((await request(index, { account: a })).result.sources.length, 1);
  assert.deepEqual((await request(index, { account: b })).result.sources, []);
  const model = { provider: 'minimax', model: 'fixture-model-only', apiKey: 'fixture-model-credential' };
  const modelSettings = await request('/api/model-settings', { account: a, input: model });
  assert.equal(modelSettings.result.active.model, model.model);
  assert.equal(JSON.stringify(modelSettings.result).includes(model.apiKey), false);
  assert.equal((await request('/api/model-settings', { account: b })).result.source, 'none');
  const folders = await readdir(join(directory, 'accounts'));
  assert.equal(folders.length, 2);
  assert.ok((await readdir(directory)).includes('previous-index.sqlite'));

  assert.equal((await request('/api/auth/sign-out', { account: a, input: {} })).status, 200);
  await stop();
  await start();
  assert.equal((await request(workspace, { account: a })).status, 401);
  const [newSessionA, newSessionB] = await Promise.all([login(owner), login(member)]);
  assert.deepEqual((await request(workspace, { account: newSessionA })).result, { revision: 1, data });
  assert.deepEqual((await request(workspace, { account: newSessionB })).result, { revision: 1, data: dataB });
  assert.equal((await request(index, { account: newSessionA })).result.sources.length, 1);
  assert.equal((await request(registrations + '/exercise', { account: newSessionA })).result.event.title, event.title);
  assert.equal((await request('/api/model-settings', { account: newSessionA })).result.active.model, model.model);
  const cleared = { ...data, conversations: [] };
  assert.deepEqual((await request(workspace, { account: newSessionA, input: { accountId: a.id, revision: 1, data: cleared } })).result, { revision: 2 });
  assert.deepEqual((await request(workspace, { account: newSessionA })).result.data.conversations, []);
});
