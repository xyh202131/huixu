import assert from 'node:assert/strict';
import { mkdtemp, unlink, rmdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { exampleEvent, participantCount } from '../src/model.js';
import { signupSnapshot } from '../src/registrationRules.js';
import { guestUploadLimiter, registrationOwnerApi, registrationPublicApi } from './registrationApi.js';
import { createRegistrationMail } from './registrationMail.js';
import { createRegistrationStore } from './registrationStore.js';

const owner = 'fixture-owner';
const eventId = 'fixture-forum';

test('嘉宾上传中断后下一份课件仍可提交', async () => {
  const handle = registrationPublicApi({ guests: { view: () => ({}), submit: () => ({ saved: true }) } }, '');
  const request = { url: '/guest', method: 'POST', socket: { remoteAddress: '127.0.0.1' },
    headers: { host: 'localhost', 'x-huixu-confirmation': 'fixture', 'x-huixu-submission': '%7B%7D' } };
  const response = { setHeader() {}, writeHead(status) { this.status = status; }, end() {} };
  for (let index = 0; index < 4; index++) {
    const cancelled = { ...request, async *iterator() { throw new Error('测试上传已取消'); } };
    await handle(cancelled, response);
    assert.equal(response.status, 500);
  }
  await handle({ ...request, async *iterator() { yield Buffer.from('sample'); } }, response);
  assert.equal(response.status, 200);
});

test('嘉宾提交配额按链接、来源及同时在途的份数独立计算，到期恢复', () => {
  let time = 0;
  const reserve = guestUploadLimiter(() => time);
  const active = Array.from({ length: 4 }, (_, i) => reserve('link-' + i, 'shared'));
  assert.throws(() => reserve('other', 'elsewhere'), { status: 429 });
  active.forEach(release => release());
  for (let i = 0; i < 11; i++) reserve('link-0', 'shared')();
  assert.throws(() => reserve('link-0', 'elsewhere'), { status: 429 });
  for (let i = 15; i < 60; i++) reserve('another-' + i, 'shared')();
  assert.throws(() => reserve('new', 'shared'), { status: 429 });
  reserve('new', 'elsewhere')();
  time += 60000;
  reserve('link-0', 'shared')();
});

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'huixu-registration-test-'));
  const file = join(directory, 'registration.sqlite');
  let now = Date.now();
  const stores = [];
  function open() {
    const store = createRegistrationStore(process.cwd(), file, () => now);
    stores.push(store);
    return store;
  }
  const store = open();
  const event = exampleEvent({ title: '测试论坛', type: '行业论坛', date: '2026-12-03', capacity: 3 }, eventId);
  event.rooms[0].capacity = 1;
  event.version = 1;
  store.open(owner, signupSnapshot(event));
  t.after(async () => {
    for (const store of stores) store.close();
    for (const name of [file, file + '-shm', file + '-wal']) {
      await unlink(name).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
    await rmdir(directory);
  });
  return { store, event, open, advance: time => { now += time; } };
}

function add(store, name, options = {}) {
  const result = store.savePerson(owner, eventId, undefined, { name, ...options });
  return result.people.at(-1);
}

async function listen(t, handler) {
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return 'http://127.0.0.1:' + server.address().port;
}

test('报名保存后跨连接可读，竞争同一分场时只保留一个名额', async t => {
  const { store, open, event } = await fixture(t);
  const first = add(store, '演练甲', { email: 'first@example.test', sessionId: 'session-1' });
  const second = add(store, '演练乙', { sessionId: 'session-1' });
  const other = open();
  store.savePerson(owner, eventId, first.id, { ...first, status: '已确认', note: '内部备注' });
  assert.throws(() => other.savePerson(owner, eventId, second.id, { ...second, status: '已确认' }), /分场名额已满/);
  const saved = other.get(owner, eventId).people[0];
  assert.equal(saved.id, first.id);
  assert.equal(saved.note, '内部备注');
  assert.throws(() => other.savePerson(owner, eventId, first.id, { ...first, name: '过期修改' }), /报名已更新/);
  assert.throws(() => other.get('different-owner', eventId), /找不到该活动/);
  assert.equal(participantCount({ ...event, attendees: other.get(owner, eventId).people }), 1);
  assert.equal(store.checkIn(owner, eventId, { code: first.id, sessionId: 'session-1' }).duplicate, false);
  assert.equal(other.checkIn(owner, eventId, { code: first.id, sessionId: 'session-1' }).duplicate, true);
  assert.equal(other.get(owner, eventId).checkins[0].personId, first.id);
});

test('历史签到跨连接可见，保留原签到点并可在补齐报名后重试', async t => {
  const { store, open } = await fixture(t);
  const person = add(store, '历史签到演练', { status: '已取消', sessionId: 'session-2' });
  const records = [
    { personId: person.id.toLowerCase(), sessionId: '' },
    { personId: person.id, sessionId: 'session-1' },
    { personId: 'P-LEGACY', sessionId: 'old-session' },
  ];
  const api = registrationOwnerApi(store, createRegistrationMail(store, {}));
  const origin = await listen(t, (request, response) => api(request, response, { id: owner }));
  const migrate = () => fetch(origin + '/events/' + eventId + '/checkins/migrate', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ records }),
  }).then(async response => { assert.equal(response.status, 200); return response.json(); });
  const first = await migrate();
  const other = open();
  assert.deepEqual(other.get(owner, eventId).checkins.map(record => ({ ...record })), [
    { personId: person.id, sessionId: '' }, { personId: person.id, sessionId: 'session-1' },
  ]);
  assert.equal((await migrate()).revision, first.revision);
  assert.equal(other.checkIn(owner, eventId, { code: person.id, sessionId: 'session-1' }).duplicate, true);

  const rows = [{ name: '补录演练报名', id: 'P-LEGACY' }];
  const preview = other.importPeople(owner, eventId, rows);
  other.importPeople(owner, eventId, rows, preview.previewKey);
  const afterImport = await migrate();
  assert.deepEqual(afterImport.checkins.at(-1), records.at(-1));
  assert.equal(other.get(owner, eventId).checkins.length, 3);
});

test('匿名确认只操作绑定的报名，重复提交、撤销、过期及名额释放', async t => {
  const { store, advance } = await fixture(t);
  const a = add(store, '演练甲', { status: '已确认', email: 'first@example.test', note: '内部', sessionId: 'session-1' });
  const b = add(store, '演练乙', { sessionId: 'session-1' });
  const link = store.issueLink(owner, eventId, a.id);
  const api = registrationPublicApi(store, '');
  const origin = await listen(t, api);
  const path = origin + '/attendance';
  const headers = { 'X-Huixu-Confirmation': link.token, 'Content-Type': 'application/json' };
  const response = await fetch(path, { headers });
  assert.equal(response.status, 200);
  const page = await response.json();
  assert.equal(page.person.id, a.id);
  assert.equal(page.person.email, undefined);
  assert.equal(page.person.note, undefined);
  assert.equal(store.get(owner, eventId).people[0].attendance, '待回应');
  const respond = (action, extra) => fetch(path, { method: 'POST', headers, body: JSON.stringify({ action, ...extra }) });
  assert.equal((await respond('change-session', { sessionId: 'session-2' })).status, 200);
  assert.equal(store.get(owner, eventId).people[0].sessionId, 'session-1');
  assert.equal(store.get(owner, eventId).people[0].requestedSessionId, 'session-2');
  const confirmed = await (await respond('confirm')).json();
  assert.equal(confirmed.person.attendance, '确认出席');
  const beforeDuplicate = store.get(owner, eventId).revision;
  assert.equal((await respond('confirm')).status, 200);
  assert.equal(store.get(owner, eventId).revision, beforeDuplicate);
  assert.equal((await respond('decline')).status, 200);
  store.savePerson(owner, eventId, b.id, { ...b, status: '已确认' });
  assert.equal((await respond('confirm')).status, 409);
  assert.equal(store.get(owner, eventId).people[0].status, '已确认');
  assert.equal(store.get(owner, eventId).people[0].attendance, '无法参加');
  store.revoke(owner, eventId, a.id);
  assert.equal((await fetch(path, { headers })).status, 404);
  const expiring = store.issueLink(owner, eventId, a.id);
  advance(8 * 24 * 60 * 60 * 1000);
  assert.throws(() => store.confirmation(expiring.token), /已失效/);
});

test('公开报名、表格预览、按原编号更新及过期预览', async t => {
  const { store } = await fixture(t);
  const starting = store.get(owner, eventId);
  assert.throws(() => store.publicEvent(starting.publicId), /不可用/);
  store.changeEvent(owner, eventId, { revision: starting.revision, shared: true, formOpen: true });
  const info = store.publicEvent(starting.publicId);
  assert.equal(info.id, starting.publicId);
  assert.equal(info.people, undefined);
  assert.equal(info.rooms, undefined);
  const signup = { name: '参与者甲', email: 'PUBLIC@example.test' };
  assert.deepEqual(store.publicSignup(starting.publicId, signup), { received: true });
  assert.deepEqual(store.publicSignup(starting.publicId, signup), { received: true });
  const state = store.get(owner, eventId);
  assert.equal(state.people.length, 1);
  const [person] = state.people;
  const rows = [
    { id: person.id, name: '修改的姓名', session: 'session-1' }, { name: '新增报名', email: 'new@example.test' },
    { name: '重复甲', email: 'repeat@example.test' }, { name: '重复乙', email: 'repeat@example.test' },
  ];
  const preview = store.importPeople(owner, eventId, rows);
  assert.deepEqual(preview.previews.map(row => row.kind), ['更新', '新增', '重复', '重复']);
  assert.equal(store.get(owner, eventId).people.length, 1);
  assert.throws(() => store.importPeople(owner, eventId, [{ ...rows[0], name: '改预览内容' }], preview.previewKey), /重新预览/);
  const saved = store.importPeople(owner, eventId, rows, preview.previewKey);
  assert.equal(saved.state.people[0].id, person.id);
  assert.equal(saved.state.people[0].email, 'public@example.test');
  assert.equal(saved.state.people[0].sessionId, 'session-1');
  assert.equal(saved.state.people[1].name, '新增报名');
  assert.throws(() => store.importPeople(owner, eventId, rows, preview.previewKey), /重新预览/);
});

test('并发审核仅一人占位，发布复查报名并更新公开议程', async t => {
  const { store, event } = await fixture(t);
  const setup = store.get(owner, eventId);
  store.changeEvent(owner, eventId, { revision: setup.revision, shared: true, formOpen: true });
  const people = [add(store, '并发甲', { sessionId: 'session-1' }), add(store, '并发乙', { sessionId: 'session-1' })];
  const before = store.get(owner, eventId);
  const api = registrationOwnerApi(store, createRegistrationMail(store, {}));
  const origin = await listen(t, (request, response) => api(request, response, { id: owner }));
  const approvals = await Promise.all(people.map(person => fetch(origin + '/events/' + eventId + '/people/' + person.id, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...person, status: '已确认' }),
  })));
  assert.deepEqual(approvals.map(result => result.status).sort(), [200, 409]);
  const updated = signupSnapshot(event);
  updated.version = 2;
  updated.agenda[0].room = 'B';
  assert.throws(() => store.changeEvent(owner, eventId, { revision: before.revision, event: updated }, true), /已更新/);
  const current = store.get(owner, eventId);
  store.changeEvent(owner, eventId, { revision: current.revision, event: updated }, true);
  assert.equal(store.publicEvent(setup.publicId).agenda[0].room, 'B');
  assert.equal(store.get(owner, eventId).people.find(person => person.status === '已确认').sessionId, 'session-1');
});

test('确认邮件先预览，仅重试明确失败，服务商回查和邮件链接回流', async t => {
  const { store } = await fixture(t);
  const attendee = add(store, '邮件演练甲', { email: 'to@example.test', status: '已确认' });
  const requests = [];
  const endpoint = await listen(t, async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.method === 'GET') return response.end(JSON.stringify({ last_event: 'delivered' }));
    let body = '';
    for await (const chunk of request) body += chunk;
    requests.push({ key: request.headers['idempotency-key'], body: JSON.parse(body) });
    if (requests.length === 1) response.writeHead(422).end('{}');
    else response.end(JSON.stringify({ id: 'mock-provider-id' }));
  });
  const mail = createRegistrationMail(store, {
    HUIXU_RESEND_API_KEY: 'fixture-key', HUIXU_MAIL_FROM: 'owner@example.test', HUIXU_PUBLIC_ORIGIN: 'https://events.example.test',
  }, endpoint);
  const api = registrationOwnerApi(store, mail);
  const organizer = await listen(t, (request, response) => api(request, response, { id: owner }));
  const prefix = organizer + '/events/' + eventId + '/mail';
  const post = path => fetch(prefix + path, { method: 'POST' }).then(response => response.json());
  const preview = await post('/' + attendee.id + '/preview');
  assert.equal(preview.recipient, 'to@example.test');
  assert.equal(requests.length, 0);
  assert.equal((await post('/' + preview.id + '/send')).records[0].status, 'failed');
  assert.equal((await post('/' + preview.id + '/send')).records[0].status, 'failed');
  assert.equal((await post('/' + preview.id + '/retry')).records[0].status, 'accepted');
  assert.equal((await post('/' + preview.id + '/retry')).records[0].status, 'accepted');
  assert.equal(requests.length, 2);
  assert.notEqual(requests[0].key, requests[1].key);
  assert.equal(requests[1].body.to[0], 'to@example.test');
  const token = requests[1].body.text.match(/https:\/\/events\.example\.test\/#\/attendance\/([^\s]+)/)[1];
  assert.equal(store.respond(token, { action: 'confirm' }).person.id, attendee.id);
  assert.equal((await post('/' + preview.id + '/refresh')).records[0].status, 'delivered');
  assert.equal(store.get(owner, eventId).people[0].attendance, '确认出席');
});
