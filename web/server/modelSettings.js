import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { readBody, sendJson } from './localApi.js';
import { localDatabasePath } from './localData.js';
import { modelPresets } from '../src/modelPresets.js';
import { modelEndpoint, readModelConfig, requestModel, toolMessages } from './modelProvider.js';

function publicConfig({ provider, protocol, baseUrl, model, keyHeader, key, revision }) {
  return { provider, protocol, baseUrl, model, keyHeader, hasKey: Boolean(key), revision };
}

function connectionFrom(input, saved) {
  const provider = input?.provider;
  const preset = typeof provider === 'string' && Object.hasOwn(modelPresets, provider) ? modelPresets[provider] : null;
  if (provider !== 'custom' && !preset) return { error: '请选择模型服务商。' };

  const protocol = preset?.protocol ?? input.protocol;
  const enteredUrl = typeof input.baseUrl === 'string' ? input.baseUrl.trim() : '';
  const baseUrl = preset?.baseUrl ?? enteredUrl;
  const url = baseUrl.length <= 2048 ? modelEndpoint(protocol, baseUrl) : null;
  if (!url) return { error: '请输入有效的 HTTPS 接口地址，或使用本机 HTTP 地址。' };

  const enteredModel = typeof input.model === 'string' ? input.model.trim() : '';
  const model = enteredModel || preset?.model;
  if (!model || model.length > 160 || /[\u0000-\u001f\u007f]/.test(model)) return { error: '请输入有效的模型名称。' };
  const header = preset ? preset.keyHeader : input.keyHeader;
  const keyHeader = protocol === 'anthropic' && header === 'x-api-key' ? 'x-api-key' : 'bearer';
  let key = typeof input.apiKey === 'string' ? input.apiKey.trim() : '';
  if (key.length > 4096 || (key && !/^[\x21-\x7e]+$/.test(key))) return { error: 'API Key 格式无效。' };
  const reuseKey = !key && typeof input.keyRevision === 'string' && Boolean(input.keyRevision);
  if (reuseKey) {
    const sameEndpoint = saved?.provider === provider && saved.protocol === protocol && saved.keyHeader === keyHeader &&
      modelEndpoint(saved.protocol, saved.baseUrl)?.href === url.href;
    if (!sameEndpoint || saved.revision !== input.keyRevision) return { error: '连接配置已变更，请重新填写 API Key。' };
    key = saved.key;
  }
  if (!key && preset) return { error: '请填写该服务商的 API Key。' };
  return { reuseKey, config: { provider, protocol, baseUrl, model, keyHeader, key, url, thinking: preset?.thinking } };
}

const testTools = [{ type: 'function', function: {
  name: 'verify_connection', description: '完成会序连接测试，返回固定测试值。',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
} }];

async function testConnection(config, signal) {
  const system = '这是会序的模型连接测试。请先调用 verify_connection，再根据工具结果简短回复。';
  const messages = [{ role: 'user', content: '请调用 verify_connection 检查连接。' }];
  const first = await requestModel(config, { system, messages, tools: testTools, signal });
  if (first?.error) return first.error;
  const call = first?.calls?.[0];
  if (!call?.id || call.name !== 'verify_connection') return '模型已应答，但未完成测试工具调用。请检查所选模型的工具调用支持。';
  messages.push(first.assistant, ...toolMessages(config.protocol, [{ id: call.id, result: { connected: true } }]));
  const second = await requestModel(config, { system, messages, tools: testTools, final: true, signal });
  return second?.error || (second?.answer ? '' : '模型未能读取工具结果并完成应答。');
}

export function createModelSettings(root, env) {
  const path = localDatabasePath(root, env.HUIXU_MODEL_DB, 'model-settings.sqlite');
  const fallback = readModelConfig(env);
  let db;
  let testing = false;

  function connection() {
    if (db) return db;
    mkdirSync(dirname(path), { recursive: true });
    const next = new DatabaseSync(path);
    try {
      next.exec(`PRAGMA busy_timeout = 5000;
        PRAGMA secure_delete = ON;
        CREATE TABLE IF NOT EXISTS model_settings (id INTEGER PRIMARY KEY CHECK (id = 1), config TEXT NOT NULL);`);
    } catch (error) {
      next.close();
      throw error;
    }
    db = next;
    return db;
  }

  function read() {
    const row = connection().prepare('SELECT config FROM model_settings WHERE id = 1').get();
    return row ? JSON.parse(row.config) : null;
  }

  function getConfig() {
    const saved = read();
    return saved ? { ...saved, url: modelEndpoint(saved.protocol, saved.baseUrl) } : fallback;
  }

  function status(saved = read()) {
    if (saved) return { source: 'workbench', active: publicConfig(saved) };
    if (fallback) return { source: 'environment', active: { model: fallback.model, protocol: fallback.protocol } };
    return { source: 'none', active: null };
  }

  async function handle(request, response) {
    const path = new URL(request.url, 'http://localhost').pathname;
    const { method } = request;
    if (path !== '/' && path !== '/test') return sendJson(response, 404, { error: '没有此模型设置操作。' });
    if (path === '/test' ? method !== 'POST' : !['GET', 'POST', 'DELETE'].includes(method)) {
      return sendJson(response, 405, { error: '不支持此模型设置操作。' });
    }
    try {
      if (method === 'GET') return sendJson(response, 200, status());
      if (method === 'DELETE') {
        connection().prepare('DELETE FROM model_settings WHERE id = 1').run();
        return sendJson(response, 200, status());
      }
      if (request.headers['content-type']?.split(';', 1)[0] !== 'application/json') {
        return sendJson(response, 415, { error: '模型设置须以 JSON 提交。' });
      }
      const body = await readBody(request, 12 * 1024);
      if (!body) return sendJson(response, 413, { error: '模型设置内容过大。' });
      let input;
      try { input = JSON.parse(body.toString('utf8')); } catch {
        return sendJson(response, 400, { error: '模型设置格式无效。' });
      }
      const { config, reuseKey, error } = connectionFrom(input, read());
      if (error) return sendJson(response, 400, { error });
      if (path === '/test') {
        if (testing) return sendJson(response, 429, { error: '模型连接正在测试，请稍候。' });
        testing = true;
        const disconnect = new AbortController();
        response.once('close', () => disconnect.abort());
        try {
          const failure = await testConnection(config, AbortSignal.any([disconnect.signal, AbortSignal.timeout(60000)]));
          if (disconnect.signal.aborted) return;
          if (failure) return sendJson(response, 502, { error: failure });
          return sendJson(response, 200, { connected: true });
        } catch (error) {
          if (disconnect.signal.aborted) return;
          return sendJson(response, 502, { error: error.name === 'TimeoutError' ? '连接测试超时，请检查接口地址后重试。' : '无法连接模型服务，请检查接口地址。' });
        } finally {
          testing = false;
        }
      }

      const { url, ...settings } = config;
      const saved = { ...settings, revision: randomUUID() };
      const data = JSON.stringify(saved);
      if (reuseKey) {
        const result = connection().prepare(`UPDATE model_settings SET config = ?
          WHERE id = 1 AND json_extract(config, '$.revision') = ?`).run(data, input.keyRevision);
        if (!result.changes) return sendJson(response, 409, { error: '模型设置已更新，请重新打开设置。' });
      } else {
        connection().prepare(`INSERT INTO model_settings (id, config) VALUES (1, ?)
          ON CONFLICT(id) DO UPDATE SET config = excluded.config`).run(data);
      }
      return sendJson(response, 200, status(saved));
    } catch {
      if (!response.destroyed) sendJson(response, 500, { error: '本机模型设置暂时不可用。' });
    }
  }

  function close() {
    db?.close();
    db = undefined;
  }

  return { getConfig, handle, close };
}
