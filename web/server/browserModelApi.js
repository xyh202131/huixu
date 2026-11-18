import { isWorkbenchRequest, readBody, sendJson } from './localApi.js';
import { connectionFrom, testConnection, testOrganization } from './modelSettings.js';

export function createBrowserModelTest() {
  let active = 0;
  return async (request, response) => {
    if (!isWorkbenchRequest(request)) return sendJson(response, 403, { error: '模型测试仅供本机工作台访问。' });
    if (request.method !== 'POST') return sendJson(response, 405, { error: '模型测试仅接受 POST。' });
    if (request.headers['content-type']?.split(';', 1)[0] !== 'application/json') return sendJson(response, 415, { error: '请以 JSON 提交模型配置。' });
    if (active >= 2) return sendJson(response, 429, { error: '模型连接正在测试，请稍候。' });
    const disconnect = new AbortController();
    response.once('close', () => disconnect.abort());
    active += 1;
    try {
      const body = await readBody(request, 12 * 1024);
      if (!body) return sendJson(response, 413, { error: '模型配置过长。' });
      let input;
      try { input = JSON.parse(body.toString('utf8')); } catch { return sendJson(response, 400, { error: '模型配置格式无效。' }); }
      if (!['chat', 'organization'].includes(input?.purpose)) return sendJson(response, 400, { error: '请选择模型用途。' });
      const { config, error } = connectionFrom(input.connection);
      if (error) return sendJson(response, 400, { error });
      if (input.validateOnly === true) return sendJson(response, 200, { valid: true });
      const signal = AbortSignal.any([disconnect.signal, AbortSignal.timeout(60000)]);
      const failure = input.purpose === 'organization' ? await testOrganization(config, signal) : await testConnection(config, signal);
      if (disconnect.signal.aborted) return;
      return sendJson(response, failure ? 502 : 200, failure ? { error: failure } : { connected: true, model: config.model });
    } catch (error) {
      if (!disconnect.signal.aborted) sendJson(response, 502, { error: error.name === 'TimeoutError' ? '连接测试超时，请检查接口地址后重试。' : '无法连接模型服务，请检查接口地址与网络。' });
    } finally {
      active -= 1;
    }
  };
}
