import { useEffect, useRef, useState } from 'react';
import { browserModelSettings, modelInput, removeBrowserModel, saveBrowserModel, testBrowserModel } from './browserModels';
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

function ModelSettingsForm({ purpose, ownerId }) {
  const [status, setStatus] = useState(null);
  const [form, setForm] = useState(() => settingsFields('openai'));
  const [busy, setBusy] = useState('load');
  const [feedback, setFeedback] = useState(null);
  const request = useRef(null);
  const { active, saved, shared } = status ?? {};
  const isOrganization = purpose === 'organization';
  const custom = form.provider === 'custom';
  const keepKey = saved?.apiKey && saved.provider === form.provider && (!custom || (
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
      const next = await browserModelSettings(purpose, ownerId);
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
        await removeBrowserModel(purpose, ownerId);
        const next = await browserModelSettings(purpose, ownerId);
        if (signal.aborted) return;
        applyStatus(next);
        setFeedback({ tone: 'success', text: '当前浏览器的配置已移除。' });
        return;
      }
      const test = action === 'test' || action === 'test-current';
      const input = action === 'test-current' ? active : modelInput(form, saved);
      if (test) {
        await testBrowserModel(purpose, input, signal);
        if (signal.aborted) return;
        const text = isOrganization ? '资料提取测试通过，两条冲突时间均有原文出处。' : '连接与工具调用测试通过。';
        setFeedback({ tone: 'success', text });
        return;
      }
      await saveBrowserModel(purpose, input, ownerId);
      const next = await browserModelSettings(purpose, ownerId);
      if (signal.aborted) return;
      applyStatus(next);
      setFeedback({ tone: 'success', text: '已保存到当前浏览器并启用。' });
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

  let activeLabel = '当前浏览器尚未配置模型。';
  if (shared) activeLabel = active ? `沿用 Agent 对话模型 · ${active.model}` : '默认沿用 Agent 对话模型。当前尚未配置模型。';
  else if (active) {
    const sourceLabel = modelPresets[active.provider]?.label ?? '自定义接口';
    activeLabel = `当前浏览器使用 ${sourceLabel} · ${active.model}`;
  }
  return <>
    <Notice>{activeLabel}</Notice>
    {shared && active && <div className="actions">
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
        <p className="muted">{ownerId ? '保存后，当前账号可使用此接口处理已授权的活动资料。' : '此配置仅供当前浏览器的访客使用。'} 配置和密钥保存在本浏览器，旧版配置需重新填写。</p>
        <p className="muted">{isOrganization ? '资料整理可单独配置模型。测试使用演练资料核对冲突字段与原文出处。'
          : '测试使用示例问题验证连接、工具调用和结果回传，可能消耗少量模型额度。'}</p>
      </fieldset>
      {feedback && <Notice tone={feedback.tone} announce>{feedback.text}</Notice>}
      <div className="actions">
        {saved && !busy && <Popconfirm label="移除配置" confirmLabel="确认移除"
          description={isOrganization ? '删除当前浏览器的资料整理配置，恢复沿用 Agent 对话模型。'
            : '删除当前浏览器保存的 Agent 接口与 API Key。'} onConfirm={() => submit('remove')} />}
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
    <ModelSettingsForm key={purpose} purpose={purpose} ownerId={ownerId} />
  </Dialog>;
}
