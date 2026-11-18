import assert from 'node:assert/strict';
import { mkdtemp, rmdir, unlink } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { describeRescueImpact } from '../src/changeImpact.js';
import { initialEvents, materialText } from '../src/model.js';
import { rescueOperations, signupSnapshot } from '../src/registrationRules.js';
import { analyzeRescue, rescueSummary, validateRescuePlan } from '../src/rescueScheduling.js';
import { createAgentHandler } from './agent.js';
import { createRegistrationStore } from './registrationStore.js';

const closure = { kind: 'closure', room: 'A', at: '12:50', until: '18:00' };

function sampleForum() {
  const [event] = initialEvents();
  event.actual = { 'session-1': { started: '09:00', ended: '09:20' }, 'session-2': { started: '09:30', ended: '10:30' } };
  event.replies = [
    { id: 'guide-round', role: 'volunteer', name: '演练引导员', sessionId: 'session-3', availability: { start: '12:45', end: '17:30' } },
    { id: 'guide-workshop', role: 'volunteer', name: '演练引导员', sessionId: 'session-4', availability: { start: '12:45', end: '17:30' } },
    { id: 'guest-round', role: 'guest', name: event.agenda[2].guest, sessionId: 'session-3', availability: { start: '12:50', end: '17:30' } },
    { id: 'guest-workshop', role: 'guest', name: event.agenda[3].guest, sessionId: 'session-4', availability: { start: '14:00', end: '17:30' } },
  ];
  return event;
}

test('主会场关闭后整体计算两个环节，备选一起通过全部约束', () => {
  const event = sampleForum();
  const result = analyzeRescue(event, closure);
  assert.deepEqual(result.affected.map(item => item.id), ['session-3', 'session-4']);
  assert.deepEqual(result.unchanged.map(item => item.id), ['session-1', 'session-2']);
  assert.ok(result.plans.length >= 2);
  assert.deepEqual(result.plans[0].moves, [
    { sessionId: 'session-3', room: 'B', start: '13:00', end: '13:45' },
    { sessionId: 'session-4', room: 'C', start: '14:20', end: '15:00' },
  ]);
  assert.match(result.blocked.find(item => item.title === '创新工作坊' && item.room === 'B').reasons.join('、'), /超出 12 人.*缺少无线麦克风/);
  for (const plan of result.plans) assert.deepEqual(validateRescuePlan(event, closure, plan), []);
  const impact = describeRescueImpact(event, result.plans[0]);
  assert.equal(impact.rows[0].impact.checkin.after, 'B 厅门口签到');
  assert.equal(impact.rows[1].impact.checkin.after, 'C 厅门口签到');
  assert.equal(impact.notices.find(item => item.role === '观众').recipients.length, 72);
  const guide = impact.notices.find(item => item.role === '分场引导');
  assert.equal(guide.recipients.length, 1);
  assert.match(guide.body, /城市共创圆桌[\s\S]*创新工作坊/);
});

test('排不开能区分嘉宾可用时段冲突和两个环节的转场冲突', () => {
  const event = sampleForum();
  event.replies.at(-1).availability.end = '14:55';
  const noGuest = analyzeRescue(event, closure);
  assert.deepEqual(noGuest.plans, []);
  assert.match(noGuest.blocked.find(item => item.title === '创新工作坊' && item.room === 'C').reasons.join('、'), /嘉宾可用时段为 14:00–14:55/);
  assert.match(rescueSummary(noGuest), /无可行组合/);

  event.replies.at(-1).availability.end = '15:00';
  const shortWindow = { ...closure, at: '13:35', until: '15:00' };
  const noTransfer = analyzeRescue(event, shortWindow);
  assert.deepEqual(noTransfer.plans, []);
  assert.match(noTransfer.blocked.find(item => item.title === '组合校验').reasons.join('、'), /跨厅转场不足 10 分钟/);
  assert.deepEqual(validateRescuePlan(event, shortWindow, { moves: [
    { sessionId: 'session-3', room: 'B', start: '13:35', end: '14:20' },
    { sessionId: 'session-4', room: 'C', start: '14:20', end: '15:00' },
  ] }).some(issue => issue.includes('跨厅转场不足')), true);
});

test('进行中的环节保留，超时预计结束只用于后续安排', () => {
  const event = sampleForum();
  event.actual['session-3'] = { started: '13:00' };
  const blocked = analyzeRescue(event, { ...closure, at: '13:10' });
  assert.deepEqual(blocked.plans, []);
  assert.match(blocked.blocked[0].reasons[0], /仍在进行/);
  const overrun = { kind: 'overrun', sessionId: 'session-3', at: '13:45', resume: '14:15', until: '16:00' };
  const analysis = analyzeRescue(event, overrun);
  assert.deepEqual(analysis.affected.map(item => item.id), ['session-4']);
  assert.ok(analysis.plans.length);
  assert.ok(analysis.plans.every(plan => !validateRescuePlan(event, overrun, plan).length));
  assert.deepEqual(event.actual['session-3'], { started: '13:00' });
  delete event.actual['session-3'];
  const late = { kind: 'late', sessionId: 'session-3', at: '12:50', resume: '13:35', until: '16:00' };
  const lateAnalysis = analyzeRescue(event, late);
  assert.deepEqual(lateAnalysis.affected.map(item => item.id), ['session-3', 'session-4']);
  assert.ok(lateAnalysis.plans.length);
  assert.ok(lateAnalysis.plans.every(plan => !validateRescuePlan(event, late, plan).length));
});

test('救场只产生一个发布版本，发布阻止过期预览并保持报名、签到和人员通知', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'huixu-rescue-test-'));
  const file = join(directory, 'rescue.sqlite');
  const store = createRegistrationStore(process.cwd(), file);
  t.after(async () => {
    store.close();
    for (const path of [file, file + '-shm', file + '-wal']) {
      await unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
    await rmdir(directory);
  });
  const event = sampleForum();
  const owner = 'rescue-owner';
  const original = store.open(owner, signupSnapshot(event));
  const shared = store.changeEvent(owner, event.id, { revision: original.revision, shared: true, formOpen: true });
  const checked = store.checkIn(owner, event.id, { code: 'G001', sessionId: 'session-4' });
  const preview = () => store.rescuePreview(owner, event.id, {
    revision: store.get(owner, event.id).revision, incident: closure, operations: rescueOperations(event),
  });
  const request = result => ({
    changeId: 'rescue-closure-1', revision: result.state.revision, incident: result.analysis.incident,
    moves: result.analysis.plans[0].moves, proof: result.analysis.plans[0].proof,
  });
  const stale = request(preview());
  const person = store.get(owner, event.id).people.find(person => person.id === 'G001');
  store.savePerson(owner, event.id, person.id, { ...person, note: '测试并发更新' });
  assert.throws(() => store.publishRescue(owner, event.id, stale), /重新计算/);
  const publish = request(preview());
  const tampered = { ...publish, moves: publish.moves.map(move => ({ ...move, room: 'A' })) };
  assert.throws(() => store.publishRescue(owner, event.id, tampered), /预览不一致/);
  const result = store.publishRescue(owner, event.id, publish);
  assert.equal(result.event.version, 2);
  assert.equal(store.publishRescue(owner, event.id, publish).event.version, 2);
  assert.equal(result.rescueReleases.length, 1);
  assert.equal(result.rescueReleases[0].changes.length, 2);
  assert.equal(result.rescueReleases[0].notices.find(item => item.role === '观众').recipients.length, 72);
  assert.deepEqual(result.checkins, checked.state.checkins);
  assert.equal(result.people.find(person => person.id === 'G001').sessionId, 'session-4');
  assert.deepEqual(result.operations.actual, event.actual);
  const publicly = store.publicEvent(shared.publicId);
  assert.deepEqual(publicly.agenda.slice(2).map(item => item.room), ['B', 'C']);
  assert.equal(publicly.agenda[2].guest, undefined);
  assert.match(materialText({ ...result.event, ...result.operations }, '工作人员台本'), /B 厅门口签到[\s\S]*C 厅门口签到/);
  assert.match(materialText({ ...result.event, ...result.operations }, '岗位清单'), /C 厅.*\n签到 · 待分配\n分场引导 · 演练引导员/);
});

test('重新校验保留有效的原选组合，失效时列出原方案和嘉宾冲突', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'huixu-rescue-selection-'));
  const file = join(directory, 'rescue.sqlite');
  const store = createRegistrationStore(process.cwd(), file);
  t.after(async () => {
    store.close();
    for (const path of [file, file + '-shm', file + '-wal']) {
      await unlink(path).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
    await rmdir(directory);
  });
  const event = sampleForum();
  const owner = 'rescue-owner';
  event.rooms.find(room => room.id === 'B').id = '备用厅';
  store.open(owner, signupSnapshot(event));
  const preview = preferredMoves => store.rescuePreview(owner, event.id, {
    revision: store.get(owner, event.id).revision, incident: closure, operations: rescueOperations(event), preferredMoves,
  });
  const original = preview();
  const moves = original.analysis.plans[0].moves;
  const later = [
    { sessionId: 'session-3', room: '备用厅', start: '13:55', end: '14:40' },
    { sessionId: 'session-4', room: 'C', start: '15:50', end: '16:30' },
  ];
  assert.ok(original.analysis.plans.every(plan => plan.moves[1].start !== later[1].start));
  const retained = preview(later);
  assert.equal(retained.invalidatedSelection, null);
  assert.deepEqual(retained.analysis.plans[retained.preferredIndex].moves, later);
  assert.ok(retained.analysis.plans[retained.preferredIndex].proof);

  event.replies.at(-1).availability.start = '15:00';
  const invalid = preview(moves);
  assert.equal(invalid.preferredIndex, -1);
  assert.deepEqual(invalid.invalidatedSelection.moves, moves);
  assert.ok(invalid.invalidatedSelection.issues.some(issue => issue.includes('嘉宾可用时段为 15:00–17:30')));
  assert.ok(invalid.analysis.plans.length > 0);
  assert.ok(invalid.analysis.plans.every(plan => plan.moves[1].start >= '15:00'));
});

test('Agent 调用整场救场工具并返回经过联合校验的方案', async t => {
  let called = false;
  const model = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    const data = JSON.parse(body);
    const previous = data.messages.at(-1);
    let message;
    if (previous.role === 'user') {
      called = data.tools.some(tool => tool.function.name === 'draft_rescue');
      message = { tool_calls: [{ id: 'rescue-call', type: 'function',
        function: { name: 'draft_rescue', arguments: JSON.stringify(closure) } }] };
    } else {
      const toolResult = JSON.parse(previous.content);
      message = { content: rescueSummary(toolResult.proposal.analysis) };
    }
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ choices: [{ message }] }));
  });
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve));
  const handler = createAgentHandler(() => ({ protocol: 'openai', model: 'rescue-test', url: 'http://127.0.0.1:' + model.address().port }));
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await new Promise(resolve => model.close(resolve));
  });
  const event = sampleForum();
  const request = {
    question: 'A 厅临时关闭，安排两个受影响环节。',
    event: { ...event, agenda: event.agenda.map(session => ({ ...session, ...event.actual[session.id], confirmed: session.id === 'session-4' ? 72 : 0 })) },
  };
  const response = await fetch('http://127.0.0.1:' + server.address().port, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request),
  });
  const result = await response.json();
  assert.equal(response.status, 200);
  assert.ok(called);
  assert.equal(result.proposal.kind, 'rescue');
  assert.equal(result.proposal.analysis.affected.length, 2);
  assert.ok(result.proposal.analysis.plans.length);
});
