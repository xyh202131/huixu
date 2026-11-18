import { createServer } from 'node:http';
import { createReadStream, constants } from 'node:fs';
import { access, mkdir, stat } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { allowHostedRequest, restoreHostedMethod, sendJson } from './localApi.js';
import { publicRegistrationOrigin } from './registrationMail.js';
import { createWorkbench } from './workbench.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const dist = join(root, 'dist');
const data = process.env.HUIXU_DATA_DIR || '/mnt/workspace/huixu';
const publicOrigin = publicRegistrationOrigin(process.env.HUIXU_PUBLIC_ORIGIN);
if (!publicOrigin) throw new Error('请在运行时配置 HUIXU_PUBLIC_ORIGIN 为创空间的 HTTPS 应用源。');
const port = Number(process.env.HUIXU_PORT || '7860');
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('HUIXU_PORT 必须是有效的端口号。');
await mkdir(data, { recursive: true, mode: 0o700 });
await access(data, constants.W_OK);
await access(join(dist, 'index.html'), constants.R_OK);
process.env.HUIXU_HOSTED = '1';
const workbench = createWorkbench(root, {
  ...process.env,
  HUIXU_AUTH_DB: join(data, 'auth.sqlite'),
  HUIXU_MEMORY_DB: join(data, 'memory.sqlite'),
  HUIXU_MODEL_DB: join(data, 'models.sqlite'),
  HUIXU_REGISTRATION_DB: join(data, 'registration.sqlite'),
}, publicOrigin);
const routes = Object.entries(workbench.routes);
const types = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.webp': 'image/webp', '.png': 'image/png', '.ico': 'image/x-icon', '.svg': 'image/svg+xml',
};

async function handle(request, response) {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Content-Security-Policy', "frame-ancestors 'self' https://modelscope.cn https://www.modelscope.cn");
  const [path, query] = request.url.split(/\?(.*)/s, 2);
  if (path === '/healthz' && request.method === 'GET') return sendJson(response, 200, { status: 'ok' });
  if (path.startsWith('/api/')) {
    if (!allowHostedRequest(request, publicOrigin)) return sendJson(response, 403, { error: '请从会序的应用地址访问。' });
    const route = routes.find(([prefix]) => path === prefix || path.startsWith(prefix + '/'));
    if (!route) return sendJson(response, 404, { error: '接口不存在。' });
    const [prefix, handler] = route;
    if (!restoreHostedMethod(request, prefix)) return sendJson(response, 405, { error: '此接口不支持转换请求方法。' });
    request.url = (path.slice(prefix.length) || '/') + (query ? '?' + query : '');
    return handler(request, response);
  }
  if (!['GET', 'HEAD'].includes(request.method)) return sendJson(response, 405, { error: '不支持此请求。' });
  // 只对外提供构建后的页面、静态资源和公开素材。
  const asset = path === '/' ? 'index.html' : path.slice(1);
  const type = types[extname(asset)];
  if (!/^(?:assets\/)?[\w-][\w.-]*$/.test(asset) || !type) return sendJson(response, 404, { error: '页面或文件不存在。' });
  const file = join(dist, asset);
  const info = await stat(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
  if (!info?.isFile()) return sendJson(response, 404, { error: '页面或文件不存在。' });
  response.writeHead(200, { 'Content-Type': type, 'Content-Length': info.size,
    'Cache-Control': asset.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'no-cache' });
  if (request.method === 'HEAD') return response.end();
  createReadStream(file).on('error', () => response.destroy()).pipe(response);
}

const server = createServer({ requestTimeout: 180000 }, (request, response) => {
  handle(request, response).catch(() => {
    if (response.destroyed) return;
    if (response.headersSent) return response.destroy();
    sendJson(response, 500, { error: '会序服务暂时不可用。' });
  });
});
server.once('close', workbench.close);
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => server.close());
server.listen(port, '0.0.0.0', () => console.info('会序监听端口 ' + port));
