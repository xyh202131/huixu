import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rmdir, unlink } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { modelPresets } from '../src/modelPresets.js';
import { createAgentHandler } from './agent.js';
import { createWorkbenchAuth } from './auth.js';
import { readBody, sendJson } from './localApi.js';
import { createPlatformModel, modelEndpoint, readModelConfig } from './modelProvider.js';
import { createModelSettings } from './modelSettings.js';
import { createOrganizationHandler } from './organizationApi.js';

async function listen(handler, t) {
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

test('创空间允许 MiniMax 的两个服务地址，服务端 Messages 使用对应鉴权头', () => {
  const previous = process.env.HUIXU_HOSTED;
  process.env.HUIXU_HOSTED = '1';
  try {
    for (const host of ['api.minimax.cn', 'api.minimaxi.com']) {
      assert.equal(modelEndpoint('anthropic', `https://${host}/anthropic`).href, `https://${host}/anthropic/v1/messages`);
    }
    assert.equal(modelEndpoint('openai', 'http://127.0.0.1:8888/v1'), null);
    const env = { HUIXU_LLM_PROTOCOL: 'anthropic', HUIXU_LLM_MODEL: 'fixture',
      HUIXU_LLM_BASE_URL: 'https://api.anthropic.com' };
    assert.equal(readModelConfig(env).keyHeader, 'x-api-key');
    assert.equal(readModelConfig({ ...env, HUIXU_LLM_BASE_URL: 'https://api.minimaxi.com/anthropic' }).keyHeader, 'bearer');
    assert.equal(readModelConfig({ ...env, HUIXU_LLM_KEY_HEADER: 'unknown' }), null);
  } finally {
    if (previous === undefined) delete process.env.HUIXU_HOSTED;
    else process.env.HUIXU_HOSTED = previous;
  }
});

test('平台 MiniMax 仅开放受信服务，并限制并发和共用额度', async () => {
  const env = { HUIXU_LLM_PROTOCOL: 'anthropic', HUIXU_LLM_BASE_URL: 'https://api.minimaxi.com/anthropic',
    HUIXU_LLM_MODEL: 'MiniMax-M3.1-Flash', HUIXU_LLM_API_KEY: 'fixture-key' };
  assert.equal(createPlatformModel({ ...env, HUIXU_LLM_API_KEY: '' }), null);
  assert.equal(createPlatformModel({ ...env, HUIXU_LLM_BASE_URL: 'https://example.test' }), null);
  assert.equal(createPlatformModel({ ...env, HUIXU_LLM_MODEL: 'private-model' }), null);
  let time = 0;
  const { withQuota } = createPlatformModel(env, () => time);
  const { promise, resolve } = Promise.withResolvers();
  const pending = Array.from({ length: 4 }, () => withQuota(() => promise));
  assert.match((await withQuota(() => assert.fail('超过并发限制'))).error, /正在处理/);
  resolve();
  await Promise.all(pending);
  await assert.rejects(withQuota(() => { throw new Error('模拟上游失败'); }), /模拟上游失败/);
  for (let index = 5; index < 60; index++) assert.equal(await withQuota(() => 'ok'), 'ok');
  assert.match((await withQuota(() => assert.fail('超过额度限制'))).error, /频率上限/);
  time = 60000;
  assert.equal(await withQuota(() => 'ok'), 'ok');
});

test('模型设置按用途启用、验收和恢复共享配置', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'huixu-model-test-'));
  const authPath = join(dir, 'auth.sqlite');
  const modelsPath = join(dir, 'model-settings.sqlite');
  const auth = createWorkbenchAuth(process.cwd(), authPath);
  const received = [];
  const provider = await listen(async (request, response) => {
    const body = JSON.parse(await readBody(request, 128 * 1024));
    const last = body.messages.at(-1);
    received.push({ path: request.url, model: body.model, key: request.headers['x-api-key'] ?? request.headers.authorization, last });
    if (request.url.endsWith('/messages')) {
      const tools = body.tools ?? [];
      const name = tools.some(tool => tool.name === 'verify_connection') ? 'verify_connection'
        : tools.some(tool => tool.name === 'record_import_facts') ? 'record_import_facts' : 'read_agenda';
      let facts = [{ section: 'event', field: 'title', value: '测试论坛', chunkId: 7 }];
      if (name === 'record_import_facts' && last.content.includes('演练议程.pdf')) {
        facts = ['14:00', '14:30'].map((value, index) => ({ section: 'agenda', entity: '案例交流', field: 'start', value, chunkId: index + 1 }));
        if (body.model === 'incomplete-fixture') facts.pop();
      }
      const content = Array.isArray(last.content) ? [{ type: 'text', text: '已核对。' }]
        : [{ type: 'tool_use', id: 'fixture-tool', name, input: name === 'record_import_facts' ? { facts } : {} }];
      return sendJson(response, 200, { model: body.model, content });
    }
    const message = body.tool_choice === 'auto' && body.tools?.some(tool => tool.function.name === 'verify_connection')
      ? { content: null, tool_calls: [{ id: 'config-test', type: 'function', function: { name: 'verify_connection', arguments: '{}' } }] }
      : { content: '环境变量后备。' };
    return sendJson(response, 200, { model: body.model, choices: [{ message }] });
  }, t);

  const env = { HUIXU_MODEL_DB: modelsPath, HUIXU_LLM_BASE_URL: provider + '/v1', HUIXU_LLM_MODEL: 'fallback-fixture',
    HUIXU_LLM_API_KEY: 'fixture-server-fallback-key' };
  const storageKey = randomBytes(32);
  const models = createModelSettings(process.cwd(), env, storageKey);
  t.after(async () => {
    models.close();
    auth.close();
    for (const path of [authPath, authPath + '-wal', authPath + '-shm', modelsPath]) {
      await unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
    await rmdir(dir);
  });
  const scope = { revision: '1', total: 1, excluded: 0, unparsed: 0 };
  let review;
  const memory = {
    organizationScope: () => scope,
    readOrganization: (_eventId, revision) => review?.revision === revision ? review : null,
    organizationInput: () => ({ total: 1, chunks: [{ chunkId: 7, text: '活动名称是测试论坛。', name: '方案.txt', revision: 1, location: '第 1 段' }] }),
    saveOrganization: (eventId, revision, result) => { review = result; },
  };
  const routes = {
    '/api/model-settings': auth.requireSession(models.handle),
    '/api/agent': auth.requireSession(createAgentHandler(models.getConfig, memory)),
    '/api/project-organization': auth.requireSession(createOrganizationHandler(models.getOrganizationConfig, memory)),
  };
  const origin = await listen((request, response) => {
    const { pathname, search } = new URL(request.url, 'http://localhost');
    if (pathname.startsWith('/api/auth/')) {
      request.url = pathname.slice('/api/auth'.length);
      return auth.handle(request, response);
    }
    if (pathname === '/api/workbench-session') {
      request.url = '/';
      return auth.session(request, response);
    }
    const route = Object.keys(routes).find(path => pathname === path || pathname.startsWith(path + '/'));
    if (!route) return sendJson(response, 404, {});
    request.url = (pathname.slice(route.length) || '/') + search;
    return routes[route](request, response);
  }, t);

  let cookie;
  function request(path, input, { method = input === undefined ? 'GET' : 'POST', requestOrigin = origin } = {}) {
    return fetch(origin + path, { method, headers: { Origin: requestOrigin, ...(cookie && { Cookie: cookie }),
      ...(input !== undefined && { 'Content-Type': 'application/json' }) }, body: input === undefined ? undefined : JSON.stringify(input) });
  }

  const settings = '/api/model-settings';
  assert.equal((await request(settings)).status, 401);
  assert.equal((await request(settings + '/test', { useCurrent: true })).status, 401);
  const credentials = { email: 'models@example.test', password: 'Local-model-fixture-128!', name: '测试负责人' };
  assert.equal((await request('/api/workbench-session', credentials)).status, 201);
  const login = await request('/api/auth/sign-in/email', credentials);
  assert.equal(login.status, 200);
  const { user } = await login.json();
  cookie = login.headers.getSetCookie().map(item => item.split(';', 1)[0]).join('; ');
  assert.equal((await request(settings, undefined, { requestOrigin: 'https://example.test' })).status, 403);
  assert.deepEqual(await (await request(settings)).json(), { source: 'environment', active: { model: 'fallback-fixture', protocol: 'openai' } });
  assert.deepEqual(await (await request(settings + '/test', { useCurrent: true })).json(), { connected: true });
  assert.equal(received.length, 2);
  assert.ok(received.every(item => item.model === 'fallback-fixture' && item.key === 'Bearer fixture-server-fallback-key'));
  assert.equal(received.at(-1).last.role, 'tool');
  received.length = 0;

  const apiKey = 'fixture-model-key';
  for (const [provider, preset] of Object.entries(modelPresets)) {
    const response = await request(settings, { provider, apiKey, baseUrl: 'https://example.test' });
    assert.equal(response.status, 200);
    const { active } = await response.json();
    assert.equal(active.model, preset.model);
    assert.equal(active.baseUrl, preset.baseUrl);
    assert.equal(active.hasKey, true);
    assert.ok(!JSON.stringify(active).includes(apiKey));
  }
  assert.equal((await request(settings, { provider: 'openai' })).status, 400);
  const custom = { provider: 'custom', protocol: 'anthropic', baseUrl: provider + '/v1/messages', keyHeader: 'x-api-key', model: 'fixture-model', apiKey };
  assert.equal((await request(settings, { ...custom, baseUrl: 'http://example.test/v1' })).status, 400);
  assert.equal((await request(settings, { ...custom, baseUrl: provider + '/v1?api_key=fixture' })).status, 400);
  assert.deepEqual(await (await request(settings + '/test', custom)).json(), { connected: true });
  assert.equal(received.length, 2);
  assert.equal(received[1].last.content[0].type, 'tool_result');
  assert.equal((await (await request(settings)).json()).active.provider, 'minimax');

  const { active } = await (await request(settings, custom)).json();
  assert.ok(!JSON.stringify(active).includes(apiKey));
  const importResult = await (await request(settings, { ...custom, model: 'old-browser', importLegacy: true })).json();
  assert.equal(importResult.active.revision, active.revision);
  assert.equal(importResult.active.model, custom.model);
  const keepKey = { ...custom, apiKey: '', keyRevision: active.revision };
  assert.equal((await request(settings, { ...keepKey, baseUrl: provider + '/other/v1' })).status, 400);
  const updated = await request(settings, { ...keepKey, model: 'fixture-next' });
  assert.equal(updated.status, 200);
  const { active: updatedChat } = await updated.json();
  assert.equal((await request(settings, keepKey)).status, 400);

  const agentInput = { question: '请查询议程。', event: { id: 'forum', title: '测试论坛', agenda: [], rooms: [] } };
  const chat = await (await request('/api/agent', agentInput)).json();
  assert.equal(chat.model, 'fixture-next');
  assert.equal(chat.evidence.title, '测试论坛');
  const organized = await (await request('/api/project-organization?event=forum', {})).json();
  assert.equal(organized.review.model, 'fixture-next');
  assert.equal(organized.review.facts[0].options[0].value, '测试论坛');
  assert.ok(received.every(item => item.path === '/v1/messages' && item.key === apiKey));

  const organization = settings + '?purpose=organization';
  const organizationTest = settings + '/test?purpose=organization';
  assert.equal((await request(settings + '?purpose=other')).status, 400);
  assert.deepEqual(await (await request(organization)).json(), { source: 'shared', active: { model: 'fixture-next', protocol: 'anthropic' } });
  assert.deepEqual(await (await request(organizationTest, { useCurrent: true })).json(), { connected: true });
  assert.equal(received.at(-1).model, 'fixture-next');

  const organizationKey = 'fixture-organization-key';
  const extraction = { ...custom, model: 'extraction-fixture', apiKey: organizationKey };
  assert.equal((await request(organizationTest, { ...extraction, model: 'incomplete-fixture' })).status, 502);
  assert.deepEqual(await (await request(organizationTest, extraction)).json(), { connected: true });
  assert.equal((await (await request(organization)).json()).source, 'shared');
  const organizationSaved = await request(organization, extraction);
  assert.equal(organizationSaved.status, 200);
  const organizationStatus = await organizationSaved.json();
  assert.equal(organizationStatus.active.model, 'extraction-fixture');
  assert.ok(!JSON.stringify(organizationStatus).includes(organizationKey));
  assert.equal((await request(organization, { ...extraction, apiKey: '', keyRevision: updatedChat.revision })).status, 400);

  scope.revision = '2';
  const secondReview = await (await request('/api/project-organization?event=forum', {})).json();
  assert.equal(secondReview.review.model, 'extraction-fixture');
  assert.equal(received.at(-1).key, organizationKey);
  assert.equal((await (await request('/api/agent', agentInput)).json()).model, 'fixture-next');
  assert.equal(received.at(-1).key, apiKey);

  const reopened = createModelSettings(process.cwd(), env, storageKey);
  try {
    assert.equal(reopened.getConfig().model, 'fixture-next');
    assert.equal(reopened.getOrganizationConfig().model, 'extraction-fixture');
  } finally {
    reopened.close();
  }
  scope.revision = 'browser-configuration';
  const browserOrganized = await (await request('/api/project-organization?event=forum', {
    connection: { ...custom, ownerId: user.id, model: 'browser-organization', apiKey: 'fixture-browser-organization-key' },
  })).json();
  assert.equal(browserOrganized.review.model, 'browser-organization');
  assert.equal(received.at(-1).key, 'fixture-browser-organization-key');
  assert.deepEqual(await (await request(organization, undefined, { method: 'DELETE' })).json(),
    { source: 'shared', active: { model: 'fixture-next', protocol: 'anthropic' } });
  assert.equal((await (await request(settings, undefined, { method: 'DELETE' })).json()).source, 'environment');
  assert.equal((await (await request(settings, { ...custom, importLegacy: true })).json()).source, 'environment');
  assert.equal((await (await request(organization, { ...extraction, importLegacy: true })).json()).source, 'shared');
  assert.equal((await (await request('/api/agent', agentInput)).json()).model, 'fallback-fixture');
});

test('旧数据库中的模型 Key 转成密文，且单独的账号或用途无法解密该记录', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'huixu-model-migration-'));
  const database = join(directory, 'models.sqlite');
  const env = { HUIXU_MODEL_DB: database };
  t.after(async () => { await unlink(database); await rmdir(directory); });
  const legacy = { provider: 'custom', protocol: 'openai', baseUrl: 'https://example.test/v1', model: 'legacy-fixture',
    keyHeader: 'bearer', key: 'fixture-before-encryption-2026', revision: 'original-revision' };
  const seed = new DatabaseSync(database);
  seed.exec('CREATE TABLE model_settings (id INTEGER PRIMARY KEY, config TEXT NOT NULL)');
  seed.prepare('INSERT INTO model_settings VALUES (1, ?)').run(JSON.stringify(legacy));
  seed.close();

  const storageKey = randomBytes(32);
  const models = createModelSettings(process.cwd(), env, storageKey);
  try {
    assert.equal(models.getConfig().key, legacy.key);
    assert.equal(models.getConfig().revision, legacy.revision);
  } finally { models.close(); }
  assert.ok(!(await readFile(database)).includes(Buffer.from(legacy.key)));

  const otherAccount = createModelSettings(process.cwd(), env, randomBytes(32));
  try { assert.throws(() => otherAccount.getConfig()); } finally { otherAccount.close(); }

  const inspect = new DatabaseSync(database);
  const { config } = inspect.prepare('SELECT config FROM model_settings WHERE id = 1').get();
  assert.ok(JSON.parse(config).encryptedKey);
  inspect.prepare('INSERT INTO organization_model_settings VALUES (1, ?)').run(config);
  inspect.close();
  const reopened = createModelSettings(process.cwd(), env, storageKey);
  try { assert.throws(() => reopened.getOrganizationConfig()); } finally { reopened.close(); }
});
