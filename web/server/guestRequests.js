import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { RegistrationError, shortText } from './registrationStore.js';
import { isClock } from '../src/scheduling.js';

const hash = token => createHash('sha256').update(token).digest('hex');
const metadata = 'id, session_id AS sessionId, guest, task_id AS taskId, expires, responded, filename, confirmed_version AS confirmedVersion';

export function guestRequestStore({ db, transaction, findEvent, now, bump, operationsFor, saveOperations }) {
  db.exec(`CREATE TABLE IF NOT EXISTS guest_requests (
    id TEXT PRIMARY KEY, event_id TEXT NOT NULL REFERENCES signup_events(id), session_id TEXT NOT NULL, guest TEXT NOT NULL,
    task_id TEXT NOT NULL, token_hash TEXT UNIQUE, expires INTEGER NOT NULL, responded INTEGER, confirmed_version INTEGER,
    filename TEXT NOT NULL DEFAULT '', attachment BLOB, UNIQUE(event_id, session_id, guest)
  )`);
  function list(eventId) {
    return db.prepare('SELECT ' + metadata + ' FROM guest_requests WHERE event_id = ? ORDER BY rowid').all(eventId);
  }
  function issue(owner, eventId, input) {
    return transaction(() => {
      const event = JSON.parse(findEvent(eventId, owner).snapshot);
      const session = event.agenda.find(row => row.id === input.sessionId);
      if (!event.version || !session || !session.guest || ['待定', '待确认'].includes(session.guest)) {
        throw new RegistrationError(400, '请选择已发布且已指定嘉宾的环节。');
      }
      const taskId = shortText(input.taskId, 100);
      const token = randomBytes(32).toString('base64url');
      const expires = now() + 7 * 86400000;
      db.prepare(`INSERT INTO guest_requests (id,event_id,session_id,guest,task_id,token_hash,expires) VALUES (?,?,?,?,?,?,?)
        ON CONFLICT(event_id, session_id, guest) DO UPDATE SET token_hash=excluded.token_hash, expires=excluded.expires, task_id=excluded.task_id`)
        .run(randomUUID(), eventId, session.id, session.guest, taskId, hash(token), expires);
      bump(eventId);
      return { token, expires };
    });
  }
  function revoke(owner, eventId, id) {
    findEvent(eventId, owner);
    db.prepare('UPDATE guest_requests SET token_hash=NULL, expires=0 WHERE id=? AND event_id=?').run(id, eventId);
    bump(eventId);
    return { revoked: true };
  }
  function load(token) {
    if (typeof token !== 'string' || token.length !== 43) throw new RegistrationError(404, '嘉宾链接不可用。');
    const request = db.prepare('SELECT ' + metadata + ',event_id AS eventId FROM guest_requests WHERE token_hash=? AND expires>?')
      .get(hash(token), now());
    if (!request) throw new RegistrationError(404, '嘉宾链接已到期或被撤销。');
    const event = JSON.parse(db.prepare('SELECT snapshot FROM signup_events WHERE id=?').get(request.eventId).snapshot);
    const session = event.agenda.find(row => row.id === request.sessionId && row.guest === request.guest);
    if (!session) throw new RegistrationError(409, '嘉宾安排已变更，请联系负责人。');
    return { event, session, request };
  }
  function view(token) {
    const { event, session, request } = load(token);
    const reply = operationsFor(event.id).replies.find(item => item.id === request.id);
    return { eventTitle: event.title, version: event.version, date: event.date, sessionTitle: session.title, room: session.room,
      start: session.start, end: session.end, availability: reply?.availability ?? null,
      guest: request.guest, filename: request.filename, confirmedVersion: request.confirmedVersion };
  }
  function submit(token, input, bytes) {
    return transaction(() => {
      const { event, session, request } = load(token);
      if (input.version !== event.version) throw new RegistrationError(409, '议程已更新，请刷新后核对时段。');
      if (!isClock(input.start) || !isClock(input.end) || input.start > session.start || input.end < session.end) {
        throw new RegistrationError(400, '可用时段须涵盖本场安排。');
      }
      const ops = operationsFor(event.id);
      const previous = ops.replies.find(item => item.id === request.id);
      let sameFile = !bytes.length;
      if (bytes.length) {
        const name = shortText(input.filename, 180);
        const pdf = /\.pdf$/i.test(name) && bytes.subarray(0, 5).equals(Buffer.from('%PDF-'));
        const pptx = /\.pptx$/i.test(name) && bytes.subarray(0, 4).equals(Buffer.from([80,75,3,4])) && bytes.includes(Buffer.from('ppt/presentation.xml'));
        if (!pdf && !pptx) throw new RegistrationError(400, '请上传 PDF 或 PPTX 课件。');
        if (name === request.filename) {
          const stored = db.prepare('SELECT attachment FROM guest_requests WHERE id=?').get(request.id);
          sameFile = !!stored.attachment && bytes.equals(stored.attachment);
        }
        if (!sameFile) db.prepare('UPDATE guest_requests SET filename=?, attachment=? WHERE id=?').run(name, bytes, request.id);
      }
      if (sameFile && request.confirmedVersion === event.version &&
          previous?.availability?.start === input.start && previous.availability.end === input.end) return view(token);
      db.prepare('UPDATE guest_requests SET responded=?, confirmed_version=? WHERE id=?').run(now(), event.version, request.id);
      const reply = { id: request.id, role: 'guest', guestConfirmed: true, name: request.guest, sessionId: session.id, summary: '已确认出席时段',
        availability: { start: input.start, end: input.end }, details: bytes.length ? shortText(input.filename, 180) : request.filename };
      ops.replies = [...ops.replies.filter(row => row.id !== request.id), reply];
      saveOperations(event.id, ops);
      if (request.taskId && reply.details) {
        const saved = db.prepare('SELECT data FROM workspace_drafts WHERE event_id=?').get(event.id);
        if (saved) {
          const draft = JSON.parse(saved.data);
          const task = draft.tasks.find(item => String(item.id) === request.taskId);
          if (task && !task.done) {
            task.done = true;
            db.prepare('UPDATE workspace_drafts SET data=?, revision=revision+1 WHERE event_id=?').run(JSON.stringify(draft), event.id);
          }
        }
      }
      bump(event.id);
      return view(token);
    });
  }
  function download(owner, eventId, id) {
    findEvent(eventId, owner);
    const file = db.prepare('SELECT filename,attachment FROM guest_requests WHERE event_id=? AND id=?').get(eventId,id);
    if (!file?.attachment) throw new RegistrationError(404, '还未收到课件。');
    return file;
  }
  return { list, issue, revoke, view, submit, download };
}
