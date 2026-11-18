import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { applyReviewFields, conflictEvidenceKey, currentReviewChoice, planFromReview, rebasePlanDraft, reviewChoices } from '../src/organizationSchema.js';
import { readBody, sendJson } from './localApi.js';
import { createOrganizationHandler } from './organizationApi.js';
import { organizeSources } from './organizeSources.js';
import { createProjectMemory } from './projectMemory.js';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'huixu-source-review-'));
  const file = join(directory, 'memory.sqlite');
  const memory = createProjectMemory(process.cwd(), file);
  t.after(async () => { memory.close(); await rm(directory, { recursive: true, force: true }); });
  return { memory, file };
}

async function listen(t, handler) {
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return 'http://127.0.0.1:' + server.address().port;
}

test('长资料续跑保留已有证据，处理完余下资料后只重试失败片段', async t => {
  const { memory } = await fixture(t);
  const paragraphs = Array.from({ length: 281 }, (_, index) => {
    if (index === 14) return '演练圆桌开始时间为14:00。';
    if (index === 280) return '演练圆桌开始时间为14:30。';
    return '演练资料片段 ' + (index + 1);
  });
  await memory.add('forum', '虚构活动资料.txt', Buffer.from(paragraphs.join('\n\n')), true);
  const scope = memory.organizationScope('forum');
  assert.equal(scope.total, 281);
  // 跨版本升级时，旧结果缺少片段位置，但页面仍应提供继续整理。
  memory.saveOrganization('forum', scope.revision, { revision: scope.revision, facts: [], covered: 280, local: 0, failed: 0, total: 281 });

  const attempted = [];
  let rejectFirstBatch = true;
  const provider = await listen(t, async (request, response) => {
    const body = JSON.parse(await readBody(request, 64 * 1024));
    const chunks = JSON.parse(body.messages.at(-1).content);
    attempted.push(chunks.map(({ chunkId }) => chunkId));
    if (rejectFirstBatch && chunks[0].text === paragraphs[0]) return sendJson(response, 503, {});
    const facts = chunks.flatMap(chunk => {
      const time = chunk.text.match(/14:(00|30)/)?.[0];
      return time ? [{ section: 'agenda', entity: '演练圆桌', field: 'start', value: time, chunkId: chunk.chunkId }] : [];
    });
    return sendJson(response, 200, { choices: [{ message: { tool_calls: [{ id: 'facts', type: 'function',
      function: { name: 'record_import_facts', arguments: JSON.stringify({ facts }) } }] } }] });
  });
  const config = { protocol: 'openai', model: 'fixture', url: provider };
  let handle = createOrganizationHandler(() => config, memory);
  const origin = await listen(t, (request, response) => handle(request, response));
  async function request(method = 'GET') {
    const response = await fetch(origin + '/?event=forum', { method });
    assert.equal(response.status, 200);
    return response.json();
  }
  assert.equal((await request()).status, 'partial');
  const first = await request('POST');
  assert.equal(first.status, 'partial');
  assert.equal(first.review.covered, 266);
  assert.equal(first.review.failed, 14);
  assert.equal(first.review.facts[0].options[0].value, '14:00');
  const failedIds = [...attempted[0]];
  assert.equal(attempted.flat().length, 280);

  // 模拟重启，并从已经保存的片段位置继续。
  memory.close();
  handle = createOrganizationHandler(() => config, memory);
  const more = await request('POST');
  assert.equal(more.status, 'partial');
  assert.equal(more.review.covered, 267);
  assert.deepEqual(more.review.facts[0].options.map(item => item.value), ['14:00', '14:30']);
  assert.equal(attempted.at(-1).length, 1);
  rejectFirstBatch = false;
  const complete = await request('POST');
  assert.equal(complete.status, 'ready');
  assert.equal(complete.review.covered, 281);
  assert.equal(complete.review.failed, 0);
  assert.deepEqual(attempted.at(-1), failedIds);
  assert.deepEqual(complete.review.facts, more.review.facts);
  assert.equal((await request('POST')).status, 'ready');
  assert.equal(attempted.flat().length, 281 + failedIds.length);
});

test('历史原件可替换为新版本，迁移后保留原文引用与核对记录，普通导入继续去重', async t => {
  const { memory, file } = await fixture(t);
  const name = '会场.txt';
  const old = Buffer.from('会场有八十个座位');
  const first = (await memory.add('forum', name, old, true)).source;
  const excerpt = memory.firstExcerpt('forum', first.id);
  memory.reviewSource('forum', first.id, '已确认', '人工核实', 0);
  memory.close();
  const legacy = new DatabaseSync(file);
  try {
    legacy.exec('DROP INDEX memory_sources_hash; CREATE UNIQUE INDEX legacy_digest ON memory_sources(event_id, name, hash)');
  } finally { legacy.close(); }
  const second = (await memory.add('forum', name, Buffer.from('会场有六十个座位'), true, first.id)).source;
  assert.equal((await memory.add('forum', name, old, true)).duplicate, true);
  assert.deepEqual(memory.list('forum').filter(item => item.current).map(item => item.id), [second.id]);
  assert.equal(memory.excerpt('forum', excerpt.chunkId).excerpt, '会场有八十个座位');
  assert.equal(memory.list('forum').find(item => item.id === first.id).reviewNote, '人工核实');
  await assert.rejects(memory.add('forum', name, old, true, first.id), { status: 409 });
  const third = await memory.add('forum', name, old, true, second.id);
  assert.equal(third.duplicate, false);
  assert.equal(third.source.revision, 3);
  assert.deepEqual(memory.search('forum', '座位', true).map(hit => hit.sourceId), [third.source.id]);
  assert.equal((await memory.add('forum', name, old, true)).source.id, third.source.id);
  assert.deepEqual(Buffer.from(memory.original('forum', second.id).original), Buffer.from('会场有六十个座位'));
});

test('资料状态独立保存，停用退出检索与提取，跨连接恢复有效', async t => {
  const { memory, file } = await fixture(t);
  const { source } = await memory.add('forum', '场地说明.txt', Buffer.from('演练星港会场有90个座位。'), true);
  const before = memory.organizationScope('forum');
  const confirmed = memory.reviewSource('forum', source.id, '已确认', '已核实', 0);
  assert.equal(confirmed.reviewStatus, '已确认');
  assert.equal(memory.organizationScope('forum').revision, before.revision);
  assert.throws(() => memory.reviewSource('forum', source.id, '已停用', '', 0), { status: 409 });
  memory.reviewSource('forum', source.id, '已停用', '暂停使用', confirmed.reviewVersion);
  assert.equal(memory.search('forum', '星港', true).length, 0);
  assert.equal(memory.organizationScope('forum').total, 0);
  const other = createProjectMemory(process.cwd(), file);
  try {
    const saved = other.list('forum')[0];
    assert.equal(saved.reviewStatus, '已停用');
    other.reviewSource('forum', source.id, '待核对', '重新核对', saved.reviewVersion);
    assert.equal(other.search('forum', '星港', true).length, 1);
  } finally { other.close(); }
});

test('只修订一个片段并更新索引，保留原件和其他资料，过期编辑被拒绝', async t => {
  const { memory } = await fixture(t);
  const original = Buffer.from('活动在原始星港会场举行。');
  const { source } = await memory.add('forum', '会场说明.txt', original, true);
  const untouched = (await memory.add('forum', '人员说明.txt', Buffer.from('演练讲者为周宁。'), true)).source;
  const otherBefore = memory.firstExcerpt('forum', untouched.id);
  const before = memory.firstExcerpt('forum', source.id);
  const scope = memory.organizationScope('forum');
  const result = memory.editExcerpt('forum', source.id, { chunkId: before.chunkId, textRevision: 0, text: '活动改在更新晨光会场举行。', note: '负责人已更正场地' });
  assert.equal(result.excerpt.textRevision, 1);
  assert.equal(result.excerpt.originalExcerpt, before.excerpt);
  assert.deepEqual(Buffer.from(memory.original('forum', source.id).original), original);
  assert.deepEqual(memory.firstExcerpt('forum', untouched.id), otherBefore);
  assert.equal(memory.search('forum', '原始星港').length, 0);
  assert.equal(memory.search('forum', '更新晨光')[0].textRevision, 1);
  assert.notEqual(memory.organizationScope('forum').revision, scope.revision);
  assert.throws(() => memory.editExcerpt('forum', source.id, { chunkId: before.chunkId, textRevision: 0, text: '过期覆盖', note: '' }), { status: 409 });
  assert.throws(() => memory.editExcerpt('other-event', source.id, { chunkId: before.chunkId, textRevision: 1, text: '跨活动覆盖', note: '' }), { status: 409 });
  assert.equal(memory.firstExcerpt('forum', source.id).excerpt, '活动改在更新晨光会场举行。');
  const empty = (await memory.add('forum', '待补资料.txt', Buffer.from(' \n'), false)).source;
  assert.equal(empty.chunkCount, 0);
  const filled = memory.editExcerpt('forum', empty.id, { textRevision: 0, text: '人工补录一份现场说明。', note: '由负责人补录' });
  assert.equal(filled.source.chunkCount, 1);
  assert.equal(filled.excerpt.originalExcerpt, '');
});

test('字段可改值、忽略或重新核对，局部更新保留草稿手工内容和其他确认', async t => {
  const { memory } = await fixture(t);
  await memory.add('forum', '议程.csv', Buffer.from('环节名称,开始时间,结束时间,会场\n演练圆桌,14:00,14:40,A 厅'), true);
  await memory.add('forum', '场地.csv', Buffer.from('场地名称,场地容量\n演练会场,90'), true);
  const scope = memory.organizationScope('forum');
  const review = await organizeSources(null, memory.organizationInput('forum', scope), () => true);
  const start = review.facts.find(fact => fact.field === 'start');
  const capacity = review.facts.find(fact => fact.field === 'capacity');
  assert.ok(start && capacity);
  const saved = {
    [start.key]: { value: '15:00', status: '已确认', note: '负责人改时', evidence: conflictEvidenceKey(start) },
    [capacity.key]: { value: '90', evidence: conflictEvidenceKey(capacity) },
  };
  const choices = reviewChoices(review, saved);
  const plan = { ...planFromReview(review, {}), id: 'keep-plan', event: { title: '手工活动名称', budget: '12000' }, tasks: [{ id: 'hand-task', name: '手工筹备任务' }] };
  plan.agenda[0].room = '手工保留会场';
  const updated = applyReviewFields(plan, review, choices, [start.key]);
  assert.equal(updated.id, 'keep-plan');
  assert.equal(updated.agenda[0].start, '15:00');
  assert.equal(updated.agenda[0].room, '手工保留会场');
  assert.deepEqual(updated.event, plan.event);
  assert.deepEqual(updated.tasks, plan.tasks);
  const ignored = reviewChoices(review, { ...saved, [start.key]: { ...saved[start.key], status: '已忽略' } });
  assert.equal(planFromReview(review, ignored).agenda[0].start, undefined);
  const pending = reviewChoices(review, { ...saved, [start.key]: { ...saved[start.key], status: '待核对' } });
  assert.equal(planFromReview(review, pending).agenda[0].start, undefined);
  const changed = { ...start, options: start.options.map(option => ({ ...option, evidence: option.evidence.map(item => ({ ...item, textRevision: 1 })) })) };
  assert.equal(currentReviewChoice(changed, saved), null);
  assert.ok(currentReviewChoice(capacity, saved));
});

test('生成和局部同步草稿按核对结果填写名称，其他字段和旧版实体名可保留', () => {
  for (const [section, field] of Object.entries({ agenda: 'room', roster: 'role', venues: 'capacity', budgetItems: 'amount' })) {
    const fact = { key: 'name', section, entityKey: 'sample', entity: '样例名称', field: 'name',
      options: [{ value: '样例名称', evidence: [] }] };
    const detail = { ...fact, key: field, field, options: [{ value: '其他值', evidence: [] }] };
    for (const status of ['已忽略', '待核对']) {
      for (const facts of [[fact], [fact, detail], [detail, fact]]) {
        const review = { facts };
        const choices = reviewChoices(review, { name: { value: fact.entity, status, evidence: conflictEvidenceKey(fact) } });
        const [row] = planFromReview(review, choices)[section];
        assert.equal(row.name, undefined);
        if (facts.includes(detail)) {
          assert.equal(row[field], '其他值');
          const synced = applyReviewFields({ event: {}, [section]: [] }, review, choices, [field]);
          assert.equal(synced[section][0].name, undefined);
        }
      }
    }
    assert.equal(planFromReview({ facts: [detail] }, {})[section][0].name, '样例名称');
    assert.equal(planFromReview({ facts: [detail, fact] }, { name: '负责人修订' })[section][0].name, '负责人修订');
  }
});

test('局部同步也保留尚未保存的文本、增删行，并接收其他字段的最新值', () => {
  const previous = { event: { title: '原活动', venue: '原场地' }, agenda: [{ id: 'a', name: '圆桌', start: '14:00', end: '14:40' }, { id: 'b', name: '旧环节' }] };
  const next = { ...previous, event: { ...previous.event, venue: '新场地' }, agenda: [{ ...previous.agenda[0], start: '14:10' }, previous.agenda[1]] };
  const edited = { event: { ...previous.event, title: '未保存标题' }, agenda: [{ ...previous.agenda[0], end: '14:50' }, { id: 'c', name: '手工新增' }] };
  const draft = rebasePlanDraft(previous, next, edited);
  assert.deepEqual(draft.event, { title: '未保存标题', venue: '新场地' });
  assert.deepEqual(draft.agenda, [{ id: 'a', name: '圆桌', start: '14:10', end: '14:50' }, { id: 'c', name: '手工新增' }]);
});
