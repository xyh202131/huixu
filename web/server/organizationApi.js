import { isLocalRequest, sendJson } from './localApi.js';
import { organizeSources } from './organizeSources.js';

export function createOrganizationHandler(getModelConfig, memory) {
  const running = new Map();

  return async (request, response) => {
    if (!isLocalRequest(request)) return sendJson(response, 403, { error: '智能整理仅供本机工作台访问。' });
    const eventId = new URL(request.url, 'http://localhost').searchParams.get('event');
    if (!/^[\w-]{1,128}$/.test(eventId ?? '')) return sendJson(response, 400, { error: '请指定有效的活动。' });
    if (!['GET', 'POST'].includes(request.method)) return sendJson(response, 405, { error: '不支持此操作。' });

    try {
      const scope = memory.organizationScope(eventId);
      const review = memory.readOrganization(eventId, scope.revision);
      const state = { excluded: scope.excluded, unparsed: scope.unparsed, total: scope.total, review };
      if (!scope.total) return sendJson(response, 200, { ...state, status: 'no_sources' });
      if (request.method === 'GET') {
        const status = running.get(eventId)?.revision === scope.revision ? 'running' : review ? 'ready' : 'pending';
        return sendJson(response, 200, { ...state, status });
      }
      if (review && !review.failed) return sendJson(response, 200, { ...state, status: 'ready' });
      let job = running.get(eventId);
      if (job?.revision !== scope.revision) {
        const config = getModelConfig();
        if (!config) return sendJson(response, 503, { error: '资料已建立本机索引。请在右上角配置模型后重试整理。' });
        const snapshot = memory.organizationInput(eventId, scope);
        const isCurrent = () => memory.organizationScope(eventId).revision === scope.revision;
        const previous = job?.promise;
        job = { revision: scope.revision };
        job.promise = (async () => {
          await previous?.catch(() => {});
          const result = await organizeSources(config, snapshot, isCurrent);
          if (!result || !isCurrent()) return null;
          if (!result.covered) throw new Error('MODEL_EXTRACTION_FAILED');
          const next = { ...result, revision: scope.revision };
          memory.saveOrganization(eventId, scope.revision, next);
          return next;
        })().finally(() => { if (running.get(eventId) === job) running.delete(eventId); });
        running.set(eventId, job);
      }
      const next = await job.promise;
      const current = memory.organizationScope(eventId);
      if (!next || current.revision !== next.revision) {
        return sendJson(response, 409, { error: '资料版本或引用权限已更新，请查看最新整理结果。' });
      }
      return sendJson(response, 200, { excluded: current.excluded, unparsed: current.unparsed,
        total: current.total, review: next, status: 'ready' });
    } catch (error) {
      if (response.destroyed) return;
      if (error.message === 'MODEL_EXTRACTION_FAILED') {
        return sendJson(response, 502, { error: '模型暂未返回可核验的提取结果。原文索引已保留，可以重试。' });
      }
      sendJson(response, 500, { error: '本机智能整理暂时不可用。' });
    }
  };
}
