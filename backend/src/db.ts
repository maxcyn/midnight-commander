import { DatabaseSync } from "node:sqlite";

// DB_PATH=:memory: is used by the tests; the default file survives restarts.
export const db = new DatabaseSync(process.env.DB_PATH ?? "secondshift.db");
db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");

db.exec(`
CREATE TABLE IF NOT EXISTS services (
  name TEXT PRIMARY KEY,
  dependencies TEXT NOT NULL,          -- JSON array
  primary_responder TEXT NOT NULL,
  backup_responder TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS incidents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  service TEXT NOT NULL REFERENCES services(name),
  environment TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  severity TEXT NOT NULL DEFAULT 'sev2',
  title TEXT NOT NULL,
  sentry_issue_id TEXT NOT NULL,       -- recurrence key, together with environment
  previous_incident_id INTEGER REFERENCES incidents(id),
  -- Tracked separately on purpose: "escalated" or "acknowledged" never implies recovery.
  ack_state TEXT NOT NULL DEFAULT 'unacknowledged',
  acknowledged_by TEXT,
  escalation_state TEXT NOT NULL DEFAULT 'none',
  owner TEXT NOT NULL,
  autonomy TEXT NOT NULL DEFAULT 'allowed',   -- 'halted' once a human takes over
  alert_count INTEGER NOT NULL DEFAULT 1,
  opened_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  recovered_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_incident_key ON incidents(sentry_issue_id, environment);

CREATE TABLE IF NOT EXISTS evidence (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  incident_id INTEGER NOT NULL REFERENCES incidents(id),
  source TEXT NOT NULL,
  source_id TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  content TEXT NOT NULL,               -- JSON or reference
  UNIQUE(incident_id, source, source_id)
);

CREATE TABLE IF NOT EXISTS timeline_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  incident_id INTEGER NOT NULL REFERENCES incidents(id),
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  result TEXT NOT NULL DEFAULT 'ok',
  detail TEXT
);

CREATE TABLE IF NOT EXISTS proposed_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  incident_id INTEGER NOT NULL REFERENCES incidents(id),
  action TEXT NOT NULL,
  target_environment TEXT NOT NULL,
  parameters TEXT NOT NULL DEFAULT '{}',
  expires_at TEXT NOT NULL,
  approval_state TEXT NOT NULL DEFAULT 'pending',
  approved_by TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runbook_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  runbook_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  lifecycle TEXT NOT NULL DEFAULT 'draft',    -- draft -> evaluated -> authorised -> suspended
  spec TEXT NOT NULL,                          -- JSON: conditions, operation, verification
  evaluation TEXT,                             -- JSON results
  created_at TEXT NOT NULL,
  UNIQUE(runbook_id, version)
);

CREATE TABLE IF NOT EXISTS investigations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  incident_id INTEGER NOT NULL REFERENCES incidents(id),
  run_id TEXT,
  status TEXT NOT NULL DEFAULT 'running',     -- running | submitted | timed_out | failed
  started_at TEXT NOT NULL,
  finished_at TEXT,
  result TEXT,                                 -- agent's structured result (JSON)
  decision TEXT                                -- backend's decision (JSON)
);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  delivery_id TEXT PRIMARY KEY,
  received_at TEXT NOT NULL,
  incident_id INTEGER
);
`);

// Manually configured owners; a rotation calendar is out of scope.
db.prepare(
  `INSERT OR IGNORE INTO services (name, dependencies, primary_responder, backup_responder) VALUES (?, ?, ?, ?)`,
).run(
  "checkout",
  JSON.stringify(["recommendations", "payments"]),
  process.env.PRIMARY_RESPONDER ?? "primary-engineer",
  process.env.BACKUP_RESPONDER ?? "backup-engineer",
);
