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
    db = new SQL.Database(fs.readFileSync(dbPath));
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
  `);

  persist();
  return db;
}

function getDb() {
  if (!db) throw new Error('Database not initialized. Call initDb() first.');
  return db;
}

function persist() {
  fs.writeFileSync(dbPath, Buffer.from(db.export()));
}

function buildRow(appData) {
  const row = {};
  for (const f of FIELDS) {
    row[f] = appData[f] != null ? String(appData[f]) : null;
  }
  return row;
}

function rowExists(id) {
  const stmt = db.prepare('SELECT id FROM applications WHERE id = ?');
  stmt.bind([id]);
  const found = stmt.step();
  stmt.free();
  return found;
}

// Insert or update a single application. Does NOT persist on its own so callers
// can batch many writes and flush once.
function upsertRow(appData) {
  const now = new Date().toISOString();
  const id = appData.id || randomUUID();
  const row = buildRow(appData);

  if (rowExists(id)) {
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

module.exports = {
  initDb,
  getDb,
  upsertApplication,
  upsertMany,
  getDateCounts,
  listApplications,
};
