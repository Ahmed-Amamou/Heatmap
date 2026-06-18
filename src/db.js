const path = require('path');
const fs = require('fs');
const { randomUUID } = require('crypto');
const { app } = require('electron');
const initSqlJs = require('sql.js');

let SQL;
let db;
let dbPath;

const FIELDS = [
  'job_title', 'description', 'company', 'location', 'job_type',
  'applying_date', 'resume_version', 'status', 'contact', 'notes',
];

// sql.js is WASM: the whole database lives in memory and is flushed to disk
// after each mutation. locateFile points at the .wasm asset, which is unpacked
// from the asar in packaged builds.
async function initDb() {
  if (db) return db;

  SQL = await initSqlJs({
    locateFile: (file) =>
      path
        .join(__dirname, '..', 'node_modules', 'sql.js', 'dist', file)
        .replace('app.asar', 'app.asar.unpacked'),
  });

  dbPath = path.join(app.getPath('userData'), 'heatmap.db');

  if (fs.existsSync(dbPath)) {
    const bytes = fs.readFileSync(dbPath);
    db = new SQL.Database(bytes);
    // The file opened fine — keep a copy as the last-known-good fallback.
    try {
      fs.writeFileSync(dbPath + '.bak', bytes);
    } catch {}
  } else {
    db = new SQL.Database();
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS applications (
      id             TEXT PRIMARY KEY,
      job_title      TEXT,
      description    TEXT,
      company        TEXT,
      location       TEXT,
      job_type       TEXT,
      applying_date  TEXT,
      resume_version TEXT,
      status         TEXT,
      contact        TEXT,
      notes          TEXT,
      created_at     TEXT NOT NULL,
      updated_at     TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_applying_date ON applications(applying_date);

    CREATE TABLE IF NOT EXISTS interviews (
      id             TEXT PRIMARY KEY,
      application_id TEXT NOT NULL,
      stage          TEXT,
      scheduled_at   TEXT,
      format         TEXT,
      interviewer    TEXT,
      notes          TEXT,
      outcome        TEXT,
      reminded_day   INTEGER DEFAULT 0,
      reminded_hour  INTEGER DEFAULT 0,
      created_at     TEXT NOT NULL,
      updated_at     TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_interviews_app ON interviews(application_id);
  `);

  persist();
  return db;
}

function getDb() {
  if (!db) throw new Error('Database not initialized. Call initDb() first.');
  return db;
}

// Atomic flush: write to a temp file, then rename over the real one, so a
// crash or power loss mid-write can never leave a half-written (corrupt) DB.
function persist() {
  const tmpPath = dbPath + '.tmp';
  fs.writeFileSync(tmpPath, Buffer.from(db.export()));
  fs.renameSync(tmpPath, dbPath);
}

function buildRow(appData) {
  const row = {};
  for (const f of FIELDS) {
    row[f] = appData[f] != null ? String(appData[f]) : null;
  }
  return row;
}

// Insert or update a single application. Does NOT persist on its own so callers
// can batch many writes and flush once.
function upsertRow(appData) {
  const now = new Date().toISOString();
  const id = appData.id || randomUUID();
  const row = buildRow(appData);

  const existing = getApplication(id);
  if (existing) {
    // Only touch updated_at when a field actually changed. The sheet importer
    // re-writes every row on each sync, so bumping unconditionally would make
    // updated_at mean "last import" rather than "last real change" — which is
    // exactly the signal we need to tell genuine activity from background syncs.
    const changed = FIELDS.some((f) => (existing[f] ?? null) !== (row[f] ?? null));
    if (!changed) return id;

    const setClause = FIELDS.map((f) => `${f} = ?`).join(', ');
    const params = FIELDS.map((f) => row[f]);
    params.push(now, id);
    db.run(
      `UPDATE applications SET ${setClause}, updated_at = ? WHERE id = ?`,
      params
    );
  } else {
    const cols = ['id', ...FIELDS, 'created_at', 'updated_at'];
    const placeholders = cols.map(() => '?').join(', ');
    const params = [id, ...FIELDS.map((f) => row[f]), now, now];
    db.run(
      `INSERT INTO applications (${cols.join(', ')}) VALUES (${placeholders})`,
      params
    );
  }

  return id;
}

function upsertApplication(appData) {
  const id = upsertRow(appData);
  persist();
  return id;
}

function upsertMany(apps) {
  const ids = [];
  for (const item of apps) ids.push(upsertRow(item));
  persist();
  return ids;
}

function getDateCounts() {
  const stmt = db.prepare(
    `SELECT applying_date AS date, COUNT(*) AS count
     FROM applications
     WHERE applying_date IS NOT NULL AND applying_date != ''
     GROUP BY applying_date`
  );

  const counts = {};
  while (stmt.step()) {
    const { date, count } = stmt.getAsObject();
    counts[date] = count;
  }
  stmt.free();
  return counts;
}

function listApplications() {
  const stmt = db.prepare(
    'SELECT * FROM applications ORDER BY applying_date DESC'
  );

  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function getApplication(id) {
  const stmt = db.prepare('SELECT * FROM applications WHERE id = ?');
  stmt.bind([id]);
  const row = stmt.step() ? stmt.getAsObject() : null;
  stmt.free();
  return row;
}

function deleteApplication(id) {
  db.run('DELETE FROM applications WHERE id = ?', [id]);
  persist();
}

// ── Interviews ──
// scheduled_at is stored as the datetime-local string 'YYYY-MM-DDTHH:MM'
// (local time, sorts lexicographically).
const IV_FIELDS = ['application_id', 'stage', 'scheduled_at', 'format', 'interviewer', 'notes', 'outcome'];

function upsertInterview(data) {
  const now = new Date().toISOString();
  const id = data.id || randomUUID();
  const row = {};
  for (const f of IV_FIELDS) row[f] = data[f] != null ? String(data[f]) : null;
  if (!row.outcome) row.outcome = 'upcoming';

  const stmt = db.prepare('SELECT id FROM interviews WHERE id = ?');
  stmt.bind([id]);
  const exists = stmt.step();
  stmt.free();

  if (exists) {
    const setClause = IV_FIELDS.map((f) => `${f} = ?`).join(', ');
    // A reschedule re-arms the reminders.
    db.run(
      `UPDATE interviews SET ${setClause}, updated_at = ?,
         reminded_day = CASE WHEN scheduled_at IS NOT ? THEN 0 ELSE reminded_day END,
         reminded_hour = CASE WHEN scheduled_at IS NOT ? THEN 0 ELSE reminded_hour END
       WHERE id = ?`,
      [...IV_FIELDS.map((f) => row[f]), now, row.scheduled_at, row.scheduled_at, id]
    );
  } else {
    db.run(
      `INSERT INTO interviews (id, ${IV_FIELDS.join(', ')}, created_at, updated_at)
       VALUES (?, ${IV_FIELDS.map(() => '?').join(', ')}, ?, ?)`,
      [id, ...IV_FIELDS.map((f) => row[f]), now, now]
    );
  }
  persist();
  return id;
}

function listInterviews(applicationId) {
  const stmt = db.prepare(
    'SELECT * FROM interviews WHERE application_id = ? ORDER BY scheduled_at ASC, created_at ASC'
  );
  stmt.bind([applicationId]);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function listAllInterviews() {
  const stmt = db.prepare('SELECT * FROM interviews ORDER BY scheduled_at ASC');
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

// Upcoming interviews joined with their application, soonest first.
function listUpcoming() {
  const stmt = db.prepare(
    `SELECT i.*, a.job_title, a.company
     FROM interviews i JOIN applications a ON a.id = i.application_id
     WHERE i.outcome = 'upcoming' AND i.scheduled_at IS NOT NULL AND i.scheduled_at != ''
     ORDER BY i.scheduled_at ASC`
  );
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function getInterview(id) {
  const stmt = db.prepare('SELECT * FROM interviews WHERE id = ?');
  stmt.bind([id]);
  const row = stmt.step() ? stmt.getAsObject() : null;
  stmt.free();
  return row;
}

function deleteInterview(id) {
  db.run('DELETE FROM interviews WHERE id = ?', [id]);
  persist();
}

function deleteInterviewsForApplication(applicationId) {
  const ids = listInterviews(applicationId).map((i) => i.id);
  db.run('DELETE FROM interviews WHERE application_id = ?', [applicationId]);
  persist();
  return ids;
}

function markReminded(id, which) {
  const col = which === 'hour' ? 'reminded_hour' : 'reminded_day';
  db.run(`UPDATE interviews SET ${col} = 1 WHERE id = ?`, [id]);
  persist();
}

module.exports = {
  initDb,
  getDb,
  upsertApplication,
  upsertMany,
  getDateCounts,
  listApplications,
  getApplication,
  deleteApplication,
  upsertInterview,
  listInterviews,
  listAllInterviews,
  listUpcoming,
  getInterview,
  deleteInterview,
  deleteInterviewsForApplication,
  markReminded,
};
