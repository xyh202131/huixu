import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { activityTypes } from '../src/model.js';
import { workspaceHistoryLimit } from '../src/agentConversation.js';
import { readBody, sendJson } from './localApi.js';

const maxBytes = 8 * 1024 * 1024;
const eventLists = ['agenda', 'rooms', 'tasks', 'files', 'issues', 'attendees', 'replies', 'checkins', 'history', 'messages', 'quotes'];

function validate(input) {
  const { events, activeId, conversations } = input ?? {};
  if (!Array.isArray(events) || !events.length || !Array.isArray(conversations)) return null;
  const ids = new Set();
  for (const event of events) {
    if (!event || typeof event.id !== 'string' || !/^[\w-]{1,100}$/.test(event.id) || ids.has(event.id) ||
        typeof event.title !== 'string' || !activityTypes.includes(event.type) ||
        !event.actual || typeof event.actual !== 'object' || !eventLists.every(key => Array.isArray(event[key]))) return null;
    ids.add(event.id);
  }
  const reviewed = new Set();
  for (const item of conversations) {
    if (!Array.isArray(item) || item.length !== 2) return null;
    const [id, turns] = item;
    if (!ids.has(id) || reviewed.has(id) || !Array.isArray(turns) || turns.length > workspaceHistoryLimit ||
        !turns.every(turn => turn?.eventId === id && typeof turn.question === 'string')) return null;
    reviewed.add(id);
  }
  return ids.has(activeId) ? { events, activeId, conversations } : null;
}

export function createWorkspaceStore(path) {
  let db;
  function connection() {
    if (db) return db;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const next = new DatabaseSync(path);
    try {
      next.exec(`PRAGMA busy_timeout = 5000;
        PRAGMA journal_mode = WAL;
        PRAGMA secure_delete = ON;
        CREATE TABLE IF NOT EXISTS workspace_state (
          id INTEGER PRIMARY KEY CHECK (id = 1), revision INTEGER NOT NULL, data TEXT NOT NULL
        );
      `);
    } catch (error) {
      next.close();
      throw error;
    }
    db = next;
    return db;
  }

  async function handle(request, response, user) {
    if (new URL(request.url, 'http://localhost').pathname !== '/') return sendJson(response, 404, { error: '没有此工作区操作。' });
    try {
      if (request.method === 'GET') {
        const row = connection().prepare('SELECT revision, data FROM workspace_state WHERE id = 1').get();
        return sendJson(response, 200, row ? { revision: row.revision, data: JSON.parse(row.data) } : { revision: 0, data: null });
      }
      if (request.method !== 'POST') return sendJson(response, 405, { error: '不支持此工作区操作。' });
      if (request.headers['content-type']?.split(';')[0] !== 'application/json') return sendJson(response, 415, { error: '请提交 JSON 数据。' });
      const bytes = await readBody(request, maxBytes);
      if (!bytes) return sendJson(response, 413, { error: '工作区数据已超过 8 MB，暂时无法同步。' });
      let input;
      try { input = JSON.parse(bytes.toString('utf8')); } catch {
        return sendJson(response, 400, { error: '工作区数据格式无效。' });
      }
      if (input?.accountId !== user.id) return sendJson(response, 409, { error: '当前账号已切换，请重新打开工作台。' });
      const { revision } = input;
      const data = validate(input.data);
      if (!data || !Number.isSafeInteger(revision) || revision < 0) return sendJson(response, 400, { error: '工作区数据或版本无效。' });
      // 写入只接受基于当前修订的版本，避免覆盖另一设备保存的活动和对话。
      const stored = JSON.stringify(data);
      const database = connection();
      const result = revision === 0
        ? database.prepare('INSERT OR IGNORE INTO workspace_state VALUES (1, 1, ?)').run(stored)
        : database.prepare('UPDATE workspace_state SET revision = revision + 1, data = ? WHERE id = 1 AND revision = ?').run(stored, revision);
      if (!result.changes) {
        // 首次写入已提交但浏览器未收到响应时，允许原请求重试。
        const alreadySaved = database.prepare('SELECT 1 FROM workspace_state WHERE id = 1 AND revision = ? AND data = ?').get(revision + 1, stored);
        if (!alreadySaved) return sendJson(response, 409, { error: '工作区在另一窗口或设备上已更新。', code: 'WORKSPACE_CONFLICT' });
      }
      return sendJson(response, 200, { revision: revision + 1 });
    } catch {
      if (!response.destroyed && !response.headersSent) sendJson(response, 503, { error: '工作区数据库暂时不可用，请稍后重试。' });
    }
  }

  return { handle, close() { db?.close(); db = undefined; } };
}
