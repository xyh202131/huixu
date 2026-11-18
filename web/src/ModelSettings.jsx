import { useEffect, useRef, useState } from 'react';
import { checkBrowserConnection, loadModelSettings, modelInput, removeModelSettings, saveModelSettings, testServerModel } from './browserModels';
import { Tabs } from './components';
import { Dialog, Notice, Popconfirm } from './interactions';
import { modelPresets } from './modelPresets';
import { Select } from './Select';

const providers = [...Object.entries(modelPresets).map(([value, { label }]) => ({ value, label })), { value: 'custom', label: '自定义接口' }];
const protocols = [{ value: 'openai', label: 'OpenAI · Chat Completions' }, { value: 'anthropic', label: 'Anthropic · Messages' }];
const keyHeaders = [{ value: 'x-api-key', label: 'x-api-key' }, { value: 'bearer', label: 'Authorization · Bearer' }];
const chatLabel = 'Agent 对话';
const organizationLabel = '资料整理';

function settingsFields(provider, saved) {
  if (provider === saved?.provider) return { ...saved, apiKey: '' };
  const preset = modelPresets[provider];
  return { provider, model: preset?.model ?? '', baseUrl: preset?.baseUrl ?? '', protocol: preset?.protocol ?? 'openai',
    keyHeader: preset?.keyHeader ?? 'x-api-key', apiKey: '' };
}

function modelStatusLabel({ active, shared, server, platform }) {
  if (active) {
    if (shared) return '资料整理沿用当前浏览器的 Agent 对话模型 · ' + active.model;
    const provider = modelPresets[active.provider]?.label ?? '自定义接口';
    return '当前使用浏览器配置 · ' + provider + ' · ' + active.model;
  }
  if (server?.active) {
    if (server.source === 'shared') return '资料整理沿用服务端的 Agent 对话模型 · ' + server.active.model;
    const source = { environment: '服务端默认模型', platform: '平台 MiniMax' }[server.source] ?? '服务端账号配置';
    return '当前使用' + source + ' · ' + server.active.model;
  }
  if (server?.problem) return server.problem;
  if (platform) return '自动模式可使用平台 MiniMax · ' + platform;
  return shared ? '资料整理默认沿用 Agent 对话模型。当前尚未配置模型。' : '当前尚未配置模型。';
}

function ModelSettingsForm({ purpose, ownerId }) {
  const [status, setStatus] = useState(null);
  const [form, setForm] = useState(() => settingsFields('openai'));
  const [busy, setBusy] = useState('load');
  const [feedback, setFeedback] = useState(null);
  const request = useRef(null);
  const { active, saved, server } = status ?? {};
  const isOrganization = purpose === 'organization';
  const custom = form.provider === 'custom';
  const keepKey = (saved?.apiKey || saved?.hasKey) && saved.provider === form.provider && (!custom || (
    saved.protocol === form.protocol && saved.baseUrl === form.baseUrl.trim() &&
    (form.protocol !== 'anthropic' || saved.keyHeader === form.keyHeader)
  ));

  function applyStatus(next) {
    setStatus(next);
    const saved = next.saved;
    setForm(settingsFields(saved?.provider ?? 'openai', saved));
  }

  async function load(signal) {
    setFeedback(null);
    setBusy('load');
    try {
      const next = await loadModelSettings(purpose, ownerId, signal);
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
  }, [purpose, ownerId]);

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
        await removeModelSettings(purpose, ownerId, signal);
        const next = await loadModelSettings(purpose, ownerId, signal);
        if (signal.aborted) return;
        applyStatus(next);
        setFeedback({ tone: 'success', text: ownerId ? '当前账号的配置已移除。' : '当前浏览器的访客配置已移除。' });
        return;
      }
      const test = action === 'test' || action === 'test-current';
      const input = action === 'test-current' ? active ?? undefined : modelInput(form, saved);
      if (test) {
        if (ownerId) await testServerModel(purpose, ownerId, signal, input);
        else await checkBrowserConnection(purpose, input, signal);
        if (signal.aborted) return;
        const text = isOrganization ? '资料提取测试通过，两条冲突时间均有原文出处。' : '连接与工具调用测试通过。';
        setFeedback({ tone: 'success', text });
        return;
      }
      await saveModelSettings(purpose, input, ownerId, signal);
      const next = await loadModelSettings(purpose, ownerId, signal);
      if (signal.aborted) return;
      applyStatus(next);
      setFeedback({ tone: 'success', text: ownerId ? '已为当前账号保存并启用。' : '已保存到当前浏览器并启用。' });
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

  return <>
    <Notice tone={server?.problem ? 'warning' : undefined}>{modelStatusLabel(status)}</Notice>
    {(active || server?.active) && <div className="actions">
      <button type="button" className="button small" disabled={Boolean(busy)} onClick={() => submit('test-current')}>
        {busy === 'test-current' ? '正在测试…' : isOrganization ? '测试当前整理模型' : '测试当前对话模型'}
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
        <p className="muted">{ownerId ? 'API Key 由服务端加密保存，只供当前账号使用。' : '配置和密钥保存在当前浏览器的访客区。'}</p>
        <p className="muted">{isOrganization ? '资料整理可单独配置模型。测试使用演练资料核对冲突字段与原文出处。'
          : '测试使用示例问题验证连接、工具调用和结果回传，可能消耗少量模型额度。'}</p>
      </fieldset>
      {feedback && <Notice tone={feedback.tone} announce>{feedback.text}</Notice>}
      <div className="actions">
        {saved && !busy && <Popconfirm label="移除配置" confirmLabel="确认移除"
          description={isOrganization ? '移除独立的资料整理配置，恢复沿用当前身份的 Agent 对话模型。'
            : '移除当前身份保存的 Agent 接口与 API Key。'} onConfirm={() => submit('remove')} />}
        <button type="submit" value="test" className="button" disabled={Boolean(busy)}>
          {busy === 'test' ? '正在测试…' : isOrganization ? '测试资料提取' : '测试连接'}
        </button>
        <button type="submit" value="save" className="button primary" disabled={Boolean(busy)}>{busy === 'save' ? '正在保存…' : '保存并启用'}</button>
      </div>
    </form>
  </>;
}

export function ModelSettings({ close, ownerId }) {
  const [label, setLabel] = useState(chatLabel);
  const purpose = label === organizationLabel ? 'organization' : 'chat';
  return <Dialog title="模型设置" className="model-settings-dialog" fullOnMobile close={close}>
    <Tabs label="模型用途" items={[chatLabel, organizationLabel]} value={label} onChange={setLabel} />
    <ModelSettingsForm key={JSON.stringify([ownerId, purpose])} purpose={purpose} ownerId={ownerId} />
  </Dialog>;
}
