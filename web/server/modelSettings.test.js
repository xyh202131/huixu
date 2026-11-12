import assert from 'node:assert/strict';
import { mkdtemp, rmdir, unlink } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { modelPresets } from '../src/modelPresets.js';
import { createAgentHandler } from './agent.js';
import { createWorkbenchAuth } from './auth.js';
import { readBody, sendJson } from './localApi.js';
import { createModelSettings } from './modelSettings.js';
import { createOrganizationHandler } from './organizationApi.js';

async function listen(handler, t) {
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

test('会话保护的模型设置即时驱动对话和整理，并保留环境变量后备', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'huixu-model-test-'));
  const authPath = join(dir, 'auth.sqlite');
  const modelsPath = join(dir, 'model-settings.sqlite');
  const auth = createWorkbenchAuth(process.cwd(), authPath);
  const received = [];
  const provider = await listen(async (request, response) => {
    const body = JSON.parse(await readBody(request, 128 * 1024));
    const last = body.messages.at(-1);
    received.push({ path: request.url, model: body.model, key: request.headers['x-api-key'], last });
    if (request.url.endsWith('/messages')) {
      const tools = body.tools ?? [];
      const name = tools.some(tool => tool.name === 'verify_connection') ? 'verify_connection'
        : tools.some(tool => tool.name === 'record_import_facts') ? 'record_import_facts' : 'read_agenda';
      const facts = [{ section: 'event', field: 'title', value: '测试论坛', chunkId: 7 }];
      const content = Array.isArray(last.content) ? [{ type: 'text', text: '已核对。' }]
        : [{ type: 'tool_use', id: 'fixture-tool', name, input: name === 'record_import_facts' ? { facts } : {} }];
      return sendJson(response, 200, { model: body.model, content });
    }
    return sendJson(response, 200, { model: body.model, choices: [{ message: { content: '环境变量后备。' } }] });
  }, t);

  const env = { HUIXU_MODEL_DB: modelsPath, HUIXU_LLM_BASE_URL: provider + '/v1', HUIXU_LLM_MODEL: 'fallback-fixture' };
  const models = createModelSettings(process.cwd(), env);
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
    readOrganization: () => review,
    organizationInput: () => ({ total: 1, chunks: [{ chunkId: 7, text: '活动名称是测试论坛。', name: '方案.txt', revision: 1, location: '第 1 段' }] }),
    saveOrganization: (eventId, revision, result) => { review = result; },
  };
  const routes = {
    '/api/model-settings': auth.requireSession(models.handle),
    '/api/agent': auth.requireSession(createAgentHandler(models.getConfig, memory)),
    '/api/project-organization': auth.requireSession(createOrganizationHandler(models.getConfig, memory)),
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
  const credentials = { email: 'models@example.test', password: 'Local-model-fixture-128!', name: '测试负责人' };
  assert.equal((await request('/api/workbench-session', credentials)).status, 201);
  const login = await request('/api/auth/sign-in/email', credentials);
  assert.equal(login.status, 200);
  cookie = login.headers.getSetCookie().map(item => item.split(';', 1)[0]).join('; ');
  assert.equal((await request(settings, undefined, { requestOrigin: 'https://example.test' })).status, 403);
  assert.equal((await (await request(settings)).json()).source, 'environment');

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
  const keepKey = { ...custom, apiKey: '', keyRevision: active.revision };
  assert.equal((await request(settings, { ...keepKey, baseUrl: provider + '/other/v1' })).status, 400);
  const updated = await request(settings, { ...keepKey, model: 'fixture-next' });
  assert.equal(updated.status, 200);
  assert.equal((await request(settings, keepKey)).status, 400);

  const agentInput = { question: '请查询议程。', event: { id: 'forum', title: '测试论坛', agenda: [], rooms: [] } };
  const chat = await (await request('/api/agent', agentInput)).json();
  assert.equal(chat.model, 'fixture-next');
  assert.equal(chat.evidence.title, '测试论坛');
  const organized = await (await request('/api/project-organization?event=forum', {})).json();
  assert.equal(organized.review.model, 'fixture-next');
  assert.equal(organized.review.facts[0].options[0].value, '测试论坛');
  assert.ok(received.every(item => item.path === '/v1/messages' && item.key === apiKey));

  const reopened = createModelSettings(process.cwd(), env);
  try { assert.equal(reopened.getConfig().model, 'fixture-next'); } finally { reopened.close(); }
  assert.equal((await (await request(settings, undefined, { method: 'DELETE' })).json()).source, 'environment');
  assert.equal((await (await request('/api/agent', agentInput)).json()).model, 'fallback-fixture');
});
