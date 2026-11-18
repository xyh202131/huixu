import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, rmdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newEvent } from '../src/model.js';
import { createTopicEvent, referencePlan } from '../src/topicPlan.js';
import { conflictEvidenceKey } from '../src/organizationSchema.js';
import { adoptExecutionPlan, assessExecutionPlan } from '../src/executionPlan.js';
import { signupSnapshot } from '../src/registrationRules.js';
import { checkCandidate } from '../src/scheduling.js';
import { workspaceDraft, restoreWorkspaceDraft } from '../src/workspaceDraft.js';
import { conversationContext } from '../src/agentConversation.js';
import { workItems, agendaHours } from '../src/workItems.js';
import { createRegistrationStore } from './registrationStore.js';
import { createAgentHandler, confirmedForHits } from './agent.js';

function topic() {
  return createTopicEvent({ topic: '秋季论坛', people: [], date: '', target: '150', venue: '', budget: '', audience: '' });
}

test('只给主题后分派任务，重复采用保留执行身份与人工进度', () => {
  const event = topic();
  const plan = event.organizedPlan;
  let active = adoptExecutionPlan(event, plan);
  const id = active.executionPlan.agenda[0].id;
  assert.equal(active.executionPlan.agenda.length, 4);
  assert.equal(active.tasks.length, 4);
  assert.equal(active.agenda.length, 0);
  assert.ok(assessExecutionPlan(active).issues.length > 0);
  active.tasks[0].owner = '测试统筹';
  active.tasks[0].done = true;
  plan.agenda[0].duration = '60';
  active = adoptExecutionPlan(active, plan);
  assert.equal(active.executionPlan.agenda[0].id, id);
  assert.equal(active.executionPlan.agenda[0].duration, '60');
  assert.equal(active.tasks[0].owner, '测试统筹');
  assert.equal(active.tasks[0].done, true);
  const manual = newEvent({ title: '手工论坛', type: '行业论坛', date: '', capacity: 30 });
  assert.deepEqual([manual.rooms, manual.agenda, manual.tasks], [[], [], []]);
});

test('导入场次日期、容量、冲突与真实时段，概览统计保留所有变更', () => {
  const event = topic();
  const plan = { event: { date: '2027-01-18' }, venues: [{ name: '报告厅', capacity: '80' }],
    agenda: ['上午分享', '下午分享'].map((name, i) => ({ id: '导入:' + i, name, room: '报告厅', start: '10:00', end: '11:00' })) };
  const adopted = adoptExecutionPlan(event, plan);
  assert.match(assessExecutionPlan(adopted).issues.join(' '), /撞场/);
  plan.agenda[1].start = '13:00'; plan.agenda[1].end = '14:30';
  const checked = assessExecutionPlan(adoptExecutionPlan(adopted, plan));
  assert.deepEqual(checked.issues, []);
  assert.equal(agendaHours(checked.agenda), '10:00–14:30');
  plan.agenda[1].expected = '90'; plan.agenda[1].equipment = '无线麦克风';
  const resourceIssues = assessExecutionPlan(adoptExecutionPlan(adopted, plan)).issues.join(' ');
  assert.match(resourceIssues, /预计 90 人/);
  assert.match(resourceIssues, /缺少无线麦克风/);
  assert.equal(agendaHours([]), '时段待定');
  event.change = { id: 'a' }; event.draftChanges = [{ id: 'b' }, event.change];
  event.reviewConflicts = [{ key: '开始/时间', label: '开始时间' }];
  assert.equal(workItems(event).changes.length, 2);
  assert.equal(workItems(event).sources.length, 1);
});

test('两个连接交接私有草稿，过期变更被拒绝；嘉宾受限回流、下载、轮换与撤销', t => {
  const dir = mkdtempSync(join(tmpdir(), 'huixu-draft-check-'));
  const file = join(dir, 'test.sqlite');
  const first = createRegistrationStore(process.cwd(), file), other = createRegistrationStore(process.cwd(), file);
  t.after(() => {
    other.close(); first.close();
    for (const name of [file, file + '-wal', file + '-shm']) if (existsSync(name)) unlinkSync(name);
    rmdirSync(dir);
  });
  const event = topic();
  const owner = 'fixture';
  const plan = event.organizedPlan;
  plan.event.date = '2027-01-18';
  plan.venues = [{ id: 'venues:报告厅', name: '报告厅', capacity: '75' }];
  plan.agenda = [{ id: '导入:环节', name: '论坛工作坊', start: '14:00', end: '15:00', room: '报告厅', host: '嘉宾甲' }];
  const staging = adoptExecutionPlan(event, plan);
  let state = first.open(owner, signupSnapshot(event));
  first.saveDraft(owner, event.id, { revision: 0, data: { ...workspaceDraft(staging), secret: 'unused-test-field' } });
  const saved = other.readDraft(owner, event.id);
  assert.equal(saved.data.secret, undefined);
  assert.equal(restoreWorkspaceDraft(event, saved).tasks.length, 4);
  assert.throws(() => first.saveDraft(owner, event.id, { revision: 0, data: saved.data }), /已有更新/);
  assert.throws(() => first.readDraft('unrelated', event.id), /找不到/);
  const handoff = first.issueHandoff(owner, event.id);
  const sharedTasks = other.taskHandoff(handoff.token);
  assert.deepEqual(Object.keys(sharedTasks).sort(), ['revision', 'tasks', 'title']);
  const edit = { revision: 1, taskId: String(sharedTasks.tasks[0].id), owner: '协作同事', done: false };
  other.taskHandoff(handoff.token, edit);
  assert.equal(first.readDraft(owner, event.id).data.tasks[0].owner, '协作同事');
  assert.throws(() => other.taskHandoff(handoff.token, edit), /已更新/);
  first.revokeHandoff(owner, event.id);
  assert.throws(() => other.taskHandoff(handoff.token), /撤销/);
  assert.equal(state.event.agenda.length, 0);
  const check = assessExecutionPlan(staging);
  assert.match(assessExecutionPlan({ ...staging, capacity: 0 }).issues.join(' '), /报名总名额/);
  const noCapacity = signupSnapshot({ ...staging, ...check, capacity: 0, version: 1 });
  assert.throws(() => other.changeEvent(owner, event.id, { revision: state.revision, event: noCapacity }, true), /报名总名额/);
  assert.equal(first.get(owner, event.id).event.version, 0);
  state = other.changeEvent(owner, event.id, { revision: state.revision, event: signupSnapshot({ ...staging, ...check, version: 1 }) }, true);
  assert.equal(state.event.agenda[0].room, '报告厅');
  const input = { sessionId: state.event.agenda[0].id, taskId: staging.tasks[0].id };
  const link = first.guests.issue(owner, event.id, input);
  const bytes = Buffer.from('%PDF-1.4\nfixture');
  const details = { version: 1, start: '13:00', end: '17:00', filename: '测试课件.pdf' };
  assert.equal(first.guests.view(link.token).availability, null);
  assert.throws(() => other.guests.submit(link.token, { ...details, version: 0 }, bytes), /已更新/);
  assert.throws(() => other.guests.submit(link.token, { ...details, start: '14:30' }, bytes), /可用时段/);
  first.guests.submit(link.token, details, Buffer.alloc(0));
  const reopened = other.guests.view(link.token);
  assert.deepEqual([reopened.start, reopened.end], ['14:00', '15:00']);
  assert.deepEqual(reopened.availability, { start: '13:00', end: '17:00' });
  other.guests.submit(link.token, { ...details, ...reopened.availability }, bytes);
  other.guests.submit(link.token, details, Buffer.alloc(0));
  state = first.get(owner, event.id);
  assert.equal(state.operations.replies.length, 1);
  assert.deepEqual(state.operations.replies[0].availability, reopened.availability);
  const session = state.event.agenda[0];
  const rehearsal = { ...state.operations.replies[0], id: 'rehearsal', guestConfirmed: false, availability: { start: '08:00', end: '20:00' } };
  for (const replies of [[...state.operations.replies, rehearsal], [rehearsal, ...state.operations.replies]]) {
    const issues = checkCandidate({ ...state.event, replies }, { before: session }, { ...session, start: '17:00', end: '18:00' });
    assert.ok(issues.some(message => message.includes('嘉宾可用时段为 13:00–17:00')));
  }
  assert.equal(other.readDraft(owner, event.id).data.tasks[0].done, true);
  assert.equal(state.guestRequests[0].taskId, input.taskId);
  const request = state.guestRequests[0];
  assert.deepEqual(Buffer.from(first.guests.download(owner, event.id, request.id).attachment), bytes);
  assert.throws(() => other.guests.download('unrelated', event.id, request.id), /找不到/);
  const reissued = first.guests.issue(owner, event.id, input);
  assert.throws(() => other.guests.view(link.token), /撤销/);
  first.guests.revoke(owner, event.id, request.id);
  assert.throws(() => other.guests.view(reissued.token), /撤销/);
});

test('连续操作的候选序号只属于原活动与当前发布版本', () => {
  const earlier = topic();
  earlier.teamLessons = [{ id: 'l1', condition: '跨楼转场', advice: '预留15分钟', version: 2 }];
  const next = createTopicEvent({ topic: '新论坛', people: [] }, referencePlan(earlier));
  assert.equal(next.organizedPlan.reference.lessons[0].version, 2);
  assert.equal(next.organizedPlan.reference.lessons[0].advice, '预留15分钟');
  const event = { id: 'forum', version: 3, rooms: [{ id: 'B' }], agenda: [{ id: 'session' }] };
  const turn = { eventId: 'forum', question: '换厅', version: 3, sessionId: 'session', selected: 2,
    candidates: [{ room: 'B', start: '13:30', end: '14:00' }, { room: 'B', start: '14:00', end: '14:30' }] };
  assert.equal(conversationContext([turn], event)[0].candidates[1].number, 2);
  assert.equal(conversationContext([turn], event)[0].selected, 2);
  assert.equal(conversationContext([turn], { ...event, version: 4 })[0].candidates, undefined);
  assert.deepEqual(conversationContext([turn], { ...event, id: 'other' }), []);
});

test('确认字段只沿当前可引用证据返回，人工修订或撤回旧来源后重审', () => {
  const proof = { chunkId: 12, name: '场地表', revision: 2, location: 'B3' };
  const fact = { key: 'venue.capacity', section: 'venues', entity: '报告厅', field: 'capacity', options: [{ value: '80', evidence: [proof] }] };
  const event = { id: 'fixture', choices: { [fact.key]: { status: '已确认', value: '75', evidence: conflictEvidenceKey(fact) } } };
  const memory = { organizationScope: () => ({ revision: 'r' }), readOrganization: () => ({ facts: [fact] }) };
  const citations = new Map();
  const [confirmed] = confirmedForHits(memory, event, [proof], citations);
  assert.equal(confirmed.source, '负责人手工确认');
  assert.equal(confirmed.value, '75');
  assert.equal(citations.get(12).revision, 2);
  assert.deepEqual(confirmedForHits(memory, event, [], citations), []);
  proof.textRevision = 1;
  assert.deepEqual(confirmedForHits(memory, event, [proof], citations), []);
});

test('追问使用上轮候选的起点，模型工具基于本轮人数重新校验', async t => {
  let received;
  const mock = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const { messages } = JSON.parse(Buffer.concat(chunks));
    const message = messages.at(-1);
    let answer;
    if (message.role === 'user') {
      received = JSON.parse(message.content);
      const slot = received.previous[0].candidates[1];
      answer = { tool_calls: [{ type: 'function', id: 'followup', function: {
        name: 'draft_move', arguments: JSON.stringify({ sessionId: received.previous[0].sessionId, room: slot.room, start: '14:10' }) } }] };
    } else answer = { content: '已按最新报名校验。' };
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ choices: [{ message: answer }] }));
  });
  await new Promise(resolve => mock.listen(0, '127.0.0.1', resolve));
  const api = createServer(createAgentHandler(() => ({ protocol: 'openai', model: 'fixture', url: 'http://127.0.0.1:' + mock.address().port })));
  await new Promise(resolve => api.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => api.close(resolve)); await new Promise(resolve => mock.close(resolve)); });
  const rooms = ['A','B'].map(id => ({ id, capacity: id === 'A' ? 80 : 30, ready: '08:00', equipment: [] }));
  const event = { id: 'evt', title: '测试', version: 1, rooms,
    agenda: [{ id: 's1', title: '工作坊', room: 'A', start: '13:00', end: '13:30', confirmed: 40 }] };
  const history = [{ eventId: 'evt', version: 1, question: '换厅', sessionId: 's1',
    candidates: [{ room: 'A', start: '13:30', end: '14:00' }, { room: 'B', start: '14:00', end: '14:30' }] }];
  const response = await fetch('http://127.0.0.1:' + api.address().port, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ event, history, question: '第二个再延后十分钟' }) });
  const result = await response.json();
  assert.equal(response.status, 200);
  assert.equal(received.previous[0].candidates[1].start, '14:00');
  assert.equal(result.proposal.analysis.requested.candidate.start, '14:10');
  assert.match(result.proposal.issues.join(' '), /超出 10 人/);
});
