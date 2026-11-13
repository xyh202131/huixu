import assert from 'node:assert/strict';
import { test } from 'node:test';
import { changeReviewKey, describeChangeImpact } from '../src/changeImpact.js';
import { initialEvents, makeMoveChange, materialText, publishChange } from '../src/model.js';
import { analyzeMove, checkCandidate, moveCandidate } from '../src/scheduling.js';

test('工作坊换厅保留报名和签到，发布采用已确认的影响与通知', () => {
  const [event] = initialEvents();
  const session = event.agenda.at(-1);
  event.replies.push({ role: 'volunteer', name: '演练志愿者', sessionId: session.id, availability: { start: '13:30', end: '15:00' } });
  event.checkins.push({ personId: 'G001', sessionId: session.id });
  const change = makeMoveChange(event, session, { room: 'B', start: '14:00' }, '演练换厅');
  event.change = change;
  const [requested, alternative] = change.candidates;
  assert.match(checkCandidate(event, change, requested).join('、'), /超出 12 人.*缺少无线麦克风/);
  assert.deepEqual(alternative, { room: 'C', start: '14:20', end: '15:00' });
  const impact = describeChangeImpact(event, change, alternative);
  assert.equal(impact.registrations.length, 80);
  assert.equal(impact.notice.recipients.length, 72);
  assert.equal(impact.checkedIn, 1);
  assert.deepEqual(impact.checkin, { before: 'A 厅门口签到', after: 'C 厅门口签到' });
  assert.deepEqual(impact.posts.find(post => post.role === '分场引导').assignees, ['演练志愿者']);

  const reviewed = changeReviewKey(event, change, alternative, impact);
  assert.equal(publishChange(event, alternative, true), event);
  assert.equal(publishChange(event, requested, true, changeReviewKey(event, change, requested)), event);
  const updated = { ...event, attendees: event.attendees.map(person => person.id === 'G001' ? { ...person, status: '候补' } : person) };
  assert.equal(publishChange(updated, alternative, true, reviewed), updated);
  const result = publishChange(event, alternative, true, reviewed);
  assert.equal(result.version, 2);
  assert.equal(result.attendees, event.attendees);
  assert.equal(result.checkins, event.checkins);
  assert.equal(result.change, null);
  assert.deepEqual(result.history[0].impact, impact);
  assert.deepEqual(result.messages[0].recipientIds, impact.notice.recipients.map(person => person.id));
  assert.equal(result.messages[0].body, impact.notice.body);
  assert.deepEqual(result.messages.slice(1).map(message => message.recipientNames), [[session.guest], ['演练志愿者']]);
  assert.match(result.messages[2].body, /C 厅门口签到处引导观众/);
  assert.match(materialText(result, '工作人员台本'), /14:20–15:00 · C 厅.*\nC 厅门口签到/);
  assert.match(materialText(result, '岗位清单'), /14:20–15:00 · C 厅.*\n签到 · 待分配\n分场引导 · 演练志愿者/);
  assert.equal(publishChange(result, alternative, true, reviewed), result);
});

test('会场就绪与嘉宾可用时间无法同时满足时说明阻碍', () => {
  const [event] = initialEvents();
  const session = event.agenda.at(-1);
  event.replies.push({ role: 'guest', name: session.guest, sessionId: session.id, availability: { start: '14:00', end: '14:55' } });
  const analysis = analyzeMove(event, session, { room: 'B', start: session.start, closedRoom: 'A' });
  assert.deepEqual(analysis.alternatives, []);
  const c = analysis.blocked.find(option => option.candidate.room === 'C');
  assert.equal(c.candidate.start, '14:20');
  assert.ok(c.issues.includes('嘉宾可用时段为 14:00–14:55'));
});

test('改时检查人员占用、转场、未结束的现场环节和原时长', () => {
  const [event] = initialEvents();
  const earlier = event.agenda[2];
  const session = event.agenda.at(-1);
  earlier.guest = session.guest;
  event.rooms.find(room => room.id === 'C').ready = '08:00';
  event.replies.push(
    { role: 'volunteer', name: '同一志愿者', sessionId: earlier.id },
    { role: 'volunteer', name: '同一志愿者', sessionId: session.id },
  );
  const change = { before: session, sessionId: session.id };
  const early = checkCandidate(event, change, moveCandidate(session, 'C', '13:40'));
  assert.ok(early.some(issue => issue.includes('嘉宾与')));
  assert.ok(early.some(issue => issue.includes('分场引导与')));
  const transfer = checkCandidate(event, change, moveCandidate(session, 'C', '13:50'));
  assert.ok(transfer.some(issue => issue.includes('嘉宾跨厅转场不足')));
  assert.ok(transfer.some(issue => issue.includes('分场引导跨厅转场不足')));
  assert.ok(checkCandidate(event, change, moveCandidate(session, 'C', '23:45')).some(issue => issue.includes('无法保留原环节时长')));
  event.actual[earlier.id] = { started: '13:10' };
  assert.ok(checkCandidate(event, change, moveCandidate(session, 'C', '15:00')).some(issue => issue.includes('结束时间待确认')));
});
