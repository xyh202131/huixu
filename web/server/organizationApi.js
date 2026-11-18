import { isWorkbenchRequest, readBody, sendJson } from './localApi.js';
import { organizeSources } from './organizeSources.js';
import { browserConnectionFrom } from './modelSettings.js';

function reviewStatus(review, total) {
  if (!review) return 'pending';
  return review.covered === total && !review.failed ? 'ready' : 'partial';
}

export function createOrganizationHandler(getModelConfig, memory) {
  const running = new Map();

  return async (request, response, user) => {
    if (!isWorkbenchRequest(request)) return sendJson(response, 403, { error: '智能整理仅供本机工作台访问。' });
    const eventId = new URL(request.url, 'http://localhost').searchParams.get('event');
    if (!/^[\w-]{1,128}$/.test(eventId ?? '')) return sendJson(response, 400, { error: '请指定有效的活动。' });
    if (!['GET', 'POST'].includes(request.method)) return sendJson(response, 405, { error: '不支持此操作。' });

    try {
      let browserConfig;
      if (request.method === 'POST' && request.headers['content-type']?.split(';', 1)[0] === 'application/json') {
        const body = await readBody(request, 12 * 1024);
        if (!body) return sendJson(response, 413, { error: '模型配置过长。' });
        let input;
        try { input = JSON.parse(body.toString('utf8')); } catch { return sendJson(response, 400, { error: '模型配置格式无效。' }); }
        if (input?.connection !== undefined) {
          const result = browserConnectionFrom(input.connection, user);
          if (result.error) return sendJson(response, 400, { error: result.error });
          browserConfig = result.config;
        }
      }
      const scope = memory.organizationScope(eventId);
      const review = memory.readOrganization(eventId, scope.revision);
      const status = reviewStatus(review, scope.total);
      const state = { excluded: scope.excluded, unparsed: scope.unparsed, total: scope.total, review };
      if (!scope.total) return sendJson(response, 200, { ...state, status: 'no_sources' });
      if (request.method === 'GET') {
        return sendJson(response, 200, { ...state, status: running.get(eventId)?.revision === scope.revision ? 'running' : status });
      }
      if (status === 'ready') return sendJson(response, 200, { ...state, status });
      let job = running.get(eventId);
      if (job?.revision !== scope.revision) {
        const config = browserConfig ?? getModelConfig();
        if (!config) return sendJson(response, 503, { error: '资料已建立本机索引。请在右上角配置资料整理或 Agent 对话模型后重试。' });
        const previous = job?.promise;
        job = { revision: scope.revision };
        job.promise = (async () => {
          await previous?.catch(() => {});
          const isCurrent = () => memory.organizationScope(eventId).revision === scope.revision;
          if (!isCurrent()) return null;
          // 旧结果没有记录片段位置，从当前资料版本的开头重新核对，保留已提取的原文证据。
          const progress = review?.progress;
          const covered = progress ? review.covered : 0;
          const local = progress ? review.local : 0;
          const retryIds = progress?.failedChunkIds ?? [];
          const after = progress?.after ?? 0;
          const retrying = covered + retryIds.length === scope.total;
          const snapshot = memory.organizationInput(eventId, scope, { after, retryIds: retrying ? retryIds : [] });
          const result = await organizeSources(config, snapshot, isCurrent, undefined, review?.facts);
          if (!result || !isCurrent()) return null;
          const { failedChunkIds, ...page } = result;
          const retried = new Set(retrying ? snapshot.chunks.map(chunk => chunk.chunkId) : []);
          const remainingFailures = [...retryIds.filter(id => !retried.has(id)), ...failedChunkIds];
          const next = {
            ...page, covered: covered + page.covered, local: local + page.local, failed: remainingFailures.length,
            revision: scope.revision,
            progress: { after: retrying ? after : (snapshot.chunks.at(-1)?.chunkId ?? after), failedChunkIds: remainingFailures },
          };
          memory.saveOrganization(eventId, scope.revision, next);
          if (!next.covered) throw new Error('MODEL_EXTRACTION_FAILED');
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
        total: current.total, review: next, status: reviewStatus(next, current.total) });
    } catch (error) {
      if (response.destroyed) return;
      if (error.message === 'MODEL_EXTRACTION_FAILED') {
        return sendJson(response, 502, { error: '模型暂未返回可核验的提取结果。原文索引已保留，可以重试。' });
      }
      sendJson(response, 500, { error: '本机智能整理暂时不可用。' });
    }
  };
}
