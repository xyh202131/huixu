import { modelPresets } from './modelPresets.js';
import { sessionExpired } from './authClient.js';
import { workbenchFetch } from './workbenchFetch.js';

function openModels() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('huixu-models', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('connections');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('浏览器无法保存模型配置，请检查站点存储权限。'));
    request.onblocked = () => reject(new Error('模型配置正在被其他标签页更新，请关闭旧页面后重试。'));
  });
}

async function storedModel(purpose, ownerId, action, value) {
  // 旧版按用途保存，无法确认归属。新读写只访问当前身份的分区。
  const key = ownerId ? ['owner', ownerId, purpose] : ['guest', purpose];
  const database = await openModels();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction('connections', action === 'get' ? 'readonly' : 'readwrite');
    const store = transaction.objectStore('connections');
    let request;
    if (action === 'get') request = store.get(key);
    else if (action === 'save') request = store.put(value, key);
    else request = store.delete(key);
    transaction.oncomplete = () => {
      database.close();
      resolve(action === 'get' ? request.result ?? null : value);
    };
    transaction.onabort = () => {
      database.close();
      reject(new Error('浏览器模型配置读写失败，请检查可用存储空间。'));
    };
  });
}

async function guestSettings(purpose) {
  const saved = await storedModel(purpose, undefined, 'get');
  const active = saved ?? (purpose === 'organization' ? await storedModel('chat', undefined, 'get') : null);
  return { saved, active, shared: !saved && purpose === 'organization' };
}

export async function browserModel(purpose = 'chat', ownerId, signal) {
  if (ownerId) {
    await migrateOwnerSettings(purpose, ownerId, signal);
    return null;
  }
  try { return (await guestSettings(purpose)).active; } catch { return null; }
}

async function settingsRequest(path, { input, ownerId, signal, method = input === undefined ? 'GET' : 'POST' }) {
  const headers = {};
  if (input !== undefined) headers['Content-Type'] = 'application/json';
  if (ownerId) headers['X-Huixu-Account'] = ownerId;
  const response = await workbenchFetch(path, { method, headers, signal,
    body: input === undefined ? undefined : JSON.stringify(input), cache: 'no-store' });
  if (response.status === 401 && ownerId) window.dispatchEvent(new Event(sessionExpired));
  if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('模型设置服务不可用，请通过会序服务启动工作台。');
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '模型配置操作失败。');
  return result;
}

async function migrateOwnerSettings(purpose, ownerId, signal) {
  const purposes = purpose === 'organization' ? ['chat', 'organization'] : ['chat'];
  await Promise.all(purposes.map(async item => {
    // 只读取旧版已标注当前账号的记录。后端已有配置或已清除时也不会被旧值覆盖。
    try {
      const legacy = await storedModel(item, ownerId, 'get');
      if (!legacy || signal?.aborted) return;
      await settingsRequest('/api/model-settings?purpose=' + item, { input: { ...legacy, importLegacy: true }, ownerId, signal });
      await storedModel(item, ownerId, 'remove');
    } catch {
      // 迁移失败时保留旧记录供重试，当前请求继续由服务器读取已生效的账号设置。
    }
  }));
}

async function loadPlatformModel(signal) {
  try { return (await settingsRequest('/api/platform-model', { signal })).platform?.model; } catch { return undefined; }
}

export async function loadModelSettings(purpose, ownerId, signal) {
  if (!ownerId) {
    const [settings, platform] = await Promise.all([guestSettings(purpose), purpose === 'chat' ? loadPlatformModel(signal) : undefined]);
    return { ...settings, platform };
  }
  await migrateOwnerSettings(purpose, ownerId, signal);
  const server = await settingsRequest('/api/model-settings?purpose=' + purpose, { ownerId, signal });
  return { server, saved: server.source === 'workbench' ? server.active : null, shared: server.source === 'shared' };
}

export async function loadAgentModels(ownerId, signal) {
  const [settings, defaults] = await Promise.allSettled([
    ownerId ? loadModelSettings('chat', ownerId, signal) : guestSettings('chat'), loadPlatformModel(signal),
  ]);
  const current = settings.status === 'fulfilled' ? settings.value : null;
  const personal = current?.active?.model ?? current?.saved?.model;
  const platform = defaults.status === 'fulfilled' ? defaults.value : null;
  return { personal, platform, automatic: personal ?? platform ?? current?.server?.active?.model };
}

export function modelInput(form, saved) {
  const preset = modelPresets[form.provider];
  if (!preset && form.provider !== 'custom') throw new Error('请选择模型服务商。');
  const protocol = preset?.protocol ?? form.protocol;
  const baseUrl = (preset?.baseUrl ?? form.baseUrl).trim();
  let url;
  try { url = new URL(baseUrl); } catch { throw new Error('请输入有效的接口地址。'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (!['openai', 'anthropic'].includes(protocol) || url.username || url.password || url.search || url.hash ||
      (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:'))) {
    throw new Error('请使用 HTTPS 接口地址，或本机 HTTP 地址。');
  }
  const model = form.model.trim() || preset?.model;
  if (!model || model.length > 160 || /[\u0000-\u001f\u007f]/.test(model)) throw new Error('请输入有效的模型名称。');
  const keyHeader = protocol === 'anthropic' && (preset?.keyHeader ?? form.keyHeader) === 'x-api-key' ? 'x-api-key' : 'bearer';
  const reuseKey = saved?.provider === form.provider && saved.protocol === protocol && saved.baseUrl === baseUrl && saved.keyHeader === keyHeader;
  const apiKey = form.apiKey.trim() || (reuseKey ? saved.apiKey ?? '' : '');
  const keyRevision = !apiKey && reuseKey && saved.hasKey ? saved.revision : undefined;
  if ((preset && !apiKey && !keyRevision) || apiKey.length > 4096 || (apiKey && !/^[\x21-\x7e]+$/.test(apiKey))) throw new Error('请填写有效的 API Key。');
  return { provider: form.provider, protocol, baseUrl, model, keyHeader, apiKey, ...(keyRevision && { keyRevision }) };
}

export async function saveModelSettings(purpose, input, ownerId, signal) {
  if (ownerId) {
    await settingsRequest('/api/model-settings?purpose=' + purpose, { input, ownerId, signal });
    return;
  }
  await checkBrowserConnection(purpose, input, signal, { validateOnly: true });
  if (!signal.aborted) await storedModel(purpose, undefined, 'save', input);
}

export async function removeModelSettings(purpose, ownerId, signal) {
  if (ownerId) {
    await settingsRequest('/api/model-settings?purpose=' + purpose, { method: 'DELETE', ownerId, signal });
    return;
  }
  await storedModel(purpose, undefined, 'remove');
}

export function checkBrowserConnection(purpose, connection, signal, { validateOnly = false } = {}) {
  return settingsRequest('/api/browser-model-test', { input: { purpose, connection, validateOnly }, signal });
}

export function testServerModel(purpose, ownerId, signal, input = { useCurrent: true }) {
  return settingsRequest('/api/model-settings/test?purpose=' + purpose, { input, ownerId, signal });
}
