import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { modelInput } from '../src/browserModels.js';
import { createAgentHandler } from './agent.js';
import { createBrowserModelTest } from './browserModelApi.js';
import { readBody, sendJson } from './localApi.js';
import { createTopicPlanHandler } from './topicPlanApi.js';

async function listen(t, handler) {
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

test('浏览器配置仅在同一服务商、协议和接口复用密钥', () => {
  const saved = { provider: 'custom', protocol: 'anthropic', baseUrl: 'https://example.test/v1', model: 'test-model', keyHeader: 'x-api-key', apiKey: 'fixture-browser-key' };
  assert.equal(modelInput({ ...saved, apiKey: '', model: 'next-model' }, saved).apiKey, saved.apiKey);
  assert.equal(modelInput({ ...saved, apiKey: '', baseUrl: 'https://other.example.test/v1' }, saved).apiKey, '');
  assert.throws(() => modelInput({ ...saved, baseUrl: 'http://example.test' }), /HTTPS/);
  assert.throws(() => modelInput({ ...saved, apiKey: 'invalid\nkey' }), /API Key/);
  assert.throws(() => modelInput({ provider: 'openai', model: '', baseUrl: '', apiKey: '' }), /API Key/);
});

test('访客自带模型完成工具测试和对话，每次请求独立且无法读取私有资料', async t => {
  const received = [];
  const provider = await listen(t, async (request, response) => {
    const body = JSON.parse(await readBody(request, 128 * 1024));
    const key = request.headers.authorization ?? request.headers['x-api-key'];
    received.push({ model: body.model, key, tools: body.tools });
    if (key?.includes('bad-fixture')) return sendJson(response, 401, { error: 'rejected' });
    const anthropic = request.url.endsWith('/messages');
    const last = body.messages.at(-1);
    const final = anthropic ? Array.isArray(last.content) : last.role === 'tool';
    const tool = body.tools?.some(tool => (tool.name ?? tool.function?.name) === 'verify_connection') ? 'verify_connection' : 'read_agenda';
    if (anthropic) return sendJson(response, 200, { model: body.model, content: final ? [{ type: 'text', text: '已读取当前议程。' }]
      : [{ type: 'tool_use', id: 'fixture-call', name: tool, input: {} }] });
    return sendJson(response, 200, { model: body.model, choices: [{ message: final ? { content: '已读取当前议程。' }
      : { tool_calls: [{ id: 'fixture-call', type: 'function', function: { name: tool, arguments: '{}' } }] } }] });
  });
  const routes = { '/test': createBrowserModelTest(), '/agent': createAgentHandler(() => null, null) };
  const origin = await listen(t, (request, response) => routes[request.url](request, response));
  const request = (path, input, originHeader = origin) => fetch(origin + path, { method: 'POST',
    headers: { Origin: originHeader, 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
  const event = { id: 'forum', title: '访客论坛', version: 1, agenda: [], rooms: [] };
  for (const protocol of ['openai', 'anthropic']) {
    const connection = { provider: 'custom', protocol, baseUrl: provider + '/v1', model: protocol + '-fixture', keyHeader: 'x-api-key', apiKey: 'fixture-browser-key' };
    const tested = await request('/test', { purpose: 'chat', connection });
    assert.equal(tested.status, 200);
    assert.equal((await tested.json()).connected, true);
    const answer = await (await request('/agent', { connection, question: '请查看议程', event })).json();
    assert.equal(answer.evidence.title, event.title);
    assert.equal(answer.model, connection.model);
    assert.ok(!JSON.stringify(answer).includes(connection.apiKey));
    for (const request of received) {
      const advertised = request.tools ?? [];
      assert.ok(advertised.every(tool => !['search_project_memory', 'list_project_sources', 'list_archive_members'].includes(tool.name ?? tool.function?.name)));
    }
    assert.equal((await request('/agent', { connection, question: '请查看议程', event }, 'https://other.example.test')).status, 403);
    const rejected = await request('/test', { purpose: 'chat', connection: { ...connection, apiKey: 'bad-fixture-key' } });
    assert.equal(rejected.status, 502);
    assert.match((await rejected.json()).error, /鉴权/);
  }
  const missing = await request('/agent', { question: '请查看议程', event });
  assert.equal(missing.status, 503);
  assert.equal((await missing.json()).code, 'MODEL_NOT_CONFIGURED');
});

test('浏览器模型覆盖当前负责人后备配置并用于主题方案', async t => {
  let sharedReads = 0;
  const provider = await listen(t, async (request, response) => {
    const body = JSON.parse(await readBody(request, 128 * 1024));
    assert.equal(request.headers.authorization, 'Bearer fixture-topic-key');
    assert.equal(body.model, 'browser-topic');
    const suggestions = { goal: '完成社区交流', agenda: [1, 2, 3].map(index => ({ name: '环节' + index, duration: 30 })),
      roles: [{ name: '主持', duty: '串场' }], supplies: [{ name: '话筒' }], tasks: [{ name: '场地确认', offset: 7 }], budgetItems: [{ name: '场租' }] };
    return sendJson(response, 200, { choices: [{ message: { tool_calls: [{ id: 'plan', type: 'function', function: { name: 'submit_plan', arguments: JSON.stringify(suggestions) } }] } }] });
  });
  const handler = createTopicPlanHandler(() => { sharedReads += 1; return null; });
  const origin = await listen(t, handler);
  const response = await fetch(origin, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
    topic: '社区交流', type: '行业论坛', connection: { provider: 'custom', protocol: 'openai', baseUrl: provider + '/v1', model: 'browser-topic', apiKey: 'fixture-topic-key' },
  }) });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).suggestions.agenda.length, 3);
  assert.equal(sharedReads, 0);
});
