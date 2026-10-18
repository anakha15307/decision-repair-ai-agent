import crypto from "node:crypto";
import type { DB } from "./db";
import type { Actor } from "./types";
import { nowIso } from "./time";

export interface AuditInput {
  actor: Actor;
  incidentId?: string | null;
  entityType: string;
  entityId: string;
  action: string;
  prev?: unknown;
  next?: unknown;
  evidenceRefs?: string[];
  reason?: string | null;
}

export interface AuditRow {
  seq: number;
  ts: string;
  actor: string;
  actor_role: string;
  incident_id: string | null;
  entity_type: string;
  entity_id: string;
  action: string;
  prev_value: string | null;
  new_value: string | null;
  evidence_refs: string;
  reason: string | null;
  prev_hash: string;
  hash: string;
}

function rowDigest(r: Omit<AuditRow, "seq" | "hash">): string {
  const material = JSON.stringify([
    r.ts, r.actor, r.actor_role, r.incident_id, r.entity_type, r.entity_id,
    r.action, r.prev_value, r.new_value, r.evidence_refs, r.reason, r.prev_hash,
  ]);
  return crypto.createHash("sha256").update(material).digest("hex");
}

const enc = (v: unknown) => (v === undefined ? null : JSON.stringify(v));

/** Append one entry to the application audit history. Never updates or deletes. */
export function audit(db: DB, e: AuditInput): void {
  const last = db.prepare("SELECT hash FROM audit_log ORDER BY seq DESC LIMIT 1").get() as { hash: string } | undefined;
  const row = {
    ts: nowIso(),
    actor: e.actor.id,
    actor_role: e.actor.role,
    incident_id: e.incidentId ?? null,
    entity_type: e.entityType,
    entity_id: e.entityId,
    action: e.action,
    prev_value: enc(e.prev),
    new_value: enc(e.next),
    evidence_refs: JSON.stringify(e.evidenceRefs ?? []),
    reason: e.reason ?? null,
    prev_hash: last?.hash ?? "GENESIS",
  };
  const hash = rowDigest(row);
  db.prepare(
    `INSERT INTO audit_log (ts, actor, actor_role, incident_id, entity_type, entity_id, action, prev_value, new_value, evidence_refs, reason, prev_hash, hash)
     VALUES (@ts, @actor, @actor_role, @incident_id, @entity_type, @entity_id, @action, @prev_value, @new_value, @evidence_refs, @reason, @prev_hash, @hash)`,
  ).run({ ...row, hash });
}

/**
 * Recompute the hash chain. Detects accidental or casual edits to stored rows.
 * It cannot detect a full rewrite by someone with file access, so it is a consistency
 * check, not proof that the history is untampered.
 */
export function checkAuditChain(db: DB): { ok: boolean; checked: number; firstBreak: number | null } {
  const rows = db.prepare("SELECT * FROM audit_log ORDER BY seq").all() as AuditRow[];
  let prev = "GENESIS";
  for (const r of rows) {
    const { seq, hash, ...rest } = r;
    if (r.prev_hash !== prev || rowDigest(rest) !== hash) return { ok: false, checked: rows.length, firstBreak: seq };
    prev = hash;
  }
  return { ok: true, checked: rows.length, firstBreak: null };
}

export function listAudit(
  db: DB,
  opts: { incidentId?: string; entityType?: string; entityId?: string; limit?: number } = {},
): AuditRow[] {
  const where: string[] = [];
  const params: Record<string, unknown> = {};
  if (opts.incidentId) { where.push("incident_id = @incidentId"); params.incidentId = opts.incidentId; }
  if (opts.entityType) { where.push("entity_type = @entityType"); params.entityType = opts.entityType; }
  if (opts.entityId) { where.push("entity_id = @entityId"); params.entityId = opts.entityId; }
  const sql = `SELECT * FROM audit_log ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY seq DESC LIMIT ${opts.limit ?? 500}`;
  return db.prepare(sql).all(params) as AuditRow[];
}
