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
  run_id TEXT,
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

CREATE TABLE IF NOT EXISTS webhook_events (
  delivery_id TEXT PRIMARY KEY,
  received_at TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  incident_id INTEGER,
  error TEXT
);

CREATE TABLE IF NOT EXISTS webhook_retries (
  delivery_id TEXT PRIMARY KEY,
  retry_count INTEGER NOT NULL,
  last_received_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS retell_webhook_events (
  event_id TEXT PRIMARY KEY,
  received_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS action_executions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  proposed_action_id INTEGER NOT NULL UNIQUE REFERENCES proposed_actions(id),
  incident_id INTEGER NOT NULL REFERENCES incidents(id),
  actor TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  result TEXT,
  verification TEXT
);

CREATE TABLE IF NOT EXISTS verification_samples (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  execution_id INTEGER NOT NULL REFERENCES action_executions(id),
  observed_at TEXT NOT NULL,
  successful_checkouts INTEGER NOT NULL DEFAULT 0,
  checkout_window_ms INTEGER NOT NULL DEFAULT 0,
  successful_traces INTEGER NOT NULL DEFAULT 0,
  telemetry_error TEXT,
  result TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS phone_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  incident_id INTEGER NOT NULL REFERENCES incidents(id),
  responder TEXT NOT NULL,
  phone_number TEXT NOT NULL,
  retell_call_id TEXT UNIQUE,
  status TEXT NOT NULL,
  briefing TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  outcome TEXT
);

-- What an engineer decided about a proposal, why, and what fixed things in the end. Read back by the
-- investigator on later incidents. It informs proposals; it never grants permission to act.
CREATE TABLE IF NOT EXISTS decision_feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  incident_id INTEGER NOT NULL REFERENCES incidents(id),
  proposed_action_id INTEGER NOT NULL UNIQUE REFERENCES proposed_actions(id),
  service TEXT NOT NULL,
  environment TEXT NOT NULL,
  action TEXT NOT NULL,
  decision TEXT NOT NULL,                -- declined
  reason TEXT,                           -- the engineer's own words
  responder TEXT NOT NULL,
  diagnosis TEXT,                        -- JSON: what the system believed when it proposed this
  resolution TEXT,                       -- what actually restored service, filled in later
  decided_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS retrospectives (
  incident_id INTEGER PRIMARY KEY REFERENCES incidents(id),
  summary TEXT NOT NULL,
  unresolved_work TEXT NOT NULL,
  generated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  incident_id INTEGER NOT NULL REFERENCES incidents(id),
  responder TEXT NOT NULL,
  phone_number TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 1,
  conversation_id TEXT,
  sip_call_id TEXT,
  outcome TEXT NOT NULL DEFAULT 'initiated',  -- initiated | answered | acknowledged | approved | failed | unanswered
  briefing TEXT NOT NULL,
  proposed_action_id INTEGER REFERENCES proposed_actions(id),
  started_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  ended_at TEXT
);
`);

const incidentColumns = db.prepare(`PRAGMA table_info(incidents)`).all() as { name: string }[];
if (!incidentColumns.some((column) => column.name === "run_id")) {
  db.exec(`ALTER TABLE incidents ADD COLUMN run_id TEXT`);
}

// Manually configured owners; a rotation calendar is out of scope.
db.prepare(
  `INSERT OR IGNORE INTO services (name, dependencies, primary_responder, backup_responder) VALUES (?, ?, ?, ?)`,
).run(
  "checkout",
  JSON.stringify(["recommendations", "payments"]),
  process.env.PRIMARY_RESPONDER ?? "primary-engineer",
  process.env.BACKUP_RESPONDER ?? "backup-engineer",
);
