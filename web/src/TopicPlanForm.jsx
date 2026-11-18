import { useEffect, useRef, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { sessionExpired } from './authClient';
import { Notice } from './interactions';
import { activityTypes } from './model';
import { Select } from './Select';
import { createTopicEvent, referencePlan, topicActivityType } from './topicPlan';
import { browserModel } from './browserModels';

export function TopicPlanForm({ events, initialTopic, create, ownerId }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const request = useRef(null);
  const pastEvents = events.filter(event => event.version > 0 || event.organizedPlan?.topicPlan);
  useEffect(() => () => request.current?.abort(), []);

  async function generate(event) {
    event.preventDefault();
    if (request.current) return;
    const form = new FormData(event.currentTarget);
    const field = name => String(form.get(name) ?? '').trim();
    const topic = field('topic');
    if (!topic) { setError('请填写活动主题。'); return; }
    const type = field('type') || topicActivityType(topic);
    const input = {
      topic, type, audience: field('audience'), target: field('target') || topic.match(/(\d+)\s*(?:人|位)/)?.[1] || '', date: field('date'), venue: field('venue'),
      budget: field('budget'), people: [...new Set(field('people').split(/\r?\n/).map(name => name.trim()).filter(Boolean))].slice(0, 40),
    };
    const reference = referencePlan(pastEvents.find(item => item.id === field('reference')));
    const controller = new AbortController();
    request.current = controller;
    setPending(true);
    setError('');
    try {
      const connection = await browserModel('chat', ownerId, controller.signal);
      const response = await fetch(ownerId ? '/api/topic-plan' : '/api/browser-topic-plan', {
        method: 'POST', headers: { 'Content-Type': 'application/json', ...(ownerId && { 'X-Huixu-Account': ownerId }) },
        body: JSON.stringify({ topic, type, audience: input.audience, slots: reference?.slots, lessons: reference?.lessons, connection: connection ?? undefined }), signal: controller.signal,
      });
      if (response.status === 401) window.dispatchEvent(new Event(sessionExpired));
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || '无法生成活动方案，请重试。');
      if (!controller.signal.aborted) {
        create(createTopicEvent(input, reference, result.suggestions), [], false, result.fallback || '已生成可编辑的活动方案');
      }
    } catch (problem) {
      if (!controller.signal.aborted) setError(problem.message || '无法生成活动方案，请重试。');
    } finally {
      if (!controller.signal.aborted) { request.current = null; setPending(false); }
    }
  }

  return <form className="form-stack topic-plan-form" onSubmit={generate} aria-busy={pending}>
    <label>活动主题<input name="topic" defaultValue={initialTopic?.slice(0, 100)} maxLength={100} required
      placeholder="例如：社区可持续生活论坛" /></label>
    <Select label="参考活动（选填）" name="reference" options={[{ value: '', label: '不引用过往活动' },
      ...pastEvents.map(event => ({ value: event.id, label: event.title, detail: event.version ? '发布版 v' + event.version : '主题方案草稿' }))]} />
    <p className="muted topic-plan-help">只填写主题即可。选用参考活动时会复用流程结构，并将负责人确认的团队经验交给本次起草模型参考。</p>
    <details className="import-review-detail topic-plan-details">
      <summary>补充已知信息（选填）</summary>
      <div className="form-grid">
        <Select label="活动类型" name="type" options={[{ value: '', label: '根据主题推断' }, ...activityTypes]} />
        <label>目标受众<input name="audience" maxLength={120} placeholder="例如：社区志愿者" /></label>
        <label>预计人数<input name="target" type="number" min={1} max={100000} /></label>
        <label>活动日期<input name="date" type="date" /></label>
        <label>活动地点<input name="venue" maxLength={120} /></label>
        <label>预算总额（元）<input name="budget" type="number" min={0} max={1000000000} step="0.01" /></label>
      </div>
      <label>人员姓名<textarea name="people" maxLength={2000} rows={2} placeholder="每行一位，最多 40 位" /></label>
    </details>
    {error && <Notice tone="warning" announce>{error}</Notice>}
    <button className="button primary" disabled={pending}><Sparkles size={17} aria-hidden="true" />{pending ? '正在生成活动方案…' : '生成活动方案'}</button>
  </form>;
}
