import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

export type DB = Database.Database;

const SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS incidents (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  ai_system TEXT NOT NULL,
  known_versions TEXT NOT NULL,          -- JSON string[]
  start_at TEXT NOT NULL,                -- UTC ISO instant
  end_at TEXT NOT NULL,                  -- UTC ISO instant (exclusive)
  timezone TEXT NOT NULL,                -- IANA zone used for entry and display
  incorrect_behavior TEXT NOT NULL,
  scope_criteria TEXT NOT NULL,          -- JSON ScopeCriteria
  exclusions TEXT NOT NULL,              -- JSON string[] (human-readable)
  impact_criteria TEXT NOT NULL,         -- JSON ImpactCriterion[] (reviewer-defined)
  owner TEXT NOT NULL,
  reviewers TEXT NOT NULL,               -- JSON string[] actor ids
  known_gaps TEXT NOT NULL,              -- JSON string[]
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL,
  created_by TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS policy_versions (
  id TEXT PRIMARY KEY,                   -- e.g. POL-REFUND-3.0
  incident_id TEXT NOT NULL REFERENCES incidents(id),
  policy_key TEXT NOT NULL,
  version TEXT NOT NULL,
  role TEXT NOT NULL,                    -- authoritative | incorrect_used | introduced_after
  effective_from TEXT NOT NULL,          -- UTC ISO instant
  effective_to TEXT,                     -- UTC ISO instant (exclusive) or NULL
  text TEXT NOT NULL,
  params TEXT NOT NULL,                  -- JSON PolicyParams
  provisions TEXT NOT NULL,              -- JSON {code,text}[]
  batch_id TEXT,
  sha256 TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS import_batches (
  id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL REFERENCES incidents(id),
  kind TEXT NOT NULL,                    -- conversations | transactions | interactions | policy
  filename TEXT NOT NULL,
  format TEXT NOT NULL,                  -- csv | json | text
  sha256 TEXT NOT NULL,
  record_count INTEGER NOT NULL,
  flagged_count INTEGER NOT NULL DEFAULT 0,
  imported_by TEXT NOT NULL,
  imported_at TEXT NOT NULL,
  UNIQUE (incident_id, sha256)
);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL REFERENCES incidents(id),
  customer_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  started_at TEXT NOT NULL,
  app_version TEXT,                      -- NULL when not recorded
  order_id TEXT,
  batch_id TEXT NOT NULL REFERENCES import_batches(id),
  sha256 TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,                   -- CONV-ID#seq
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  seq INTEGER NOT NULL,
  role TEXT NOT NULL,                    -- customer | assistant | agent | system
  ts TEXT NOT NULL,
  text TEXT NOT NULL,                    -- stored verbatim; untrusted
  flags TEXT NOT NULL DEFAULT '[]'       -- JSON string[] e.g. instruction_like_text
);

CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL REFERENCES incidents(id),
  customer_id TEXT NOT NULL,
  order_id TEXT NOT NULL,
  type TEXT NOT NULL,                    -- purchase | refund_request | refund | refund_failed | refund_reversal
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL,
  ts TEXT NOT NULL,
  status TEXT NOT NULL,
  item_category TEXT,
  sale_item INTEGER,
  defective INTEGER,
  batch_id TEXT NOT NULL REFERENCES import_batches(id),
  sha256 TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS interactions (
  id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL REFERENCES incidents(id),
  customer_id TEXT NOT NULL,
  order_id TEXT,
  ts TEXT NOT NULL,
  channel TEXT NOT NULL,
  outcome TEXT NOT NULL,
  summary TEXT NOT NULL,                 -- untrusted
  flags TEXT NOT NULL DEFAULT '[]',
  batch_id TEXT NOT NULL REFERENCES import_batches(id),
  sha256 TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS analysis_runs (
  id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL REFERENCES incidents(id),
  analyzer_id TEXT NOT NULL,
  analyzer_version TEXT NOT NULL,
  is_live INTEGER NOT NULL,
  model TEXT,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  started_by TEXT NOT NULL,
  stats TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS findings (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES analysis_runs(id),
  incident_id TEXT NOT NULL REFERENCES incidents(id),
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  in_scope INTEGER NOT NULL,
  is_candidate INTEGER NOT NULL,
  scope_reasons TEXT NOT NULL,           -- JSON {kind, text}[]
  exposure TEXT NOT NULL,
  suggested_impact TEXT NOT NULL,
  explanation TEXT NOT NULL,
  provisions TEXT NOT NULL,              -- JSON {code, incorrect, applicable, policy_id}[]
  applicable_policy_id TEXT,
  supporting TEXT NOT NULL,              -- JSON {ref, note}[]
  gaps TEXT NOT NULL,                    -- JSON string[]
  conflicts TEXT NOT NULL,               -- JSON {text, refs}[]
  flags TEXT NOT NULL,                   -- JSON string[]
  facts TEXT NOT NULL                    -- JSON derived facts (days since purchase, etc.)
);

CREATE TABLE IF NOT EXISTS cases (
  id TEXT PRIMARY KEY,
  incident_id TEXT NOT NULL REFERENCES incidents(id),
  customer_id TEXT NOT NULL,
  order_id TEXT,
  status TEXT NOT NULL,
  exposure TEXT NOT NULL,                -- current (reviewer-confirmed or suggested)
  suggested_impact TEXT NOT NULL,        -- from latest analysis
  impact TEXT NOT NULL,                  -- reviewer determination; not_assessed until decided
  impact_criteria_met TEXT NOT NULL DEFAULT '[]',
  decided_by TEXT,
  decided_at TEXT,
  merged_into TEXT REFERENCES cases(id),
  primary_finding_id TEXT REFERENCES findings(id),
  possible_duplicate_of TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS case_conversations (
  case_id TEXT NOT NULL REFERENCES cases(id),
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  PRIMARY KEY (case_id, conversation_id)
);

CREATE TABLE IF NOT EXISTS review_decisions (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(id),
  actor TEXT NOT NULL,
  ts TEXT NOT NULL,
  kind TEXT NOT NULL,                    -- accept_suggestion | override | confirm_impact | reject_match | request_evidence | merge | note | evidence_received
  from_value TEXT,
  to_value TEXT,
  reason TEXT,
  evidence_refs TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS corrective_actions (
  id TEXT PRIMARY KEY,
  case_id TEXT NOT NULL REFERENCES cases(id),
  incident_id TEXT NOT NULL REFERENCES incidents(id),
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  summary TEXT NOT NULL,
  justification TEXT NOT NULL,
  proposed_amount_cents INTEGER,
  communication_draft TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  submitted_by TEXT,
  approved_by TEXT,
  approved_at TEXT,
  execution_mode TEXT,                   -- recorded | simulated
  executed_by TEXT,
  executed_at TEXT,
  execution_reference TEXT,
  execution_note TEXT,
  verified_by TEXT,
  verified_at TEXT,
  verification_evidence TEXT,            -- JSON {kind, ref, note}
  verified_amount_cents INTEGER,
  failure_reason TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  actor TEXT NOT NULL,
  actor_role TEXT NOT NULL,
  incident_id TEXT,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,
  prev_value TEXT,
  new_value TEXT,
  evidence_refs TEXT NOT NULL DEFAULT '[]',
  reason TEXT,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL
);

-- Application-level append-only guard. This blocks UPDATE/DELETE through SQL issued by
-- the application; it is NOT tamper-proof against anyone with direct file access.
CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;

CREATE INDEX IF NOT EXISTS idx_conv_incident ON conversations(incident_id, started_at);
CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_id, seq);
CREATE INDEX IF NOT EXISTS idx_txn_order ON transactions(order_id, ts);
CREATE INDEX IF NOT EXISTS idx_txn_customer ON transactions(customer_id);
CREATE INDEX IF NOT EXISTS idx_int_customer ON interactions(customer_id, ts);
CREATE INDEX IF NOT EXISTS idx_findings_run ON findings(run_id);
CREATE INDEX IF NOT EXISTS idx_cases_incident ON cases(incident_id, status);
CREATE INDEX IF NOT EXISTS idx_actions_case ON corrective_actions(case_id);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity_type, entity_id);
`;

export function openDb(file: string): DB {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.exec(SCHEMA);
  return db;
}

export function defaultDbPath(): string {
  return process.env.DR_DB_PATH ?? path.join(process.cwd(), "data", "decision-repair.db");
}

const globalForDb = globalThis as unknown as { __drDb?: DB };

/** Shared connection for the Next.js server process. */
export function getDb(): DB {
  if (!globalForDb.__drDb) globalForDb.__drDb = openDb(defaultDbPath());
  return globalForDb.__drDb;
}

export function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (value == null) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
