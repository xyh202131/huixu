import assert from 'node:assert/strict';
import { test } from 'node:test';
import { designPlanSource, designPrompt } from '../src/designPrompts.js';
import { initialEvents } from '../src/model.js';
import { missingPlanFields } from '../src/organizationSchema.js';
import { createTopicEvent, referencePlan } from '../src/topicPlan.js';

const input = { topic: '校园 AI 工具分享会', date: '', target: '', venue: '', budget: '', audience: '', people: [] };

test('主题可以独立起草，未知事实留在草稿中待补', () => {
  const event = createTopicEvent(input, null);
  assert.equal(event.type, '校园活动');
  assert.equal(event.capacity, 0);
  assert.equal(event.date, '');
  assert.equal(event.venue, '场地待确认');
  assert.deepEqual(event.agenda, []);
  assert.equal(event.formOpen, false);
  const plan = event.organizedPlan;
  assert.ok(plan.agenda.some(row => row.name.includes(input.topic)));
  assert.ok(plan.roles.length && plan.supplies.length && plan.budgetItems.length && plan.tasks.length);
  assert.deepEqual(plan.roster, []);
  assert.ok(missingPlanFields(plan).includes('活动日期'));
  assert.ok(missingPlanFields(plan).includes('预算总额（元）'));
});

test('复用历史结构，但日期、金额和人员以本场输入为准', () => {
  const [history] = initialEvents();
  const reference = referencePlan(history);
  const event = createTopicEvent({ ...input, people: ['测试嘉宾甲', '测试嘉宾乙'], target: '30', budget: '400.50' }, reference);
  assert.equal(event.capacity, 30);
  assert.equal(event.budget, 400.5);
  const plan = event.organizedPlan;
  assert.equal(plan.reference.title, history.title);
  assert.equal(plan.reference.version, history.version);
  assert.deepEqual(plan.roster.map(row => row.name), ['测试嘉宾甲', '测试嘉宾乙']);
  assert.equal(plan.agenda[0].duration, reference.slots[0].toString());
  assert.equal(plan.tasks[0].name, history.tasks[0].name);
  assert.equal(plan.tasks[0].owner, undefined);
  assert.equal(plan.event.venue, '');
  assert.ok(plan.budgetItems.every(row => !row.amount));
});

test('两类提示词采用当前保存值，过滤私有字段和本机链接', () => {
  const event = createTopicEvent({ ...input, people: ['内部成员甲'], budget: '45000', venue: '旧址', date: '2026-12-08' }, null);
  const draft = event.organizedPlan;
  draft.event.date = '2027-01-12';
  draft.event.venue = '新址';
  draft.event.registrationUrl = 'http://localhost:5173/#/public/demo';
  assert.equal(designPlanSource(event).registration, '［公开报名链接或二维码待补］');
  draft.event.registrationUrl = 'https://events.example.com/register';
  draft.agenda[0] = { ...draft.agenda[0], name: '新的主题环节', start: '09:00', end: '09:30', host: '内部讲者' };
  const source = designPlanSource(event);
  for (const [kind, format] of [['PPT', '8'], ['海报', '4:5 竖版社媒图']]) {
    const prompt = designPrompt(source, { kind, format });
    assert.match(prompt, /2027-01-12/);
    assert.match(prompt, /新址/);
    assert.match(prompt, /新的主题环节（09:00–09:30）/);
    assert.match(prompt, /https:\/\/events\.example\.com\/register/);
    assert.doesNotMatch(prompt, /2026-12-08|旧址|45000|内部成员甲|内部讲者/);
  }
});
