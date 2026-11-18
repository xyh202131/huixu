import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { newEvent } from '../src/model.js';
import { signupSnapshot } from '../src/registrationRules.js';
import { readBody, sendJson } from './localApi.js';
import { createWorkbench } from './workbench.js';

function workbenchServer(workbench) {
  const server = createServer(async (request, response) => {
    const route = Object.keys(workbench.routes).find(prefix => request.url === prefix ||
      request.url.startsWith(prefix + '/') || request.url.startsWith(prefix + '?'));
    if (!route) return sendJson(response, 404, {});
    request.url = request.url.slice(route.length) || '/';
    if (request.url.startsWith('?')) request.url = '/' + request.url;
    await workbench.routes[route](request, response);
  });
  server.once('close', workbench.close);
  return server;
}

test('邀请码账号独立保存活动、对话、模型和资料，服务重启后能读取', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'huixu-account-test-'));
  const modelCalls = [];
  const provider = createServer(async (request, response) => {
    const { model } = JSON.parse(await readBody(request, 128 * 1024));
    modelCalls.push({ model, authorization: request.headers.authorization });
    sendJson(response, 200, { model, choices: [{ message: { content: '联验答复。' } }] });
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  const modelUrl = 'http://127.0.0.1:' + provider.address().port + '/v1';
  const env = {
    HUIXU_AUTH_DB: join(directory, 'auth.sqlite'), HUIXU_REGISTRATION_DB: join(directory, 'registration.sqlite'),
    HUIXU_MEMORY_DB: join(directory, 'previous-index.sqlite'), HUIXU_MODEL_DB: join(directory, 'previous-model.sqlite'),
    HUIXU_SIGNUP_CODE: 'sample-signup-integration-1234567890',
    HUIXU_LLM_BASE_URL: modelUrl, HUIXU_LLM_MODEL: 'fixture-platform-model', HUIXU_LLM_API_KEY: 'fixture-platform-key',
    HUIXU_RESEND_API_KEY: 'fixture-mail-key', HUIXU_MAIL_FROM: 'owner@example.test', HUIXU_PUBLIC_ORIGIN: 'https://events.example.test',
  };
  let server;
  let base;
  async function stop() {
    if (!server) return;
    await new Promise(resolve => server.close(resolve));
    server = null;
  }
  async function start() {
    server = workbenchServer(createWorkbench(process.cwd(), env));
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = 'http://127.0.0.1:' + server.address().port;
  }
  t.after(async () => {
    await stop();
    await new Promise(resolve => provider.close(resolve));
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
  assert.equal((await request(registrations, { account: b, input: signupSnapshot(eventB) })).status, 200);
  const memberEvent = registrations + '/exercise-b';
  const memberRegistration = await request(memberEvent + '/people', { account: b,
    input: { name: '演练报名乙', email: 'member-attendee@example.test', status: '已确认' } });
  assert.equal(memberRegistration.status, 200);
  const personId = memberRegistration.result.people[0].id;
  assert.equal((await request(registrations + '/exercise/mail', { account: a })).result.configured, true);
  assert.equal((await request(memberEvent + '/mail', { account: b })).result.configured, false);
  assert.equal((await request(memberEvent + '/mail/' + personId + '/preview', { account: b, method: 'POST' })).status, 403);
  assert.equal((await request(memberEvent + '/links/' + personId, { account: b, method: 'POST' })).status, 200);
  assert.equal((await request(index + '&name=owner-notes.md&agent=1', { method: 'POST', account: a,
    headers: { 'Content-Type': 'application/octet-stream' }, body: '负责人甲的虚构索引原文。' })).status, 200);
  assert.equal((await request(index, { account: a })).result.sources.length, 1);
  assert.deepEqual((await request(index, { account: b })).result.sources, []);
  const organization = '/api/project-organization?event=exercise';
  assert.equal((await request(organization, { headers: { Cookie: b.cookie } })).status, 401);
  assert.equal((await request(organization, { account: b })).result.status, 'no_sources');
  const models = '/api/model-settings';
  const model = { provider: 'custom', protocol: 'openai', baseUrl: modelUrl, model: 'fixture-model-owner', apiKey: 'fixture-model-credential' };
  const modelB = { ...model, model: 'fixture-model-member', apiKey: 'fixture-member-credential' };
  const question = { question: '联验模型', event: { id: 'exercise', title: '测试', agenda: [], rooms: [] } };
  assert.equal((await request(models)).status, 401);
  assert.equal((await request(models, { headers: { Cookie: a.cookie } })).status, 401);
  assert.equal((await request(models, { account: b, headers: { 'X-Huixu-Account': a.id }, input: model })).status, 401);
  assert.equal((await request(models, { account: a })).result.source, 'environment');
  assert.equal((await request(models, { account: b })).result.source, 'none');
  assert.equal((await request('/api/agent', { account: b, input: question })).result.code, 'MODEL_NOT_CONFIGURED');
  assert.equal(modelCalls.length, 0);
  assert.equal((await request('/api/agent', { account: a, input: question })).result.model, env.HUIXU_LLM_MODEL);
  assert.equal(modelCalls.at(-1).authorization, 'Bearer ' + env.HUIXU_LLM_API_KEY);
  const savedA = await request(models, { account: a, input: model });
  assert.equal(savedA.result.active.model, model.model);
  assert.equal(JSON.stringify(savedA.result).includes(model.apiKey), false);
  assert.equal((await request(models, { account: b, input: { ...modelB, apiKey: '', keyRevision: savedA.result.active.revision } })).status, 400);
  assert.equal((await request(models, { account: b, input: { ...modelB, importLegacy: true } })).result.active.model, modelB.model);
  assert.equal((await request('/api/agent', { account: b, input: question })).result.model, modelB.model);
  assert.equal(modelCalls.at(-1).authorization, 'Bearer ' + modelB.apiKey);
  assert.equal((await request('/api/agent', { account: a, input: question })).result.model, model.model);
  assert.equal(modelCalls.at(-1).authorization, 'Bearer ' + model.apiKey);
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
  assert.equal((await request('/api/agent', { account: newSessionB, input: question })).result.model, modelB.model);
  assert.equal(modelCalls.at(-1).authorization, 'Bearer ' + modelB.apiKey);
  const cleared = { ...data, conversations: [] };
  assert.deepEqual((await request(workspace, { account: newSessionA, input: { accountId: a.id, revision: 1, data: cleared } })).result, { revision: 2 });
  assert.deepEqual((await request(workspace, { account: newSessionA })).result.data.conversations, []);
});

test('访客和独立账号可使用平台 MiniMax，模型切换按当前身份读取凭据', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'huixu-platform-model-'));
  const env = {
    HUIXU_AUTH_DB: join(dir, 'auth.sqlite'), HUIXU_REGISTRATION_DB: join(dir, 'registration.sqlite'),
    HUIXU_MODEL_DB: join(dir, 'models.sqlite'), HUIXU_MEMORY_DB: join(dir, 'memory.sqlite'),
    HUIXU_SIGNUP_CODE: 'fixture-platform-signup-1234567890123', HUIXU_LLM_PROTOCOL: 'anthropic',
    HUIXU_LLM_BASE_URL: 'https://api.minimaxi.com/anthropic', HUIXU_LLM_MODEL: 'MiniMax-M3.1-Flash',
    HUIXU_LLM_API_KEY: 'fixture-platform-secret',
  };
  const personal = { provider: 'custom', protocol: 'anthropic', baseUrl: 'https://api.anthropic.com',
    keyHeader: 'x-api-key', model: 'fixture-personal-model', apiKey: 'fixture-personal-secret' };
  const calls = [];
  const fetchLocal = globalThis.fetch;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const host = new URL(url).hostname;
    if (!['api.minimaxi.com', 'api.anthropic.com'].includes(host)) return fetchLocal(url, options);
    const body = JSON.parse(options.body);
    const headers = new Headers(options.headers);
    calls.push({ model: body.model, key: headers.get('Authorization') ?? headers.get('x-api-key') });
    return Response.json({ model: body.model, content: [{ type: 'text', text: '演练答复。' }] });
  });
  const server = workbenchServer(createWorkbench(process.cwd(), env));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  const origin = 'http://127.0.0.1:' + server.address().port;
  const request = (route, input, headers) => fetchLocal(origin + '/api/' + route, {
    method: input ? 'POST' : 'GET', headers: { Origin: origin, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(input),
  });
  assert.deepEqual(await (await request('platform-model')).json(), { platform: { model: env.HUIXU_LLM_MODEL } });
  const input = { question: '演练活动几点开始？', event: { id: 'fixture', title: '演练活动', agenda: [], rooms: [] } };
  async function check(route, choice, model, key, headers, connection) {
    const response = await request(route, { ...input, modelChoice: choice, connection }, headers);
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.model, model);
    assert.equal(result.answer, '演练答复。');
    assert.equal(JSON.stringify(result).includes(key), false);
    assert.deepEqual(calls.at(-1), { model, key });
  }
  const platformKey = 'Bearer ' + env.HUIXU_LLM_API_KEY;
  await check('browser-agent', 'auto', env.HUIXU_LLM_MODEL, platformKey);
  await check('browser-agent', 'auto', personal.model, personal.apiKey, undefined, personal);
  await check('browser-agent', 'platform', env.HUIXU_LLM_MODEL, platformKey, undefined, personal);
  assert.equal((await request('browser-agent', { ...input, modelChoice: 'personal' })).status, 503);
  assert.equal((await request('browser-agent', { ...input, modelChoice: 'arbitrary' })).status, 400);
  assert.equal(calls.length, 3);

  const owner = { name: '演练负责人', email: 'owner@example.test', password: 'Fixture-Owner123!' };
  const member = { name: '演练成员', email: 'member@example.test', password: 'Fixture-Member123!' };
  assert.equal((await request('workbench-session', owner)).status, 201);
  assert.equal((await request('workbench-session/register', { ...member, signupCode: env.HUIXU_SIGNUP_CODE })).status, 201);
  const login = await request('auth/sign-in/email', { email: member.email, password: member.password });
  assert.equal(login.status, 200);
  const headers = { Cookie: login.headers.getSetCookie().map(cookie => cookie.split(';', 1)[0]).join('; '),
    'X-Huixu-Account': (await login.json()).user.id };
  assert.equal((await (await request('model-settings', undefined, headers)).json()).source, 'platform');
  await check('agent', 'auto', env.HUIXU_LLM_MODEL, platformKey, headers);
  assert.equal((await request('model-settings', personal, headers)).status, 200);
  await check('agent', 'auto', personal.model, personal.apiKey, headers);
  await check('agent', 'personal', personal.model, personal.apiKey, headers);
  await check('agent', 'platform', env.HUIXU_LLM_MODEL, platformKey, headers);
  await check('browser-agent', 'auto', env.HUIXU_LLM_MODEL, platformKey);
});
