import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { localDatabasePath } from './localData.js';
import { parseSource } from './sourceParser.js';

const sourceFields = 'id, name, revision, size, state, note, agent_access AS agentAccess, chunk_count AS chunkCount, imported_at AS importedAt';
const retryable = new Set(['待处理', '待 OCR', '待转换']);
const currentSource = `NOT EXISTS (
  SELECT 1 FROM memory_sources newer
  WHERE newer.event_id = s.event_id AND newer.name = s.name AND newer.revision > s.revision
)`;

function terms(text, forIndex = false) {
  const words = text.normalize('NFKC').toLowerCase().match(/\p{Script=Han}+|[a-z0-9]+/gu) ?? [];
  const tokens = new Set();
  for (const word of words) {
    if (/^[a-z0-9]/.test(word)) {
      tokens.add(word.slice(0, 64));
      continue;
    }
    const chars = [...word];
    if (forIndex || chars.length === 1) for (const char of chars) tokens.add(char);
    for (let index = 1; index < chars.length; index += 1) tokens.add(chars[index - 1] + chars[index]);
  }
  return [...tokens];
}

function initialize(db) {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS memory_sources (
      id TEXT PRIMARY KEY, event_id TEXT NOT NULL, name TEXT NOT NULL,
      revision INTEGER NOT NULL, hash TEXT NOT NULL, size INTEGER NOT NULL, original BLOB NOT NULL,
      state TEXT NOT NULL, note TEXT NOT NULL, agent_access INTEGER NOT NULL, chunk_count INTEGER NOT NULL,
      imported_at TEXT NOT NULL,
      UNIQUE(event_id, name, revision), UNIQUE(event_id, name, hash)
    );
    CREATE TABLE IF NOT EXISTS memory_chunks (
      id INTEGER PRIMARY KEY, source_id TEXT NOT NULL REFERENCES memory_sources(id),
      location TEXT NOT NULL, body TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS memory_chunks_source ON memory_chunks(source_id);
    CREATE TABLE IF NOT EXISTS memory_archive_entries (
      source_id TEXT PRIMARY KEY REFERENCES memory_sources(id), entries TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS memory_organization (
      event_id TEXT PRIMARY KEY, revision TEXT NOT NULL, review TEXT NOT NULL
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(body, title);
  `);
}

export function createProjectMemory(root, override) {
  const dbPath = localDatabasePath(root, override, 'memory.sqlite');
  let database;
  function getDb() {
    if (database) return database;
    mkdirSync(dirname(dbPath), { recursive: true });
    const connection = new DatabaseSync(dbPath);
    try { initialize(connection); } catch (error) { connection.close(); throw error; }
    database = connection;
    return database;
  }

  function list(eventId) {
    return getDb().prepare(`SELECT ${sourceFields}, (${currentSource}) AS current
      FROM memory_sources s WHERE event_id = ? ORDER BY imported_at DESC, name, revision DESC`).all(eventId);
  }

  async function add(eventId, name, buffer, agentAccess) {
    const db = getDb();
    const hash = createHash('sha256').update(buffer).digest('hex');
    const getExisting = db.prepare(`SELECT ${sourceFields} FROM memory_sources WHERE event_id = ? AND name = ? AND hash = ?`);
    const previous = getExisting.get(eventId, name, hash);
    if (previous && (previous.chunkCount || !retryable.has(previous.state))) return { source: previous, duplicate: true };
    const parsed = await parseSource(name, buffer);
    db.exec('BEGIN IMMEDIATE');
    try {
      const existing = getExisting.get(eventId, name, hash);
      if (existing && (existing.chunkCount || !retryable.has(existing.state) || !parsed.chunks.length && parsed.state === existing.state)) {
        db.exec('COMMIT');
        return { source: existing, duplicate: true };
      }
      const id = existing?.id ?? randomUUID();
      if (existing) {
        db.prepare('UPDATE memory_sources SET state = ?, note = ?, chunk_count = ? WHERE id = ?')
          .run(parsed.state, parsed.note, parsed.chunks.length, id);
      } else {
        const { revision } = db.prepare('SELECT COALESCE(MAX(revision), 0) + 1 AS revision FROM memory_sources WHERE event_id = ? AND name = ?').get(eventId, name);
        db.prepare(`INSERT INTO memory_sources VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(id, eventId, name, revision, hash, buffer.length, buffer, parsed.state, parsed.note, Number(agentAccess), parsed.chunks.length, new Date().toISOString());
      }
      const addChunk = db.prepare('INSERT INTO memory_chunks (source_id, location, body) VALUES (?, ?, ?)');
      const addIndex = db.prepare('INSERT INTO memory_fts (rowid, body, title) VALUES (?, ?, ?)');
      const titleTokens = terms(name, true).join(' ');
      for (const { location, text, entryIndex } of parsed.chunks) {
        const { lastInsertRowid } = addChunk.run(id, location, text);
        addIndex.run(lastInsertRowid, terms(`${location}\n${text}`, true).join(' '), titleTokens);
        const entry = parsed.entries?.[entryIndex];
        if (entry && !entry.chunkId) entry.chunkId = Number(lastInsertRowid);
      }
      if (parsed.entries) db.prepare('INSERT OR REPLACE INTO memory_archive_entries VALUES (?, ?)').run(id, JSON.stringify(parsed.entries));
      const source = getExisting.get(eventId, name, hash);
      db.exec('COMMIT');
      return { source, duplicate: false };
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  function search(eventId, query, forAgent = false, sourceName = '') {
    const tokens = terms(query).slice(0, 64);
    if (!tokens.length) return [];
    const expression = tokens.map(token => `"${token}"`).join(' OR ');
    const find = getDb().prepare(`
      SELECT c.id AS chunkId, s.id AS sourceId, s.name, s.revision, c.location,
        substr(c.body, 1, 1200) AS excerpt
      FROM memory_fts JOIN memory_chunks c ON c.id = memory_fts.rowid JOIN memory_sources s ON s.id = c.source_id
      WHERE memory_fts MATCH ? AND s.event_id = ? AND s.agent_access >= ? AND (? = '' OR s.name = ? COLLATE NOCASE) AND ${currentSource}
      ORDER BY bm25(memory_fts, 1.0, 1.5), c.id LIMIT ?
    `);
    const filters = [eventId, Number(forAgent), sourceName, sourceName, forAgent ? 5 : 20];
    const hits = find.all(`body : (${expression})`, ...filters);
    return hits.length ? hits : find.all(`title : (${expression})`, ...filters);
  }

  function excerpt(eventId, chunkId, forAgent = false) {
    return getDb().prepare(`SELECT c.id AS chunkId, s.id AS sourceId, s.name, s.revision, c.location, c.body AS excerpt
      FROM memory_chunks c JOIN memory_sources s ON s.id = c.source_id
      WHERE s.event_id = ? AND c.id = ? AND s.agent_access >= ? ${forAgent ? `AND ${currentSource}` : ''}`)
      .get(eventId, chunkId, Number(forAgent));
  }

  function firstExcerpt(eventId, sourceId) {
    return getDb().prepare(`SELECT c.id AS chunkId, s.id AS sourceId, s.name, s.revision, c.location, c.body AS excerpt
      FROM memory_chunks c JOIN memory_sources s ON s.id = c.source_id
      WHERE s.event_id = ? AND s.id = ? ORDER BY c.id LIMIT 1`).get(eventId, sourceId);
  }

  function setAgentAccess(eventId, sourceId, agentAccess) {
    return getDb().prepare(`UPDATE memory_sources AS s SET agent_access = ?
      WHERE event_id = ? AND id = ? AND chunk_count > 0 AND ${currentSource}`).run(Number(agentAccess), eventId, sourceId).changes > 0;
  }

  function original(eventId, sourceId) {
    return getDb().prepare('SELECT name, original FROM memory_sources WHERE event_id = ? AND id = ?').get(eventId, sourceId);
  }

  function contents(eventId, sourceId) {
    const source = getDb().prepare(`SELECT s.name, s.revision, s.state, s.note, a.entries FROM memory_sources s
      LEFT JOIN memory_archive_entries a ON a.source_id = s.id WHERE s.event_id = ? AND s.id = ?`).get(eventId, sourceId);
    if (!source) return undefined;
    return { ...source, entries: source.entries ? JSON.parse(source.entries) : [] };
  }

  function organizationScope(eventId) {
    const active = list(eventId).filter(source => source.current);
    const approved = active.filter(source => source.agentAccess && source.chunkCount);
    const versions = approved.map(source => [source.id, source.revision, source.chunkCount]).sort();
    return {
      revision: createHash('sha256').update(JSON.stringify(versions)).digest('hex'),
      total: approved.reduce((total, source) => total + source.chunkCount, 0),
      excluded: active.filter(source => !source.agentAccess && source.chunkCount).length,
      unparsed: active.filter(source => !source.chunkCount).length,
    };
  }

  function organizationInput(eventId, scope) {
    const chunks = getDb().prepare(`SELECT c.id AS chunkId, s.name, s.revision, c.location, c.body AS text
      FROM memory_sources s JOIN memory_chunks c ON c.source_id = s.id
      WHERE s.event_id = ? AND s.agent_access = 1 AND ${currentSource}
      ORDER BY c.id LIMIT 2500`).all(eventId);
    return { ...scope, chunks };
  }

  function readOrganization(eventId, revision) {
    const row = getDb().prepare('SELECT review FROM memory_organization WHERE event_id = ? AND revision = ?').get(eventId, revision);
    return row ? JSON.parse(row.review) : null;
  }

  function saveOrganization(eventId, revision, review) {
    getDb().prepare('INSERT OR REPLACE INTO memory_organization (event_id, revision, review) VALUES (?, ?, ?)')
      .run(eventId, revision, JSON.stringify(review));
  }

  function wiki(eventId) {
    const rows = list(eventId);
    const lines = ['# 活动资料索引', '', '本页根据导入记录生成。文字片段保留原始来源，待负责人核对。', ''];
    for (const source of rows.filter(row => row.current)) {
      const sourceExcerpt = firstExcerpt(eventId, source.id);
      lines.push(`## ${source.name}`, '', `- 版本 v${source.revision} · ${source.state} · ${source.chunkCount} 个片段`,
        `- 导入时间 ${source.importedAt}`, `- Agent 引用 ${source.agentAccess ? '允许' : '关闭'}`, '');
      if (sourceExcerpt) lines.push(`原文位置 · ${sourceExcerpt.location}`, '', ...sourceExcerpt.excerpt.slice(0, 350).split('\n').map(line => `> ${line}`), '');
    }
    return lines.join('\n');
  }

  function close() {
    database?.close();
    database = undefined;
  }

  return { list, add, search, excerpt, firstExcerpt, original, contents, wiki, setAgentAccess, close,
    organizationScope, organizationInput, readOrganization, saveOrganization };
}
