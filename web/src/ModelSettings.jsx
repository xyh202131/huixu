import { useEffect, useRef, useState } from 'react';
import { sessionExpired } from './authClient';
import { Tabs } from './components';
import { Dialog, Notice, Popconfirm } from './interactions';
import { modelPresets } from './modelPresets';
import { Select } from './Select';

const providers = [...Object.entries(modelPresets).map(([value, { label }]) => ({ value, label })), { value: 'custom', label: '自定义接口' }];
const protocols = [{ value: 'openai', label: 'OpenAI · Chat Completions' }, { value: 'anthropic', label: 'Anthropic · Messages' }];
const keyHeaders = [{ value: 'x-api-key', label: 'x-api-key' }, { value: 'bearer', label: 'Authorization · Bearer' }];
const chatLabel = 'Agent 对话';
const organizationLabel = '资料整理';

async function settingsRequest({ purpose, method = 'GET', test = false, input, signal }) {
  const path = test ? '/api/model-settings/test' : '/api/model-settings';
  const response = await fetch(`${path}?purpose=${purpose}`, {
    method, signal,
    ...(input && { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) }),
  });
  if (response.status === 401) window.dispatchEvent(new Event(sessionExpired));
  if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('本机模型设置服务不可用。');
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '模型设置请求失败。');
  return data;
}

function settingsFields(provider, saved) {
  if (provider === saved?.provider) return { ...saved, apiKey: '' };
  const preset = modelPresets[provider];
  return { provider, model: preset?.model ?? '', baseUrl: preset?.baseUrl ?? '', protocol: preset?.protocol ?? 'openai',
    keyHeader: preset?.keyHeader ?? 'x-api-key', apiKey: '' };
}

function ModelSettingsForm({ purpose }) {
  const [status, setStatus] = useState(null);
  const [form, setForm] = useState(() => settingsFields('openai'));
  const [busy, setBusy] = useState('load');
  const [feedback, setFeedback] = useState(null);
  const request = useRef(null);
  const { active, source } = status ?? {};
  const saved = source === 'workbench' ? active : null;
  const isOrganization = purpose === 'organization';
  const custom = form.provider === 'custom';
  const keepKey = saved?.hasKey && saved.provider === form.provider && (!custom || (
    saved.protocol === form.protocol && saved.baseUrl === form.baseUrl.trim() &&
    (form.protocol !== 'anthropic' || saved.keyHeader === form.keyHeader)
  ));

  function applyStatus(next) {
    setStatus(next);
    const saved = next.source === 'workbench' ? next.active : null;
    setForm(settingsFields(saved?.provider ?? 'openai', saved));
  }

  async function load(signal) {
    setFeedback(null);
    setBusy('load');
    try {
      const next = await settingsRequest({ purpose, signal });
      if (!signal.aborted) applyStatus(next);
    } catch (error) {
      if (!signal.aborted) setFeedback({ tone: 'error', text: error.message });
    } finally {
      if (!signal.aborted) setBusy('');
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    request.current = controller;
    void load(controller.signal);
    return () => controller.abort();
  }, [purpose]);

  function update(field, value) {
    setFeedback(null);
    setForm(previous => ({ ...previous, [field]: value }));
  }

  async function submit(action) {
    if (busy) return;
    const signal = request.current.signal;
    setFeedback(null);
    setBusy(action);
    try {
      if (action === 'remove') {
        const next = await settingsRequest({ purpose, method: 'DELETE', signal });
        if (signal.aborted) return;
        applyStatus(next);
        setFeedback({ tone: 'success', text: '工作台配置已移除。' });
        return;
      }
      const { provider, protocol, baseUrl, model, keyHeader, apiKey } = form;
      const test = action === 'test' || action === 'test-current';
      const input = action === 'test-current' ? { useCurrent: true }
        : { provider, protocol, baseUrl, model, keyHeader, apiKey, keyRevision: keepKey ? saved.revision : undefined };
      const next = await settingsRequest({ purpose, method: 'POST', test, input, signal });
      if (signal.aborted) return;
      if (test) {
        const text = isOrganization ? '资料提取测试通过，两条冲突时间均有原文出处。' : '连接与工具调用测试通过。';
        setFeedback({ tone: 'success', text });
        return;
      }
      applyStatus(next);
      setFeedback({ tone: 'success', text: isOrganization ? '资料整理模型已启用。' : 'Agent 对话模型已启用。' });
    } catch (error) {
      if (!signal.aborted) setFeedback({ tone: 'error', text: error.message });
    } finally {
      if (!signal.aborted) setBusy('');
    }
  }

  if (!status) return <>
    {busy ? <Notice announce>正在读取模型设置。</Notice> : <>
      {feedback && <Notice tone="error" announce>{feedback.text}</Notice>}
      <div className="actions"><button type="button" className="button" onClick={() => load(request.current.signal)}>重试</button></div>
    </>}
  </>;

  let activeLabel = '尚未启用模型。';
  if (source === 'shared') activeLabel = active ? `沿用 Agent 对话模型 · ${active.model}` : '默认沿用 Agent 对话模型。当前尚未配置模型。';
  else if (active) {
    const sourceLabel = source === 'environment' ? '环境变量' : modelPresets[active.provider]?.label ?? '自定义接口';
    activeLabel = `当前使用 ${sourceLabel} · ${active.model}`;
  }
  return <>
    <Notice>{activeLabel}</Notice>
    {source === 'shared' && active && <div className="actions">
      <button type="button" className="button small" disabled={Boolean(busy)} onClick={() => submit('test-current')}>
        {busy === 'test-current' ? '正在测试…' : '测试当前整理模型'}
      </button>
    </div>}
    <form className="form-stack" aria-busy={Boolean(busy)} onSubmit={event => {
      event.preventDefault();
      void submit(event.nativeEvent.submitter?.value === 'test' ? 'test' : 'save');
    }}>
      <fieldset className="form-stack model-settings-fields" disabled={Boolean(busy)}>
        <Select label="服务商" options={providers} value={form.provider} onChange={provider => {
          setFeedback(null);
          setForm(settingsFields(provider, saved));
        }} />
        {custom && <>
          <Select label="接口协议" options={protocols} value={form.protocol} onChange={value => update('protocol', value)} />
          <label>接口地址<input type="url" required maxLength={2048} value={form.baseUrl} onChange={event => update('baseUrl', event.target.value)}
            placeholder={form.protocol === 'openai' ? 'https://example.com/v1' : 'https://example.com'} /></label>
          {form.protocol === 'anthropic' && <Select label="鉴权方式" options={keyHeaders} value={form.keyHeader} onChange={value => update('keyHeader', value)} />}
        </>}
        <label>{custom ? '模型名称' : '模型名称（可修改）'}<input required={custom} maxLength={160} value={form.model} onChange={event => update('model', event.target.value)}
          placeholder={modelPresets[form.provider]?.model} /></label>
        <label>API Key{custom && !keepKey ? '（如接口需要）' : ''}<input type="password" autoComplete="off" spellCheck={false}
          required={!custom && !keepKey} maxLength={4096} value={form.apiKey} onChange={event => update('apiKey', event.target.value)}
          placeholder={keepKey ? '已保存，留空沿用' : '填写服务商 API Key'} /></label>
        <p className="muted">{isOrganization ? '填写后为非结构化资料指定独立模型。测试使用演练资料核对冲突字段与原文出处。'
          : '密钥由本机服务保存。测试使用示例问题验证工具调用和结果回传。'}</p>
      </fieldset>
      {feedback && <Notice tone={feedback.tone} announce>{feedback.text}</Notice>}
      <div className="actions">
        {saved && !busy && <Popconfirm label="移除配置" confirmLabel="确认移除"
          description={isOrganization ? '移除后删除此用途的 API Key，资料整理恢复沿用 Agent 对话模型。'
            : '移除后删除此用途的 API Key，并恢复环境变量配置（如有）。'} onConfirm={() => submit('remove')} />}
        <button type="submit" value="test" className="button" disabled={Boolean(busy)}>
          {busy === 'test' ? '正在测试…' : isOrganization ? '测试资料提取' : '测试连接'}
        </button>
        <button type="submit" value="save" className="button primary" disabled={Boolean(busy)}>{busy === 'save' ? '正在保存…' : '保存并启用'}</button>
      </div>
    </form>
  </>;
}

export function ModelSettings({ account, openAccount, close }) {
  const [label, setLabel] = useState(chatLabel);
  const purpose = label === organizationLabel ? 'organization' : 'chat';
  return <Dialog title="模型设置" fullOnMobile close={close}>
    {account ? <>
      <Tabs label="模型用途" items={[chatLabel, organizationLabel]} value={label} onChange={setLabel} />
      <ModelSettingsForm key={purpose} purpose={purpose} />
    </> : <>
      <p className="muted">登录工作台后可配置 Agent 和资料整理使用的模型。</p>
      <div className="actions"><button type="button" className="button primary" onClick={openAccount}>前往登录</button></div>
    </>}
  </Dialog>;
}
