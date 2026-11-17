import { useId, useRef, useState } from 'react';
import { Clipboard, Sparkles } from 'lucide-react';
import { Badge, Empty, Panel, Tabs } from './components';
import { Notice } from './interactions';
import { Select } from './Select';
import { designPlanSource, designPrompt } from './designPrompts';

const formats = { PPT: ['4', '6', '8', '10', '12'], 海报: ['4:5 竖版社媒图', '9:16 手机长图', 'A3 竖版印刷'] };

export function DesignMaterials({ event, navigate, notify }) {
  const [kind, setKind] = useState('PPT');
  const source = designPlanSource(event);
  return <Panel title="设计提示词" action={source && <Badge>{source.label}</Badge>} className="design-materials">
    {!source ? <>
      <Empty>保存一份活动方案后，可在这里生成 PPT 和海报提示词。</Empty>
      <button type="button" className="button" onClick={() => navigate('schedule')}>查看方案与议程</button>
    </> : <div className="form-stack">
      <p className="muted">读取已保存的活动信息和议程。生成后可编辑、复制，用到你常用的设计工具。</p>
      <Tabs label="设计类型" items={['PPT', '海报']} value={kind} onChange={setKind} />
      {Object.keys(formats).map(material => <div key={material} hidden={kind !== material}>
        <PromptEditor kind={material} source={source} navigate={navigate} notify={notify} />
      </div>)}
    </div>}
  </Panel>;
}

function PromptEditor({ kind, source, navigate, notify }) {
  const [format, setFormat] = useState(kind === 'PPT' ? '8' : formats.海报[0]);
  const [purpose, setPurpose] = useState('活动介绍');
  const [style, setStyle] = useState('');
  const [preview, setPreview] = useState(null);
  const [copyFailed, setCopyFailed] = useState(false);
  const previewLabel = useRef(null);
  const editorId = useId();
  const editor = useRef(null);
  const sourceKey = JSON.stringify(source);
  const stale = preview && (preview.sourceKey !== sourceKey || preview.format !== format || preview.purpose !== purpose || preview.style !== style);

  async function copy() {
    try {
      await navigator.clipboard.writeText(preview.text);
      setCopyFailed(false);
      notify('已复制' + kind + '提示词');
    } catch {
      editor.current?.focus();
      editor.current?.select();
      setCopyFailed(true);
    }
  }

  return <div className="design-prompt-grid">
    <form className="form-stack design-prompt-options" onSubmit={event => {
      event.preventDefault();
      setPreview({ text: designPrompt(source, { kind, format, purpose, style }), sourceKey, format, purpose, style });
      setCopyFailed(false);
      previewLabel.current?.focus();
    }}>
      <Select label={kind === 'PPT' ? '页数' : '海报规格'} options={formats[kind]} value={format} onChange={setFormat} />
      {kind === 'PPT' && <Select label="PPT 用途" options={['活动介绍', '开场介绍', '分享课件']} value={purpose} onChange={setPurpose} />}
      <label>视觉偏好（选填）<textarea value={style} onChange={event => setStyle(event.target.value)} maxLength={240} rows={3}
        placeholder="例如：现代简洁，突出主题和日期" /></label>
      <button className="button primary"><Sparkles size={16} aria-hidden="true" />{preview ? '重新生成提示词' : '生成' + kind + '提示词'}</button>
      <button type="button" className="link-button" onClick={() => navigate(source.label.endsWith('草稿') ? 'schedule/plan' : 'schedule')}>查看源方案</button>
    </form>
    <div className="form-stack design-prompt-preview">
      <div className="design-prompt-heading">
        <label htmlFor={editorId} ref={previewLabel} tabIndex={-1}>{kind} 提示词预览</label>
        <button type="button" className="button" disabled={!preview?.text.trim() || Boolean(stale)} onClick={copy}>
          <Clipboard size={16} aria-hidden="true" />复制提示词
        </button>
      </div>
      <textarea id={editorId} ref={editor} rows={13} value={preview?.text ?? ''} readOnly={!preview || Boolean(stale)}
        placeholder="生成后在这里预览提示词。" onChange={event => setPreview(current => ({ ...current, text: event.target.value }))} />
      {stale && <Notice tone="warning" announce>源方案或生成设置已更新，请重新生成后复制。</Notice>}
      {copyFailed && <Notice announce>提示词已选中，可通过系统的复制操作复制。</Notice>}
    </div>
  </div>;
}
