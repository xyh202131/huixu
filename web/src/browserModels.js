import { modelPresets } from './modelPresets.js';

function openModels() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('huixu-models', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('connections');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('浏览器无法保存模型配置，请检查站点存储权限。'));
    request.onblocked = () => reject(new Error('模型配置正在被其他标签页更新，请关闭旧页面后重试。'));
  });
}

async function storedModel(purpose, action, value) {
  const database = await openModels();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction('connections', action === 'get' ? 'readonly' : 'readwrite');
    const store = transaction.objectStore('connections');
    let request;
    if (action === 'get') request = store.get(purpose);
    else if (action === 'save') request = store.put(value, purpose);
    else request = store.delete(purpose);
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

export async function browserModelSettings(purpose = 'chat') {
  const saved = await storedModel(purpose, 'get');
  const active = saved ?? (purpose === 'organization' ? await storedModel('chat', 'get') : null);
  return { saved, active, shared: !saved && purpose === 'organization' };
}

export async function browserModel(purpose = 'chat') {
  return (await browserModelSettings(purpose)).active;
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
  const apiKey = form.apiKey.trim() || (reuseKey ? saved.apiKey : '');
  if ((preset && !apiKey) || apiKey.length > 4096 || (apiKey && !/^[\x21-\x7e]+$/.test(apiKey))) throw new Error('请填写有效的 API Key。');
  return { provider: form.provider, protocol, baseUrl, model, keyHeader, apiKey };
}

export function saveBrowserModel(purpose, config) {
  return storedModel(purpose, 'save', config);
}

export function removeBrowserModel(purpose) {
  return storedModel(purpose, 'remove');
}

export async function testBrowserModel(purpose, connection, signal) {
  const response = await fetch('/api/browser-model-test', {
    method: 'POST', signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ purpose, connection }),
  });
  if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('模型测试服务不可用，请通过会序服务启动工作台。');
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '模型连接测试失败。');
  return result;
}
