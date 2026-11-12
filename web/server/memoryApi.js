import { isLocalRequest, readBody, sendJson } from './localApi.js';
import { isSupportedSource } from './sourceParser.js';
import { isArchiveName } from '../src/sourceFormats.js';

const fileLimit = 12 * 1024 * 1024;
const archiveLimit = 48 * 1024 * 1024;

export function createMemoryHandler(memory) {
  let activeImports = 0;
  return async (request, response) => {
    if (!isLocalRequest(request)) return sendJson(response, 403, { error: '活动索引仅供本机工作台访问。' });
    const url = new URL(request.url, 'http://localhost');
    const eventId = url.searchParams.get('event');
    if (!/^[\w-]{1,128}$/.test(eventId ?? '')) return sendJson(response, 400, { error: '请指定有效的活动。' });
    const sourceId = url.searchParams.get('source');
    const view = url.searchParams.get('view');

    try {
      if (request.method === 'GET') {
        if (view === 'search') return sendJson(response, 200, { hits: memory.search(eventId, (url.searchParams.get('q') ?? '').slice(0, 180)) });
        if (view === 'wiki') {
          const markdown = memory.wiki(eventId);
          if (url.searchParams.get('download') !== '1') return sendJson(response, 200, { markdown });
          response.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Cache-Control': 'no-store',
            'Content-Disposition': 'attachment; filename="activity-index.md"', 'X-Content-Type-Options': 'nosniff' });
          response.end(markdown);
          return;
        }
        if (view === 'excerpt') {
          const chunkId = Number(url.searchParams.get('chunk'));
          const excerpt = chunkId > 0 && Number.isSafeInteger(chunkId) ? memory.excerpt(eventId, chunkId) : memory.firstExcerpt(eventId, sourceId ?? '');
          return excerpt ? sendJson(response, 200, { excerpt }) : sendJson(response, 404, { error: '该活动下没有此原文片段。' });
        }
        if (view === 'contents') {
          const contents = memory.contents(eventId, sourceId ?? '');
          return contents ? sendJson(response, 200, { contents }) : sendJson(response, 404, { error: '该活动下没有此压缩包。' });
        }
        if (view === 'download') {
          const file = memory.original(eventId, sourceId ?? '');
          if (!file) return sendJson(response, 404, { error: '该活动下没有此原文件。' });
          const encodedName = encodeURIComponent(file.name).replace(/['()*]/g, char => '%' + char.charCodeAt(0).toString(16));
          response.writeHead(200, {
            'Content-Type': 'application/octet-stream', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store',
            'Content-Disposition': `attachment; filename*=UTF-8''${encodedName}`,
          });
          response.end(file.original);
          return;
        }
        return sendJson(response, 200, { sources: memory.list(eventId) });
      }

      if (request.method === 'PATCH') {
        const content = await readBody(request, 1024);
        let input;
        try { input = content && JSON.parse(content.toString('utf8')); } catch { /* 下面统一校验字段。 */ }
        if (!sourceId || typeof input?.agentAccess !== 'boolean') return sendJson(response, 400, { error: '请选择资料及引用权限。' });
        if (!memory.setAgentAccess(eventId, sourceId, input.agentAccess)) return sendJson(response, 404, { error: '该资料没有可授权的当前索引。' });
        return sendJson(response, 200, { updated: true });
      }

      if (request.method !== 'POST') return sendJson(response, 405, { error: '不支持此操作。' });
      const name = url.searchParams.get('name')?.trim();
      if (!name || name.length > 200 || /[\\/\x00-\x1f]/.test(name) || !isSupportedSource(name)) return sendJson(response, 400, { error: '文件名或格式不受支持。' });
      if (request.headers['content-type'] !== 'application/octet-stream') return sendJson(response, 415, { error: '请提交原文件内容。' });
      const maximum = isArchiveName(name) ? archiveLimit : fileLimit;
      const sizeError = { error: isArchiveName(name) ? '单个压缩包最多 48 MB。' : '单个文件最多 12 MB。' };
      if (Number(request.headers['content-length']) > maximum) return sendJson(response, 413, sizeError);
      if (activeImports >= 2) return sendJson(response, 429, { error: '有资料正在解析，请稍后重试。' });
      activeImports += 1;
      try {
        const buffer = await readBody(request, maximum);
        if (!buffer) return sendJson(response, 413, sizeError);
        if (!buffer.length) return sendJson(response, 400, { error: '文件为空。' });
        const agentAccess = url.searchParams.get('agent') === '1';
        const result = await memory.add(eventId, name, buffer, agentAccess);
        if (agentAccess && !result.source.agentAccess && memory.setAgentAccess(eventId, result.source.id, true)) {
          result.source.agentAccess = 1;
        }
        return sendJson(response, 200, result);
      } finally {
        activeImports -= 1;
      }
    } catch {
      if (!response.destroyed) sendJson(response, 500, { error: '本机资料索引暂时不可用。' });
    }
  };
}
