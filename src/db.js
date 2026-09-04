import initSqlJs from "sql.js";
import path from "path";
import fs from "fs";

const DB_PATH = process.env.DB_PATH || path.join(process.cwd(), "data", "mailer.db");

let _db = null;

export async function initDb() {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const SQL = await initSqlJs();

  let data = null;
  if (fs.existsSync(DB_PATH)) {
    data = fs.readFileSync(DB_PATH);
  }

  const db = new SQL.Database(data || undefined);

  db.run("PRAGMA journal_mode = WAL");

  db.run(`
    CREATE TABLE IF NOT EXISTS deliveries (
      message_id TEXT PRIMARY KEY,
      subject TEXT DEFAULT '',
      order_amount TEXT DEFAULT '',
      buyer_email TEXT DEFAULT '',
      status TEXT DEFAULT '',
      attempt_count INTEGER DEFAULT 0,
      last_error TEXT DEFAULT '',
      detected_at TEXT DEFAULT (datetime('now')),
      sent_at TEXT DEFAULT '',
      updated_at TEXT DEFAULT (datetime('now'))
    )
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL DEFAULT (datetime('now')),
      level TEXT NOT NULL DEFAULT 'info',
      action TEXT DEFAULT '',
      detail TEXT DEFAULT '',
      message_id TEXT DEFAULT '',
      buyer_email TEXT DEFAULT ''
    )
  `);
  db.run("CREATE INDEX IF NOT EXISTS idx_events_ts ON events (ts)");
  db.run("CREATE INDEX IF NOT EXISTS idx_deliveries_status ON deliveries (status)");

  _db = db;
  return db;
}

function save() {
  if (!_db) return;
  const data = _db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(DB_PATH, buffer);
}

function queryAll(sql, params = []) {
  const stmt = _db.prepare(sql);
  if (params.length) stmt.bind(params);
  const rows = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
}

function queryOne(sql, params = []) {
  const stmt = _db.prepare(sql);
  if (params.length) stmt.bind(params);
  let row = null;
  if (stmt.step()) row = stmt.getAsObject();
  stmt.free();
  return row;
}

function run(sql, params = []) {
  _db.run(sql, params);
  save();
}

export function logEvent(db, { level = "info", action, detail = "", messageId = "", buyerEmail = "" }) {
  try {
    run(
      "INSERT INTO events (level, action, detail, message_id, buyer_email) VALUES (?, ?, ?, ?, ?)",
      [level, action, (detail || "").slice(0, 2000), messageId, buyerEmail]
    );
  } catch (e) {
    console.error("logEvent failed:", e.message);
  }
}

export function markSending(db, msgId, subject, orderAmount, buyerEmail) {
  run(
    "INSERT OR REPLACE INTO deliveries (message_id, subject, order_amount, buyer_email, status, attempt_count, detected_at, updated_at) VALUES (?, ?, ?, ?, 'sending', 1, datetime('now'), datetime('now'))",
    [msgId, (subject || "").slice(0, 500), orderAmount, buyerEmail]
  );
}

export function markSent(db, msgId) {
  run(
    "UPDATE deliveries SET status='sent', sent_at=datetime('now'), updated_at=datetime('now'), last_error='' WHERE message_id=?",
    [msgId]
  );
}

export function markFailed(db, msgId, error) {
  run(
    "UPDATE deliveries SET status='failed', updated_at=datetime('now'), last_error=?, attempt_count=attempt_count+1 WHERE message_id=?",
    [String(error).slice(0, 1000), msgId]
  );
}

export function isDuplicateBySubject(db, subject) {
  const row = queryOne(
    "SELECT message_id FROM deliveries WHERE subject = ? AND status IN ('sent','sending','needs-manual','skipped','baseline')",
    [subject]
  );
  return !!row;
}

export function getDeliveries(db, limit = 200) {
  return queryAll(
    "SELECT message_id, subject, order_amount, buyer_email, status, last_error, detected_at, sent_at FROM deliveries ORDER BY detected_at DESC LIMIT ?",
    [limit]
  );
}

export function getEvents(db, limit = 50) {
  return queryAll(
    "SELECT ts, level, action, detail FROM events ORDER BY ts DESC LIMIT ?",
    [limit]
  );
}

export function getSummaryCounts(db) {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  return {
    sentToday: queryOne(
      "SELECT COUNT(*) AS c FROM deliveries WHERE status='sent' AND sent_at IS NOT NULL AND sent_at >= ?",
      [since]
    )?.c || 0,
    failed: queryOne(
      "SELECT COUNT(*) AS c FROM deliveries WHERE status='failed'"
    )?.c || 0,
    needsManual: queryOne(
      "SELECT COUNT(*) AS c FROM deliveries WHERE status='needs-manual'"
    )?.c || 0,
    lastSentAt: queryOne(
      "SELECT MAX(sent_at) AS m FROM deliveries WHERE status='sent'"
    )?.m || null,
  };
}

export function getRecentFailures(db, limit = 10) {
  return queryAll(
    "SELECT buyer_email, subject, last_error, updated_at FROM deliveries WHERE status='failed' ORDER BY updated_at DESC LIMIT ?",
    [limit]
  );
}
