import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { initialEvents, activityTypes } from '../src/model.js';
import { describeRescueImpact } from '../src/changeImpact.js';
import { reviewStatuses, reservesSeat } from '../src/registrationRules.js';
import { analyzeRescue, rescueTitle, validateRescuePlan } from '../src/rescueScheduling.js';
import { isClock } from '../src/scheduling.js';
import { localDatabasePath } from './localData.js';

export class RegistrationError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const shortText = (value, max = 160) => typeof value === 'string' ? value.trim().slice(0, max) : '';
export const validId = value => typeof value === 'string' && /^[\w-]{1,100}$/.test(value);
export const validEmail = value => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) && value.length <= 254;
const capacityValue = value => Number.isSafeInteger(value) && value >= 0 && value <= 100000;
const linkLifetime = 7 * 24 * 60 * 60 * 1000;

function snapshot(input) {
  if (!validId(input?.id) || !shortText(input.title) || !activityTypes.includes(input.type) ||
      !capacityValue(input.capacity) || !Number.isSafeInteger(input.version) || input.version < 0 ||
      !Array.isArray(input.agenda) || input.agenda.length > 500 || !Array.isArray(input.rooms) || input.rooms.length > 100) {
    throw new RegistrationError(400, '活动或名额信息无效。');
  }
  const rooms = input.rooms.map(room => {
    if (!validId(room?.id) || !capacityValue(room.capacity)) throw new RegistrationError(400, '会场容量无效。');
    return { id: room.id, capacity: room.capacity, ready: isClock(room.ready) ? room.ready : '00:00',
      equipment: Array.isArray(room.equipment) ? room.equipment.slice(0, 30).map(value => shortText(value, 80)).filter(Boolean) : [] };
  });
  const agenda = input.agenda.map(session => {
    if (!validId(session?.id) || !shortText(session.title) || !isClock(session.start) || !isClock(session.end) ||
        !rooms.some(room => room.id === session.room)) throw new RegistrationError(400, '议程场次或会场无效。');
    return { id: session.id, title: shortText(session.title), start: session.start, end: session.end, room: session.room,
      guest: shortText(session.guest, 80) || '待确认', equipment: equipmentList(session.equipment) };
  });
  if (new Set(agenda.map(item => item.id)).size !== agenda.length || new Set(rooms.map(item => item.id)).size !== rooms.length) {
    throw new RegistrationError(400, '场次或会场编号重复。');
  }
  return {
    id: input.id, title: shortText(input.title), type: input.type, date: /^\d{4}-\d{2}-\d{2}$/.test(input.date) ? input.date : '',
    venue: shortText(input.venue), version: input.version, capacity: input.capacity, formOpen: input.formOpen === true, rooms, agenda,
  };
}

function equipmentList(value) {
  return Array.isArray(value) ? value.slice(0, 30).map(item => shortText(item, 80)).filter(Boolean) : [];
}

function publicAgenda(agenda) {
  return agenda.map(({ id, title, start, end, room }) => ({ id, title, start, end, room }));
}

export function registrationFields(input, event) {
  const name = shortText(input?.name, 80);
  const email = shortText(input?.email, 255).toLowerCase();
  const sessionId = input?.sessionId ?? '';
  const status = input?.status ?? '待审核';
  if (!name || (email && !validEmail(email)) || !reviewStatuses.includes(status)) {
    throw new RegistrationError(400, '请填写姓名并核对邮箱和审核状态。');
  }
  if (sessionId !== '' && !event.agenda.some(item => item.id === sessionId)) throw new RegistrationError(400, '所选分场已不可用。');
  return { name, email, sessionId, status, note: shortText(input.note, 1000) };
}

function checkCapacity(event, people, person) {
  if (!reservesSeat(person)) return;
  const others = people.filter(item => item.id !== person.id && reservesSeat(item));
  if (others.length >= event.capacity) throw new RegistrationError(409, '活动已满或总名额待确定。可保留为候补。');
  const session = event.agenda.find(item => item.id === person.sessionId);
  const room = event.rooms.find(item => item.id === session?.room);
  if (room && others.filter(item => item.sessionId === session.id).length >= room.capacity) {
    throw new RegistrationError(409, '该分场名额已满。请选择其他场次或保留候补。');
  }
}

function checkEventCapacity(event, people) {
  const counts = new Map();
  let total = 0;
  for (const person of people) {
    if (!reservesSeat(person)) continue;
    total += 1;
    if (person.sessionId) counts.set(person.sessionId, (counts.get(person.sessionId) ?? 0) + 1);
  }
  if (total > event.capacity) throw new RegistrationError(409, '活动总名额不足以保留现有报名。');
  for (const session of event.agenda) {
    const room = event.rooms.find(item => item.id === session.room);
    if ((counts.get(session.id) ?? 0) > room.capacity) throw new RegistrationError(409, session.title + '的会场名额不足。');
  }
}

export function createRegistrationStore(root, override, now = Date.now) {
  const path = localDatabasePath(root, override, 'registration.sqlite');
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA busy_timeout = 5000;
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS signup_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS signup_events (
      id TEXT PRIMARY KEY, owner TEXT NOT NULL, snapshot TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
      shared INTEGER NOT NULL DEFAULT 0, public_id TEXT NOT NULL UNIQUE
    );
    CREATE INDEX IF NOT EXISTS signup_events_owner ON signup_events (owner);
    CREATE TABLE IF NOT EXISTS signups (
      event_id TEXT NOT NULL REFERENCES signup_events(id), id TEXT NOT NULL, name TEXT NOT NULL, email TEXT NOT NULL DEFAULT '',
      session_id TEXT NOT NULL, status TEXT NOT NULL, note TEXT NOT NULL DEFAULT '', attendance TEXT NOT NULL DEFAULT '待回应',
      requested_session TEXT NOT NULL DEFAULT '', responded_at TEXT, revision INTEGER NOT NULL DEFAULT 1, PRIMARY KEY(event_id, id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS signups_email ON signups (event_id, email) WHERE email <> '';
    CREATE TABLE IF NOT EXISTS signup_checkins (
      event_id TEXT NOT NULL, person_id TEXT NOT NULL, session_id TEXT NOT NULL,
      PRIMARY KEY(event_id, person_id, session_id),
      FOREIGN KEY(event_id, person_id) REFERENCES signups(event_id, id)
    );
    CREATE TABLE IF NOT EXISTS signup_links (
      id TEXT PRIMARY KEY, event_id TEXT NOT NULL, person_id TEXT NOT NULL, expires INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY(event_id, person_id) REFERENCES signups(event_id, id)
    );
    CREATE INDEX IF NOT EXISTS signup_links_person ON signup_links (event_id, person_id);
    CREATE TABLE IF NOT EXISTS signup_mail (
      id TEXT PRIMARY KEY, event_id TEXT NOT NULL, person_id TEXT NOT NULL, person_revision INTEGER NOT NULL,
      event_revision TEXT NOT NULL, link_id TEXT NOT NULL REFERENCES signup_links(id), recipient TEXT NOT NULL,
      subject TEXT NOT NULL, body TEXT NOT NULL, origin TEXT NOT NULL, sender TEXT NOT NULL, status TEXT NOT NULL,
      provider_id TEXT, error TEXT, attempts INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, started_at INTEGER,
      FOREIGN KEY(event_id, person_id) REFERENCES signups(event_id, id)
    );
    CREATE INDEX IF NOT EXISTS signup_mail_event ON signup_mail (event_id, created_at);
    CREATE TABLE IF NOT EXISTS signup_operations (
      event_id TEXT PRIMARY KEY REFERENCES signup_events(id), data TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS signup_rescue_releases (
      event_id TEXT NOT NULL REFERENCES signup_events(id), id TEXT NOT NULL, version INTEGER NOT NULL,
      proof TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(event_id, id), UNIQUE(event_id, version)
    );
  `);
  db.prepare('INSERT OR IGNORE INTO signup_settings VALUES (?, ?)').run('link-secret', randomBytes(32).toString('base64url'));
  const linkSecret = db.prepare("SELECT value FROM signup_settings WHERE key = 'link-secret'").get().value;
  const personSelect = `SELECT id, name, email, session_id AS sessionId, status, note, attendance,
    requested_session AS requestedSessionId, responded_at AS respondedAt, revision FROM signups WHERE event_id = ?`;
  const mailSelect = `SELECT id, recipient, subject, status, provider_id AS providerId, error, attempts,
    created_at AS createdAt, started_at AS startedAt FROM signup_mail WHERE event_id = ?`;

  function transaction(work) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  transaction(() => {
    const fields = db.prepare('PRAGMA table_info(signup_mail)').all();
    if (!fields.some(field => field.name === 'started_at')) {
      db.exec('ALTER TABLE signup_mail ADD COLUMN started_at INTEGER');
    }
  });

  function findEvent(id, owner) {
    const row = db.prepare('SELECT * FROM signup_events WHERE id = ? AND owner = ?').get(id, owner);
    if (!row) throw new RegistrationError(404, '找不到该活动。');
    return row;
  }

  function personFor(eventId, personId) {
    const person = db.prepare(personSelect + ' AND id = ?').get(eventId, personId);
    if (!person) throw new RegistrationError(404, '找不到该报名记录。');
    return person;
  }

  function peopleFor(eventId) {
    return db.prepare(personSelect + ' ORDER BY rowid').all(eventId);
  }

  function state(row) {
    return {
      event: JSON.parse(row.snapshot), revision: row.revision, shared: Boolean(row.shared), publicId: row.public_id,
      people: peopleFor(row.id),
      checkins: db.prepare('SELECT person_id AS personId, session_id AS sessionId FROM signup_checkins WHERE event_id = ? ORDER BY rowid').all(row.id),
      operations: operationsFor(row.id),
      rescueReleases: db.prepare('SELECT data FROM signup_rescue_releases WHERE event_id = ? ORDER BY version DESC').all(row.id)
        .map(release => JSON.parse(release.data)),
    };
  }

  function operationsFor(id) {
    const saved = db.prepare('SELECT data FROM signup_operations WHERE event_id = ?').get(id);
    return saved ? JSON.parse(saved.data) : { actual: {}, replies: [] };
  }

  function saveOperations(id, operations) {
    db.prepare('INSERT INTO signup_operations VALUES (?, ?) ON CONFLICT(event_id) DO UPDATE SET data = excluded.data')
      .run(id, JSON.stringify(operations));
  }

  function bump(eventId) {
    db.prepare('UPDATE signup_events SET revision = revision + 1 WHERE id = ?').run(eventId);
  }

  function insertPerson(eventId, id, person) {
    db.prepare('INSERT INTO signups (event_id, id, name, email, session_id, status, note) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(eventId, id, person.name, person.email, person.sessionId, person.status, person.note);
  }

  function revokeLinks(eventId, id) {
    db.prepare('UPDATE signup_links SET revoked = 1 WHERE event_id = ? AND person_id = ?').run(eventId, id);
  }

  function list(owner) {
    return db.prepare('SELECT snapshot FROM signup_events WHERE owner = ? ORDER BY rowid').all(owner).map(row => JSON.parse(row.snapshot));
  }

  function open(owner, input) {
    const event = snapshot(input);
    return transaction(() => {
      const existing = db.prepare('SELECT * FROM signup_events WHERE id = ?').get(event.id);
      if (existing) return state(findEvent(event.id, owner));
      db.prepare('INSERT INTO signup_events (id, owner, snapshot, public_id) VALUES (?, ?, ?, ?)')
        .run(event.id, owner, JSON.stringify(event), randomBytes(18).toString('base64url'));
      if (event.id === 'forum' && event.title === '2026 城市创新论坛') {
        // 示例名单从内置样本初始化，浏览器里已有的编辑可由负责人预览后迁移。
        for (const person of initialEvents()[0].attendees) insertPerson(event.id, person.id, registrationFields(person, event));
      }
      return state(findEvent(event.id, owner));
    });
  }

  function changeEvent(owner, eventId, input, schedule = false) {
    return transaction(() => {
      const row = findEvent(eventId, owner);
      if (row.revision !== input.revision) throw new RegistrationError(409, '报名或活动已更新，请核对后重试。');
      const previous = JSON.parse(row.snapshot);
      let event = previous;
      let shared = row.shared;
      if (schedule) {
        event = snapshot({ ...input.event, id: eventId, formOpen: previous.formOpen });
        if (event.version !== previous.version + 1) throw new RegistrationError(409, '议程已更新，请使用最新发布版本。');
        const people = peopleFor(eventId);
        const sessionIds = new Set(event.agenda.map(item => item.id));
        if (people.some(person => person.sessionId && !sessionIds.has(person.sessionId))) {
          throw new RegistrationError(409, '新议程缺少已有关联报名的场次。');
        }
        checkEventCapacity(event, people);
      } else {
        if (input.details && !previous.version) {
          event = snapshot({ ...previous, ...input.details, id: previous.id, type: previous.type,
            version: previous.version, rooms: previous.rooms, agenda: previous.agenda });
          checkEventCapacity(event, peopleFor(eventId));
        }
        event.formOpen = input.formOpen === true;
        shared = Number(input.shared === true);
      }
      db.prepare('UPDATE signup_events SET snapshot = ?, shared = ?, revision = revision + 1 WHERE id = ?')
        .run(JSON.stringify(event), shared, eventId);
      return state(findEvent(eventId, owner));
    });
  }

  function savePerson(owner, eventId, id, input) {
    return transaction(() => {
      const row = findEvent(eventId, owner);
      const event = JSON.parse(row.snapshot);
      const current = id ? personFor(eventId, id) : null;
      const fields = registrationFields(input, event);
      if (current && current.revision !== input.revision) throw new RegistrationError(409, '报名已更新，请核对最新记录后再保存。');
      const people = peopleFor(eventId);
      if (fields.email && people.some(person => person.id !== id && person.email === fields.email)) {
        throw new RegistrationError(409, '此邮箱已有本场报名，请编辑原记录。');
      }
      const person = { ...current, ...fields, id: id || 'P-' + randomBytes(8).toString('hex').toUpperCase() };
      checkCapacity(event, people, person);
      if (current) {
        const request = fields.sessionId !== current.sessionId || input.clearRequest ? '' : current.requestedSessionId;
        db.prepare(`UPDATE signups SET name = ?, email = ?, session_id = ?, status = ?, note = ?, requested_session = ?,
          revision = revision + 1 WHERE event_id = ? AND id = ?`)
          .run(fields.name, fields.email, fields.sessionId, fields.status, fields.note, request, eventId, id);
        if (current.email !== fields.email || fields.status !== '已确认') revokeLinks(eventId, id);
      } else insertPerson(eventId, person.id, fields);
      bump(eventId);
      return state(findEvent(eventId, owner));
    });
  }

  function publicEvent(publicId) {
    const row = db.prepare('SELECT * FROM signup_events WHERE public_id = ? AND shared = 1').get(publicId);
    if (!row) throw new RegistrationError(404, '活动链接不可用。');
    const event = JSON.parse(row.snapshot);
    const { id, rooms, capacity, ...publicFields } = event;
    return { ...publicFields, id: publicId, agenda: publicAgenda(event.agenda) };
  }

  function checkIn(owner, eventId, input) {
    return transaction(() => {
      const row = findEvent(eventId, owner);
      const code = shortText(input.code, 100).toUpperCase();
      const person = peopleFor(eventId).find(item => item.id.toUpperCase() === code);
      const sessionId = input.sessionId ?? '';
      const found = person && db.prepare('SELECT 1 FROM signup_checkins WHERE event_id = ? AND person_id = ? AND session_id = ?')
        .get(eventId, person.id, sessionId);
      if (found) return { duplicate: true, name: person.name, state: state(row) };
      if (!person || !reservesSeat(person)) throw new RegistrationError(409, '凭证无效、报名尚未确认或参与者已报告无法参加。');
      if (sessionId && person.sessionId !== sessionId) throw new RegistrationError(409, '该观众未报名此分场。');
      db.prepare('INSERT INTO signup_checkins VALUES (?, ?, ?)').run(eventId, person.id, sessionId);
      bump(eventId);
      return { duplicate: false, name: person.name, state: state(findEvent(eventId, owner)) };
    });
  }

  function publicSignup(publicId, input) {
    return transaction(() => {
      const publicDetails = publicEvent(publicId);
      if (!publicDetails.formOpen) throw new RegistrationError(409, '活动报名暂时关闭。');
      const { id: eventId } = db.prepare('SELECT id FROM signup_events WHERE public_id = ?').get(publicId);
      const person = registrationFields({ name: input.name, email: input.email, sessionId: input.sessionId }, publicDetails);
      if (!person.email) throw new RegistrationError(400, '请填写可接收活动通知的邮箱。');
      const existing = db.prepare('SELECT id FROM signups WHERE event_id = ? AND email = ?').get(eventId, person.email);
      if (!existing) {
        insertPerson(eventId, 'P-' + randomBytes(8).toString('hex').toUpperCase(), person);
        bump(eventId);
      }
      // 对重复邮箱给出相同反馈，公开请求不会暴露原记录或凭证。
      return { received: true };
    });
  }

  function signature(id) {
    return createHmac('sha256', linkSecret).update(id).digest('base64url');
  }

  function tokenFor(id) {
    return id + '.' + signature(id);
  }

  function issueLink(owner, eventId, personId) {
    const row = findEvent(eventId, owner);
    const person = personFor(eventId, personId);
    if (person.status !== '已确认') throw new RegistrationError(409, '请先通过这条报名记录的审核。');
    const id = randomUUID();
    const expires = now() + linkLifetime;
    db.prepare('INSERT INTO signup_links (id, event_id, person_id, expires) VALUES (?, ?, ?, ?)').run(id, row.id, person.id, expires);
    return { id, expires, token: tokenFor(id) };
  }

  function revoke(owner, eventId, personId) {
    findEvent(eventId, owner);
    personFor(eventId, personId);
    revokeLinks(eventId, personId);
    return { revoked: true };
  }

  function activeLink(token) {
    const [id, signed] = typeof token === 'string' ? token.split('.') : [];
    const expected = id && validId(id) ? signature(id) : '';
    const unavailable = new RegistrationError(404, '确认链接已失效或被撤销，请联系活动负责人。');
    if (!signed || signed.length !== expected.length || !/^[\w-]+$/.test(signed) ||
        !timingSafeEqual(Buffer.from(expected), Buffer.from(signed)) || token !== id + '.' + signed) throw unavailable;
    const row = db.prepare(`SELECT link.*, event.snapshot FROM signup_links AS link JOIN signup_events AS event ON event.id = link.event_id
      WHERE link.id = ? AND link.revoked = 0 AND link.expires > ?`).get(id, now());
    if (!row) throw unavailable;
    return { ...row, event: JSON.parse(row.snapshot), person: personFor(row.event_id, row.person_id) };
  }

  function confirmation(token) {
    const { event, person, expires } = activeLink(token);
    return {
      event: { title: event.title, date: event.date, venue: event.venue, agenda: publicAgenda(event.agenda) },
      person: { name: person.name, id: person.id, status: person.status, sessionId: person.sessionId, attendance: person.attendance,
        requestedSessionId: person.requestedSessionId, respondedAt: person.respondedAt },
      expires,
    };
  }

  function rescueEvent(state) {
    return { ...state.event, ...state.operations, attendees: state.people, checkins: state.checkins };
  }

  function mergeOperations(row, input) {
    if (!input || typeof input !== 'object') return row;
    const event = JSON.parse(row.snapshot);
    const operations = operationsFor(row.id);
    const before = JSON.stringify(operations);
    const known = new Set(event.agenda.map(session => session.id));
    const updates = Array.isArray(input.sessions) ? input.sessions : [];
    event.agenda = event.agenda.map(session => {
      const entry = updates.find(item => item?.id === session.id);
      if (!entry) return session;
      return { ...session, guest: shortText(entry.guest, 80) || session.guest || '待确认',
        equipment: Array.isArray(entry.equipment) ? equipmentList(entry.equipment) : session.equipment ?? [] };
    });
    for (const [id, actual] of Object.entries(input.actual ?? {})) {
      if (!known.has(id) || operations.actual[id] || !isClock(actual?.started)) continue;
      operations.actual[id] = { started: actual.started };
      if (isClock(actual.ended) && actual.ended >= actual.started) operations.actual[id].ended = actual.ended;
    }
    const replies = new Map(operations.replies.map(item => [item.id, item]));
    if (Array.isArray(input.replies)) for (const entry of input.replies.slice(0, 1000)) {
      if (!validId(entry?.id) || !known.has(entry.sessionId) || !['guest', 'volunteer'].includes(entry.role) || !shortText(entry.name)) continue;
      const { start, end } = entry.availability ?? {};
      const record = { id: entry.id, sessionId: entry.sessionId, role: entry.role, name: shortText(entry.name, 80) };
      if (isClock(start) && isClock(end) && start < end) record.availability = { start, end };
      replies.set(entry.id, record);
    }
    operations.replies = [...replies.values()];
    const encoded = JSON.stringify(event);
    if (before === JSON.stringify(operations) && row.snapshot === encoded) return row;
    saveOperations(row.id, operations);
    db.prepare('UPDATE signup_events SET snapshot = ?, revision = revision + 1 WHERE id = ?').run(encoded, row.id);
    return { ...row, snapshot: encoded, revision: row.revision + 1 };
  }

  function recordActual(owner, eventId, input) {
    return transaction(() => {
      let row = findEvent(eventId, owner);
      if (row.revision !== input.revision) throw new RegistrationError(409, '现场状态已更新，请核对后重试。');
      row = mergeOperations(row, input.operations);
      const { sessionId, action, time } = input;
      if (!JSON.parse(row.snapshot).agenda.some(session => session.id === sessionId) || !isClock(time) || !['start', 'end'].includes(action)) {
        throw new RegistrationError(400, '环节或现场时间无效。');
      }
      const operations = operationsFor(eventId);
      const current = operations.actual[sessionId];
      if (action === 'start') {
        if (current?.started) return state(row);
        if (Object.values(operations.actual).some(item => item.started && !item.ended)) {
          throw new RegistrationError(409, '请先结束正在进行的环节，再记录下一场开始。');
        }
        operations.actual[sessionId] = { started: time };
      } else {
        if (current?.ended) return state(row);
        if (!current?.started || time < current.started) throw new RegistrationError(409, '请先核对该环节的实际开始时间。');
        current.ended = time;
      }
      saveOperations(eventId, operations);
      bump(eventId);
      return state(findEvent(eventId, owner));
    });
  }

  function rescuePreview(owner, eventId, input) {
    const current = transaction(() => {
      const row = findEvent(eventId, owner);
      if (input.revision !== row.revision) throw new RegistrationError(409, '活动或报名已更新，请按最新数据重新计算。');
      return state(mergeOperations(row, input.operations));
    });
    const event = rescueEvent(current);
    if (!event.version) throw new RegistrationError(409, '请先发布活动议程，现场调整基于已发布版本。');
    const analysis = analyzeRescue(event, input.incident);
    if (analysis.error) throw new RegistrationError(400, analysis.error);
    const { incident } = analysis;
    analysis.plans = analysis.plans.map(plan => ({
      ...plan, proof: signature(JSON.stringify([eventId, current.revision, incident, plan.moves])),
      impact: describeRescueImpact(event, plan),
    }));
    return { state: current, analysis };
  }

  function publishRescue(owner, eventId, input) {
    return transaction(() => {
      const row = findEvent(eventId, owner);
      if (!validId(input.changeId) || typeof input.proof !== 'string' || !input.incident || !Array.isArray(input.moves)) {
        throw new RegistrationError(400, '请先选择并核对救场方案。');
      }
      const previous = db.prepare('SELECT proof FROM signup_rescue_releases WHERE event_id = ? AND id = ?').get(eventId, input.changeId);
      if (previous) {
        if (previous.proof !== input.proof) throw new RegistrationError(409, '这张变更单已发布，请查看发布记录。');
        return state(row);
      }
      if (input.revision !== row.revision) throw new RegistrationError(409, '报名、现场或议程已更新，请重新计算并核对影响。');
      const expected = signature(JSON.stringify([eventId, row.revision, input.incident, input.moves]));
      if (expected !== input.proof) throw new RegistrationError(409, '方案与确认预览不一致，请重新计算。');
      const event = rescueEvent(state(row));
      const plan = { moves: input.moves };
      const problems = validateRescuePlan(event, input.incident, plan);
      if (problems.length) throw new RegistrationError(409, problems.join('；'));
      const impact = describeRescueImpact(event, plan);
      const moves = new Map(input.moves.map(move => [move.sessionId, move]));
      const version = event.version + 1;
      const title = rescueTitle(input.incident);
      const release = { id: input.changeId, kind: 'rescue', version, title, incident: input.incident,
        count: impact.count, changes: impact.rows, notices: impact.notices, date: new Date(now()).toISOString() };
      const agenda = event.agenda.map(session => ({ ...session, ...moves.get(session.id) }));
      const next = snapshot({ ...event, version, agenda });
      checkEventCapacity(next, event.attendees);
      db.prepare('UPDATE signup_events SET snapshot = ?, revision = revision + 1 WHERE id = ?').run(JSON.stringify(next), eventId);
      db.prepare('INSERT INTO signup_rescue_releases VALUES (?, ?, ?, ?, ?)')
        .run(eventId, input.changeId, version, input.proof, JSON.stringify(release));
      return state(findEvent(eventId, owner));
    });
  }

  function respond(token, input) {
    return transaction(() => {
      const { event, person } = activeLink(token);
      if (person.status !== '已确认') throw new RegistrationError(409, '报名审核状态已变更，请联系活动负责人。');
      let attendance = person.attendance;
      let request = person.requestedSessionId;
      if (input.action === 'confirm') attendance = '确认出席';
      else if (input.action === 'decline') { attendance = '无法参加'; request = ''; }
      else if (input.action === 'change-session') {
        if (!event.agenda.some(item => item.id === input.sessionId && item.id !== person.sessionId)) {
          throw new RegistrationError(400, '请选择另一个可申请的场次。');
        }
        request = input.sessionId;
      } else throw new RegistrationError(400, '请选择要提交的结果。');
      if (attendance === person.attendance && request === person.requestedSessionId) return confirmation(token);
      checkCapacity(event, peopleFor(event.id), { ...person, attendance });
      db.prepare(`UPDATE signups SET attendance = ?, requested_session = ?, responded_at = ?, revision = revision + 1
        WHERE event_id = ? AND id = ?`).run(attendance, request, new Date(now()).toISOString(), event.id, person.id);
      bump(event.id);
      return confirmation(token);
    });
  }

  function importPeople(owner, eventId, rows, expected) {
    if (!Array.isArray(rows) || !rows.length || rows.length > 1000) throw new RegistrationError(400, '每批名单需包含 1–1000 行。');
    return transaction(() => {
      const row = findEvent(eventId, owner);
      const event = JSON.parse(row.snapshot);
      const previewKey = signature(JSON.stringify([owner, eventId, row.revision, rows]));
      if (expected !== undefined && expected !== previewKey) throw new RegistrationError(409, '名单内容或报名状态已更新，请重新预览。');
      const people = peopleFor(eventId);
      const idCounts = new Map();
      const emailCounts = new Map();
      for (const entry of rows) {
        const id = shortText(entry?.id, 101).toUpperCase();
        const email = shortText(entry?.email, 255).toLowerCase();
        if (id) idCounts.set(id, (idCounts.get(id) ?? 0) + 1);
        if (email) emailCounts.set(email, (emailCounts.get(email) ?? 0) + 1);
      }
      const previews = [];
      const matched = new Set();
      for (const [index, entry] of rows.entries()) {
        const location = shortText(entry?.location) || '第 ' + (index + 1) + ' 条';
        const name = shortText(entry?.name, 80);
        try {
          if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new RegistrationError(400, '名单行格式无效。');
          const id = shortText(entry?.id, 101).toUpperCase();
          const email = shortText(entry?.email, 255).toLowerCase();
          if ((id && !validId(id)) || (email && !validEmail(email))) throw new RegistrationError(400, '报名编号或邮箱格式无效。');
          if (idCounts.get(id) > 1 || emailCounts.get(email) > 1) {
            previews.push({ location, name, kind: '重复', detail: '本批次重复出现的编号或邮箱，请核对表格。' });
            continue;
          }
          const byId = people.find(person => id && person.id.toUpperCase() === id);
          const byEmail = people.find(person => email && person.email === email);
          if ((byId && byEmail && byId.id !== byEmail.id) ||
              (!id && !email && people.some(person => person.name === name))) {
            throw new RegistrationError(409, '无法唯一匹配报名，请核对编号和邮箱后重试。');
          }
          const current = byId ?? byEmail;
          if (current && matched.has(current.id)) {
            previews.push({ location, name, kind: '重复', detail: '本批多行指向同一报名记录。' });
            continue;
          }
          const fields = { ...current, ...entry, name };
          if (Object.hasOwn(entry, 'session')) {
            const session = shortText(entry.session);
            const matches = event.agenda.filter(item => item.id === session || item.title === session);
            if (session && session !== '全场' && matches.length !== 1) throw new RegistrationError(400, '场次未知或重名，请填写场次编号。');
            fields.sessionId = matches[0]?.id ?? '';
          }
          const saved = registrationFields(fields, event);
          if (current) matched.add(current.id);
          const unchanged = current && Object.entries(saved).every(([key, value]) => current[key] === value);
          if (unchanged) {
            previews.push({ location, name, kind: '无变化', detail: current.id });
            continue;
          }
          const next = { ...current, ...saved, id: current?.id ?? (id || 'P-' + signature(previewKey + ':' + index).slice(0, 20)) };
          checkCapacity(event, people, next);
          matched.add(next.id);
          if (current) people[people.indexOf(current)] = next;
          else people.push(next);
          previews.push({ location, name, kind: current ? '更新' : '新增', detail: current ? current.id + ' · 保留原凭证' : '创建报名记录' });
          if (expected === undefined) continue;
          if (!current) {
            insertPerson(eventId, next.id, next);
          } else {
            const request = current.sessionId === next.sessionId ? current.requestedSessionId : '';
            db.prepare(`UPDATE signups SET name = ?, email = ?, session_id = ?, status = ?, note = ?, requested_session = ?,
              revision = revision + 1 WHERE event_id = ? AND id = ?`)
              .run(next.name, next.email, next.sessionId, next.status, next.note, request, eventId, next.id);
            if (current.email !== next.email || next.status !== '已确认') revokeLinks(eventId, next.id);
          }
        } catch (error) {
          if (!(error instanceof RegistrationError)) throw error;
          previews.push({ location, name, kind: '待处理', detail: error.message });
        }
      }
      const accepted = previews.filter(item => item.kind === '新增' || item.kind === '更新').length;
      if (expected === undefined) return { previewKey, rows, previews, accepted };
      if (accepted) bump(eventId);
      return { accepted, state: state(findEvent(eventId, owner)) };
    });
  }

  return {
    list, open, get: (owner, id) => state(findEvent(id, owner)), changeEvent, savePerson, publicEvent, publicSignup,
    issueLink, revoke, confirmation, respond, importPeople, checkIn, recordActual, rescuePreview, publishRescue, close: () => db.close(),
    mail: { db, now, transaction, findEvent, personFor, tokenFor, issueLink, mailSelect },
  };
}
