import crypto from "node:crypto";
import type { DB } from "./db";
import { parseJson } from "./db";
import type { Actor, CaseStatus, Exposure, Impact } from "./types";
import { audit } from "./audit";
import { nowIso } from "./time";
import { DomainError, requirePermission } from "./actors";
import { getIncident } from "./incidents";
import { validateRefs } from "./evidence";
import type { ConversationRec, InteractionRec, MessageRec, TransactionRec } from "./analysis/provider";
import type { ScopeReason } from "./analysis/engine";

export interface CaseRow {
  id: string; incident_id: string; customer_id: string; order_id: string | null; status: CaseStatus;
  exposure: Exposure; suggested_impact: Impact; impact: Impact; impact_criteria_met: string;
  decided_by: string | null; decided_at: string | null; merged_into: string | null;
  primary_finding_id: string | null; possible_duplicate_of: string | null; created_at: string; updated_at: string;
}

export interface FindingRow {
  id: string; run_id: string; conversation_id: string; in_scope: number; is_candidate: number;
  scope_reasons: ScopeReason[]; exposure: Exposure; suggested_impact: Impact; explanation: string;
  provisions: { code: string; incorrect_statement: string; applicable_rule: string; policy_id: string | null }[];
  applicable_policy_id: string | null; supporting: { ref: string; note: string }[]; gaps: string[];
  conflicts: { text: string; refs: string[] }[]; flags: string[]; facts: Record<string, unknown>;
  analyzer_id: string; analyzer_version: string; is_live: number; model: string | null;
}

export interface DecisionRow { id: string; case_id: string; actor: string; ts: string; kind: string; from_value: string | null; to_value: string | null; reason: string | null; evidence_refs: string[] }

export function parseFinding(r: Record<string, unknown>): FindingRow {
  const j = (k: string, f: unknown) => parseJson(r[k] as string, f);
  return {
    ...(r as unknown as FindingRow),
    scope_reasons: j("scope_reasons", []) as ScopeReason[], provisions: j("provisions", []) as FindingRow["provisions"],
    supporting: j("supporting", []) as FindingRow["supporting"], gaps: j("gaps", []) as string[],
    conflicts: j("conflicts", []) as FindingRow["conflicts"], flags: j("flags", []) as string[], facts: j("facts", {}) as Record<string, unknown>,
  };
}

export function getFinding(db: DB, id: string): FindingRow | null {
  const r = db.prepare("SELECT f.*, a.analyzer_id, a.analyzer_version, a.is_live, a.model FROM findings f JOIN analysis_runs a ON a.id = f.run_id WHERE f.id = ?").get(id) as Record<string, unknown> | undefined;
  return r ? parseFinding(r) : null;
}

export function getCaseRow(db: DB, id: string): CaseRow | null {
  return (db.prepare("SELECT * FROM cases WHERE id = ?").get(id) as CaseRow | undefined) ?? null;
}

export interface CaseDetail {
  case: CaseRow;
  criteriaMet: string[];
  finding: FindingRow | null;
  conversations: (ConversationRec & { messages: MessageRec[]; finding: FindingRow | null })[];
  transactions: TransactionRec[];
  interactions: InteractionRec[];
  decisions: DecisionRow[];
  mergedFrom: string[];
}

export function getCaseDetail(db: DB, id: string): CaseDetail | null {
  const c = getCaseRow(db, id);
  if (!c) return null;
  const convIds = (db.prepare("SELECT conversation_id FROM case_conversations WHERE case_id = ?").all(id) as { conversation_id: string }[]).map((r) => r.conversation_id);
  const conversations = convIds.map((cid) => {
    const conv = db.prepare("SELECT * FROM conversations WHERE id = ?").get(cid) as ConversationRec;
    const messages = (db.prepare("SELECT * FROM messages WHERE conversation_id = ? ORDER BY seq").all(cid) as Record<string, unknown>[]).map((m) => ({ ...(m as unknown as MessageRec), flags: parseJson<string[]>(m.flags as string, []) }));
    const fr = db.prepare("SELECT f.*, a.analyzer_id, a.analyzer_version, a.is_live, a.model FROM findings f JOIN analysis_runs a ON a.id = f.run_id WHERE f.conversation_id = ? ORDER BY a.started_at DESC, a.rowid DESC LIMIT 1").get(cid) as Record<string, unknown> | undefined;
    return { ...conv, messages, finding: fr ? parseFinding(fr) : null };
  }).sort((a, b) => a.started_at.localeCompare(b.started_at));
  const transactions = db.prepare("SELECT * FROM transactions WHERE incident_id = ? AND customer_id = ? ORDER BY ts").all(c.incident_id, c.customer_id) as TransactionRec[];
  const interactions = (db.prepare("SELECT * FROM interactions WHERE incident_id = ? AND customer_id = ? ORDER BY ts").all(c.incident_id, c.customer_id) as Record<string, unknown>[]).map((i) => ({ ...(i as unknown as InteractionRec), flags: parseJson<string[]>(i.flags as string, []) }));
  const decisions = (db.prepare("SELECT * FROM review_decisions WHERE case_id = ? ORDER BY ts, rowid").all(id) as Record<string, unknown>[]).map((d) => ({ ...(d as unknown as DecisionRow), evidence_refs: parseJson<string[]>(d.evidence_refs as string, []) }));
  const mergedFrom = (db.prepare("SELECT id FROM cases WHERE merged_into = ?").all(id) as { id: string }[]).map((r) => r.id);
  return {
    case: c, criteriaMet: parseJson(c.impact_criteria_met, []),
    finding: c.primary_finding_id ? getFinding(db, c.primary_finding_id) : null,
    conversations, transactions, interactions, decisions, mergedFrom,
  };
}

export interface CaseListFilters { q?: string; status?: string; impact?: string; suggested?: string; exposure?: string; flag?: string; includeMerged?: boolean }

export interface CaseListRow extends CaseRow { conversation_ids: string; flags: string; action_statuses: string | null }

export function listCases(db: DB, incidentId: string, f: CaseListFilters = {}): CaseListRow[] {
  const where = ["c.incident_id = @incidentId"];
  const p: Record<string, unknown> = { incidentId };
  if (!f.includeMerged && f.status !== "merged") where.push("c.status != 'merged'");
  if (f.status) { where.push("c.status = @status"); p.status = f.status; }
  if (f.impact) { where.push("c.impact = @impact"); p.impact = f.impact; }
  if (f.suggested) { where.push("c.suggested_impact = @suggested"); p.suggested = f.suggested; }
  if (f.exposure) { where.push("c.exposure = @exposure"); p.exposure = f.exposure; }
  if (f.q) {
    where.push("(c.id LIKE @q OR c.customer_id LIKE @q OR c.order_id LIKE @q OR EXISTS (SELECT 1 FROM case_conversations x WHERE x.case_id = c.id AND x.conversation_id LIKE @q))");
    p.q = `%${f.q.trim()}%`;
  }
  const rows = db.prepare(`
    SELECT c.*,
      (SELECT group_concat(conversation_id, ',') FROM case_conversations WHERE case_id = c.id) AS conversation_ids,
      COALESCE((SELECT f.flags FROM findings f WHERE f.id = c.primary_finding_id), '[]') AS flags,
      (SELECT group_concat(status, ',') FROM corrective_actions WHERE case_id = c.id) AS action_statuses
    FROM cases c WHERE ${where.join(" AND ")} ORDER BY c.id`).all(p) as CaseListRow[];
  return rows.filter((r) => {
    if (!f.flag) return true;
    const flags = parseJson<string[]>(r.flags, []);
    if (f.flag === "duplicate") return Boolean(r.possible_duplicate_of);
    if (f.flag === "conflict" || f.flag === "gap") {
      const fd = r.primary_finding_id ? getFinding(db, r.primary_finding_id) : null;
      return f.flag === "conflict" ? (fd?.conflicts.length ?? 0) > 0 : (fd?.gaps.length ?? 0) > 0;
    }
    return flags.includes(f.flag);
  });
}

function record(db: DB, actor: Actor, c: CaseRow, kind: string, from: unknown, to: unknown, reason: string | null, refs: string[] = []) {
  const id = `DEC-${crypto.randomBytes(5).toString("hex")}`;
  db.prepare("INSERT INTO review_decisions (id, case_id, actor, ts, kind, from_value, to_value, reason, evidence_refs) VALUES (?,?,?,?,?,?,?,?,?)")
    .run(id, c.id, actor.id, nowIso(), kind, from == null ? null : JSON.stringify(from), to == null ? null : JSON.stringify(to), reason, JSON.stringify(refs));
  audit(db, { actor, incidentId: c.incident_id, entityType: "case", entityId: c.id, action: `review.${kind}`, prev: from, next: to, reason, evidenceRefs: refs });
}

function loadOpen(db: DB, actor: Actor, caseId: string): CaseRow {
  requirePermission(actor, "case.review");
  const c = getCaseRow(db, caseId);
  if (!c) throw new DomainError("Case not found.");
  if (c.status === "merged") throw new DomainError(`Case was merged into ${c.merged_into}; review that case instead.`);
  return c;
}

function setStatus(db: DB, c: CaseRow, status: CaseStatus) {
  db.prepare("UPDATE cases SET status = ?, updated_at = ? WHERE id = ?").run(status, nowIso(), c.id);
}

export function startReview(db: DB, actor: Actor, caseId: string) {
  const c = loadOpen(db, actor, caseId);
  if (c.status !== "unreviewed") return;
  db.transaction(() => {
    setStatus(db, c, "in_review");
    audit(db, { actor, incidentId: c.incident_id, entityType: "case", entityId: c.id, action: "case.status_changed", prev: { status: c.status }, next: { status: "in_review" } });
  })();
}

export interface DeterminationInput {
  exposure: Exposure;
  impact: Exclude<Impact, "not_assessed">;
  criteriaMet?: string[];
  reason?: string;
  evidenceRefs?: string[];
}

/**
 * Record the reviewer's classification. Any departure from the analyzer's suggestion is an
 * override and requires a reason. "Confirmed" requires every reviewer-defined criterion.
 */
export function recordDetermination(db: DB, actor: Actor, caseId: string, input: DeterminationInput) {
  const c = loadOpen(db, actor, caseId);
  if (c.status === "match_rejected") throw new DomainError("This match was rejected; reopen it before classifying.");
  const incident = getIncident(db, c.incident_id)!;
  const reason = input.reason?.trim() ?? "";
  const refs = input.evidenceRefs ?? [];
  if (refs.length) {
    const v = validateRefs(db, refs, { incidentId: c.incident_id, customerIds: [c.customer_id] });
    if (v.invalid.length) throw new DomainError(`Unsupported evidence references: ${v.invalid.map((i) => `${i.ref} (${i.reason})`).join("; ")}`);
  }
  let criteriaMet: string[] = [];
  if (input.impact === "confirmed") {
    if (input.exposure !== "exposed") throw new DomainError("Adverse impact can only be confirmed for a case where exposure to incorrect information is established.");
    criteriaMet = [...new Set(input.criteriaMet ?? [])];
    const missing = incident.impact_criteria.filter((k) => !criteriaMet.includes(k.id));
    if (missing.length) throw new DomainError(`Confirmation requires all reviewer-defined criteria. Not met: ${missing.map((m) => m.id).join(", ")}. Consider "Possible adverse impact" or "Insufficient evidence".`);
    if (reason.length < 10) throw new DomainError("Explain the confirmation (at least 10 characters).");
  }
  const isOverride = input.impact !== c.suggested_impact || input.exposure !== c.exposure;
  // Confirming a "possible" suggestion is a determination, not an override; any other change is.
  const kind = input.impact === "confirmed" ? "confirm_impact" : isOverride ? "override" : "accept_suggestion";
  if (kind === "override" && reason.length < 10) throw new DomainError("An override of the suggested classification requires a reason (at least 10 characters).");
  if (input.impact === "confirmed" && c.suggested_impact !== "possible" && reason.length < 10) throw new DomainError("Explain why impact is confirmed contrary to the suggestion.");

  db.transaction(() => {
    const prev = { exposure: c.exposure, impact: c.impact, suggested_impact: c.suggested_impact, status: c.status };
    db.prepare("UPDATE cases SET exposure = ?, impact = ?, impact_criteria_met = ?, decided_by = ?, decided_at = ?, status = 'reviewed', updated_at = ? WHERE id = ?")
      .run(input.exposure, input.impact, JSON.stringify(criteriaMet), actor.id, nowIso(), nowIso(), c.id);
    record(db, actor, c, kind, prev, { exposure: input.exposure, impact: input.impact, criteria_met: criteriaMet, status: "reviewed" }, reason || null, refs);
  })();
}

export function rejectMatch(db: DB, actor: Actor, caseId: string, reason: string) {
  const c = loadOpen(db, actor, caseId);
  if (reason.trim().length < 10) throw new DomainError("Rejecting a match requires a reason (at least 10 characters).");
  const active = db.prepare("SELECT COUNT(*) n FROM corrective_actions WHERE case_id = ? AND status NOT IN ('draft','rejected')").get(caseId) as { n: number };
  if (active.n) throw new DomainError("This case has corrective actions in progress; resolve or reject them first.");
  db.transaction(() => {
    setStatus(db, c, "match_rejected");
    record(db, actor, c, "reject_match", { status: c.status }, { status: "match_rejected" }, reason.trim());
  })();
}

export function reopenMatch(db: DB, actor: Actor, caseId: string, reason: string) {
  const c = loadOpen(db, actor, caseId);
  if (c.status !== "match_rejected") throw new DomainError("Only rejected matches can be reopened.");
  if (reason.trim().length < 10) throw new DomainError("Reopening requires a reason (at least 10 characters).");
  db.transaction(() => {
    setStatus(db, c, "in_review");
    record(db, actor, c, "reopen_match", { status: c.status }, { status: "in_review" }, reason.trim());
  })();
}

export function requestEvidence(db: DB, actor: Actor, caseId: string, what: string) {
  const c = loadOpen(db, actor, caseId);
  if (what.trim().length < 10) throw new DomainError("Describe the evidence needed (at least 10 characters).");
  db.transaction(() => {
    setStatus(db, c, "needs_evidence");
    record(db, actor, c, "request_evidence", { status: c.status }, { status: "needs_evidence" }, what.trim());
  })();
}

export function recordEvidenceReceived(db: DB, actor: Actor, caseId: string, refs: string[], note: string) {
  const c = loadOpen(db, actor, caseId);
  if (c.status !== "needs_evidence") throw new DomainError("Case is not awaiting evidence.");
  const v = validateRefs(db, refs, { incidentId: c.incident_id, customerIds: [c.customer_id] });
  if (!refs.length) throw new DomainError("Reference at least one imported evidence record (e.g. txn:…, int:…).");
  if (v.invalid.length) throw new DomainError(`Unsupported evidence references: ${v.invalid.map((i) => `${i.ref} (${i.reason})`).join("; ")}`);
  db.transaction(() => {
    setStatus(db, c, "in_review");
    record(db, actor, c, "evidence_received", { status: c.status }, { status: "in_review" }, note.trim() || null, refs);
  })();
}

export function addNote(db: DB, actor: Actor, caseId: string, note: string, refs: string[] = []) {
  const c = loadOpen(db, actor, caseId);
  if (note.trim().length < 3) throw new DomainError("Note is empty.");
  if (refs.length) {
    const v = validateRefs(db, refs, { incidentId: c.incident_id, customerIds: [c.customer_id] });
    if (v.invalid.length) throw new DomainError(`Unsupported evidence references: ${v.invalid.map((i) => `${i.ref} (${i.reason})`).join("; ")}`);
  }
  db.transaction(() => record(db, actor, c, "note", null, null, note.trim(), refs))();
}

/**
 * Merge a duplicate case into a target. Both must belong to the same customer. Conversations
 * move to the target; the source is kept (status "merged") so its history stays visible.
 */
export function mergeCases(db: DB, actor: Actor, sourceId: string, targetId: string, reason: string) {
  const src = loadOpen(db, actor, sourceId);
  const tgt = loadOpen(db, actor, targetId);
  if (src.id === tgt.id) throw new DomainError("Cannot merge a case into itself.");
  if (src.incident_id !== tgt.incident_id) throw new DomainError("Cases belong to different incidents.");
  if (src.customer_id !== tgt.customer_id) throw new DomainError("Only cases for the same customer can be merged.");
  if (tgt.status === "match_rejected") throw new DomainError("Target case is a rejected match.");
  if (reason.trim().length < 10) throw new DomainError("Merging requires a reason (at least 10 characters).");
  const srcActions = db.prepare("SELECT COUNT(*) n FROM corrective_actions WHERE case_id = ? AND status != 'rejected'").get(src.id) as { n: number };
  if (srcActions.n) throw new DomainError(`${src.id} has corrective actions; reject them or merge in the other direction.`);
  db.transaction(() => {
    const moved = (db.prepare("SELECT conversation_id FROM case_conversations WHERE case_id = ?").all(src.id) as { conversation_id: string }[]).map((r) => r.conversation_id);
    for (const cid of moved) {
      db.prepare("DELETE FROM case_conversations WHERE case_id = ? AND conversation_id = ?").run(src.id, cid);
      db.prepare("INSERT OR IGNORE INTO case_conversations (case_id, conversation_id) VALUES (?, ?)").run(tgt.id, cid);
    }
    db.prepare("UPDATE cases SET status = 'merged', merged_into = ?, updated_at = ? WHERE id = ?").run(tgt.id, nowIso(), src.id);
    db.prepare("UPDATE cases SET possible_duplicate_of = NULL, updated_at = ? WHERE id = ? AND possible_duplicate_of = ?").run(nowIso(), tgt.id, src.id);
    record(db, actor, src, "merge", { status: src.status }, { status: "merged", merged_into: tgt.id, conversations: moved }, reason.trim(), moved.map((m) => `conv:${m}`));
    record(db, actor, tgt, "merge", null, { absorbed: src.id, conversations: moved }, reason.trim(), moved.map((m) => `conv:${m}`));
  })();
}

export function closeCase(db: DB, actor: Actor, caseId: string, reason: string) {
  const c = loadOpen(db, actor, caseId);
  if (c.status !== "reviewed") throw new DomainError("Only reviewed cases can be closed.");
  const actions = db.prepare("SELECT type, status FROM corrective_actions WHERE case_id = ?").all(caseId) as { type: string; status: string }[];
  const settled = (a: { type: string; status: string }) => a.status === "verified_complete" || a.status === "rejected" || (a.type === "no_action" && a.status === "approved");
  if (!actions.some((a) => a.status !== "rejected")) throw new DomainError("Record at least one corrective action (or an approved 'No action' with justification) before closing.");
  const open = actions.filter((a) => !settled(a));
  if (open.length) throw new DomainError(`${open.length} corrective action(s) are not verified complete.`);
  db.transaction(() => {
    setStatus(db, c, "closed");
    record(db, actor, c, "close", { status: c.status }, { status: "closed" }, reason.trim() || null);
  })();
}
