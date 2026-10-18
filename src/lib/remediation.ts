import crypto from "node:crypto";
import type { DB } from "./db";
import { parseJson } from "./db";
import type { ActionStatus, ActionType, Actor } from "./types";
import { ACTION_STATUS_LABELS, ACTION_TYPE_LABELS } from "./types";
import { audit } from "./audit";
import { nowIso } from "./time";
import { DomainError, requirePermission } from "./actors";
import { getCaseRow, getFinding } from "./cases";
import { resolveRef, validateRefs } from "./evidence";

// Corrective-action lifecycle:
//   Draft → Under review → Approved → Execution recorded → Verified complete
//   plus Needs evidence, Rejected, Failed, Reopened.
// Approval never counts as execution; execution never counts as verified completion.
// This application never sends messages, issues refunds or changes customer records:
// "execution" is a record that staff did the work elsewhere (or a labelled simulation).

export interface ActionRow {
  id: string; case_id: string; incident_id: string; type: ActionType; status: ActionStatus;
  summary: string; justification: string; proposed_amount_cents: number | null; communication_draft: string | null;
  created_by: string; created_at: string; submitted_by: string | null; approved_by: string | null; approved_at: string | null;
  execution_mode: "recorded" | "simulated" | null; executed_by: string | null; executed_at: string | null;
  execution_reference: string | null; execution_note: string | null;
  verified_by: string | null; verified_at: string | null; verification_evidence: string | null; verified_amount_cents: number | null;
  failure_reason: string | null; updated_at: string;
}

type Transition = "submit" | "approve" | "reject" | "request_evidence" | "record_execution" | "record_failure" | "verify" | "reopen";

export const TRANSITIONS: Record<Transition, { from: ActionStatus[]; to: ActionStatus }> = {
  submit: { from: ["draft", "needs_evidence", "reopened"], to: "under_review" },
  approve: { from: ["under_review"], to: "approved" },
  reject: { from: ["under_review"], to: "rejected" },
  request_evidence: { from: ["under_review"], to: "needs_evidence" },
  record_execution: { from: ["approved"], to: "execution_recorded" },
  record_failure: { from: ["approved", "execution_recorded"], to: "failed" },
  verify: { from: ["execution_recorded"], to: "verified_complete" },
  reopen: { from: ["failed", "verified_complete"], to: "reopened" },
};

export function allowedTransitions(a: Pick<ActionRow, "status" | "type">): Transition[] {
  return (Object.keys(TRANSITIONS) as Transition[]).filter((t) => {
    if (!TRANSITIONS[t].from.includes(a.status)) return false;
    if (a.type === "no_action" && ["record_execution", "record_failure", "verify"].includes(t)) return false;
    return true;
  });
}

function assertTransition(a: ActionRow, t: Transition) {
  if (!allowedTransitions(a).includes(t)) {
    throw new DomainError(`Cannot ${t.replace("_", " ")} an action that is "${ACTION_STATUS_LABELS[a.status]}"${a.type === "no_action" ? " (no-action determinations have no execution step)" : ""}.`);
  }
}

export function getAction(db: DB, id: string): ActionRow | null {
  return (db.prepare("SELECT * FROM corrective_actions WHERE id = ?").get(id) as ActionRow | undefined) ?? null;
}

export function listActions(db: DB, filter: { incidentId?: string; caseId?: string; status?: string; type?: string } = {}): ActionRow[] {
  const where: string[] = [];
  const p: Record<string, unknown> = {};
  if (filter.incidentId) { where.push("incident_id = @incidentId"); p.incidentId = filter.incidentId; }
  if (filter.caseId) { where.push("case_id = @caseId"); p.caseId = filter.caseId; }
  if (filter.status) { where.push("status = @status"); p.status = filter.status; }
  if (filter.type) { where.push("type = @type"); p.type = filter.type; }
  return db.prepare(`SELECT * FROM corrective_actions ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY created_at, id`).all(p) as ActionRow[];
}

function update(db: DB, actor: Actor, a: ActionRow, patch: Partial<ActionRow>, action: string, reason: string | null, refs: string[] = []) {
  const now = nowIso();
  const full = { ...patch, updated_at: now };
  const sets = Object.keys(full).map((k) => `${k} = @${k}`).join(", ");
  db.prepare(`UPDATE corrective_actions SET ${sets} WHERE id = @id`).run({ ...full, id: a.id });
  const prev = Object.fromEntries(Object.keys(patch).map((k) => [k, (a as unknown as Record<string, unknown>)[k]]));
  audit(db, { actor, incidentId: a.incident_id, entityType: "corrective_action", entityId: a.id, action, prev, next: patch, reason, evidenceRefs: refs });
}

// ---------- Communication drafts (never sent) ----------

export function draftCommunication(type: ActionType, ctx: { caseId: string; orderId: string | null; amountCents?: number | null; provisionCodes: string[] }): string {
  const order = ctx.orderId ?? "your recent order";
  const amount = ctx.amountCents != null ? `$${(ctx.amountCents / 100).toFixed(2)}` : "the eligible amount";
  const what = ctx.provisionCodes.includes("SALE")
    ? "that sale items could not be refunded"
    : ctx.provisionCodes.includes("PROOF")
      ? "that an original receipt was required"
      : "that our refund window was 14 days";
  const header = `[DRAFT — NOT SENT. Decision Repair never sends messages. Staff must review, edit and send through approved channels.]\nReference: ${ctx.caseId}\n\n`;
  const opening = `Hello,\n\nWhen you contacted Northwind Outfitters support about ${order}, our automated assistant told you ${what}. That information was out of date. Our policy at the time allowed refunds within 30 days of purchase, including sale items, with either a receipt or an order number.\n\n`;
  const bodies: Record<ActionType, string> = {
    clarification: "We are sorry for the confusion. If you would still like to return or get a refund for this order, reply to this message and a member of our team will help.\n",
    reopen_request: `We have reopened your request for ${order}. A member of our team will review it under the policy that applied when you contacted us, and will follow up with you.\n`,
    refund_review: `We are reviewing a refund of ${amount} for ${order} under the policy that applied at the time. We will confirm the outcome once the review is complete. This message is not a confirmation that a refund has been issued.\n`,
    escalation: "Your case has been referred to a specialist who will contact you directly.\n",
    no_action: "(No customer communication is proposed for a no-action determination.)\n",
  };
  return header + opening + bodies[type] + "\nKind regards,\nNorthwind Outfitters Customer Care";
}

// ---------- Commands ----------

export interface ProposeInput {
  type: ActionType;
  summary: string;
  justification: string;
  proposedAmountCents?: number | null;
  communicationDraft?: string | null;
}

export function proposeAction(db: DB, actor: Actor, caseId: string, input: ProposeInput): ActionRow {
  requirePermission(actor, "action.propose");
  const c = getCaseRow(db, caseId);
  if (!c) throw new DomainError("Case not found.");
  if (!["in_review", "reviewed", "needs_evidence"].includes(c.status)) throw new DomainError(`Cannot propose an action on a case that is ${c.status.replace("_", " ")}.`);
  if (!(input.type in ACTION_TYPE_LABELS)) throw new DomainError("Unknown action type.");
  if (input.summary.trim().length < 5) throw new DomainError("Summary is required.");
  const minJust = input.type === "no_action" ? 20 : 10;
  if (input.justification.trim().length < minJust) throw new DomainError(`Justification must be at least ${minJust} characters${input.type === "no_action" ? " for a no-action determination" : ""}.`);
  if (input.type === "refund_review") {
    if (input.proposedAmountCents == null || input.proposedAmountCents <= 0) throw new DomainError("Refund review requires a proposed amount.");
  } else if (input.proposedAmountCents) throw new DomainError("Only refund reviews carry an amount.");
  const finding = c.primary_finding_id ? getFinding(db, c.primary_finding_id) : null;
  const id = `ACT-${crypto.randomBytes(4).toString("hex").toUpperCase()}`;
  const now = nowIso();
  const draft = input.communicationDraft?.trim() || (input.type === "no_action" ? null : draftCommunication(input.type, { caseId, orderId: c.order_id, amountCents: input.proposedAmountCents, provisionCodes: finding?.provisions.map((p) => p.code) ?? [] }));
  db.transaction(() => {
    db.prepare(`INSERT INTO corrective_actions (id, case_id, incident_id, type, status, summary, justification, proposed_amount_cents, communication_draft, created_by, created_at, updated_at)
      VALUES (?,?,?,?, 'draft', ?,?,?,?,?,?,?)`).run(id, caseId, c.incident_id, input.type, input.summary.trim(), input.justification.trim(), input.proposedAmountCents ?? null, draft, actor.id, now, now);
    audit(db, { actor, incidentId: c.incident_id, entityType: "corrective_action", entityId: id, action: "action.proposed", next: { case_id: caseId, type: input.type, status: "draft", proposed_amount_cents: input.proposedAmountCents ?? null } });
  })();
  return getAction(db, id)!;
}

export function editDraft(db: DB, actor: Actor, actionId: string, patch: { summary?: string; justification?: string; proposedAmountCents?: number | null; communicationDraft?: string }) {
  requirePermission(actor, "action.propose");
  const a = mustGet(db, actionId);
  if (!["draft", "needs_evidence", "reopened"].includes(a.status)) throw new DomainError("Only draft, needs-evidence or reopened actions can be edited. Approved actions are fixed.");
  const p: Partial<ActionRow> = {};
  if (patch.summary !== undefined) p.summary = patch.summary.trim();
  if (patch.justification !== undefined) p.justification = patch.justification.trim();
  if (patch.communicationDraft !== undefined) p.communication_draft = patch.communicationDraft;
  if (patch.proposedAmountCents !== undefined && a.type === "refund_review") {
    if (patch.proposedAmountCents == null || patch.proposedAmountCents <= 0) throw new DomainError("Refund review requires a positive amount.");
    p.proposed_amount_cents = patch.proposedAmountCents;
  }
  db.transaction(() => update(db, actor, a, p, "action.edited", null))();
}

function mustGet(db: DB, id: string): ActionRow {
  const a = getAction(db, id);
  if (!a) throw new DomainError("Corrective action not found.");
  return a;
}

export function submitForReview(db: DB, actor: Actor, actionId: string) {
  requirePermission(actor, "action.propose");
  const a = mustGet(db, actionId);
  assertTransition(a, "submit");
  db.transaction(() => update(db, actor, a, { status: "under_review", submitted_by: actor.id }, "action.submitted", null))();
}

export function approveAction(db: DB, actor: Actor, actionId: string, note = "") {
  requirePermission(actor, "action.approve");
  const a = mustGet(db, actionId);
  assertTransition(a, "approve");
  if (a.created_by === actor.id) throw new DomainError("Separation of duties: the person who drafted an action cannot approve it.");
  const c = getCaseRow(db, a.case_id)!;
  if (c.status !== "reviewed" && c.status !== "closed") throw new DomainError("The case needs a recorded reviewer determination before actions can be approved.");
  if (a.type === "refund_review" && !["confirmed", "possible"].includes(c.impact)) {
    throw new DomainError("A refund review can be approved only when the reviewer's determination is confirmed or possible adverse impact.");
  }
  db.transaction(() => update(db, actor, a, { status: "approved", approved_by: actor.id, approved_at: nowIso() }, "action.approved", note.trim() || null))();
}

export function rejectAction(db: DB, actor: Actor, actionId: string, reason: string) {
  requirePermission(actor, "action.approve");
  const a = mustGet(db, actionId);
  assertTransition(a, "reject");
  if (reason.trim().length < 10) throw new DomainError("Rejection requires a reason (at least 10 characters).");
  db.transaction(() => update(db, actor, a, { status: "rejected" }, "action.rejected", reason.trim()))();
}

export function requestActionEvidence(db: DB, actor: Actor, actionId: string, reason: string) {
  requirePermission(actor, "action.approve");
  const a = mustGet(db, actionId);
  assertTransition(a, "request_evidence");
  if (reason.trim().length < 10) throw new DomainError("Describe what evidence is needed (at least 10 characters).");
  db.transaction(() => update(db, actor, a, { status: "needs_evidence" }, "action.evidence_requested", reason.trim()))();
}

export interface ExecutionInput {
  mode: "recorded" | "simulated";
  reference?: string;
  note?: string;
}

/** Record that staff carried out the approved action outside this tool, or simulate it (labelled). */
export function recordExecution(db: DB, actor: Actor, actionId: string, input: ExecutionInput) {
  requirePermission(actor, "action.execute");
  const a = mustGet(db, actionId);
  assertTransition(a, "record_execution");
  let reference = input.reference?.trim() ?? "";
  if (input.mode === "recorded" && reference.length < 4) throw new DomainError("Record the external system reference for the work performed (ticket, case or payment request ID).");
  if (input.mode === "simulated") reference = `SIMULATED-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
  db.transaction(() => update(db, actor, a, {
    status: "execution_recorded", execution_mode: input.mode, executed_by: actor.id, executed_at: nowIso(),
    execution_reference: reference, execution_note: input.note?.trim() || (input.mode === "simulated" ? "Simulated execution for demonstration. No real action was taken." : null),
  }, input.mode === "simulated" ? "action.execution_simulated" : "action.execution_recorded", null))();
}

export function recordFailure(db: DB, actor: Actor, actionId: string, reason: string, refs: string[] = []) {
  const a = mustGet(db, actionId);
  if (!(actor.role === "ops_lead" || actor.role === "governance_lead" || actor.role === "case_reviewer")) throw new DomainError("Not permitted to record failure.");
  requirePermission(actor, actor.role === "ops_lead" ? "action.execute" : "action.verify");
  assertTransition(a, "record_failure");
  if (reason.trim().length < 10) throw new DomainError("Describe the failure (at least 10 characters).");
  if (refs.length) {
    const c = getCaseRow(db, a.case_id)!;
    const v = validateRefs(db, refs, { incidentId: a.incident_id, customerIds: [c.customer_id] });
    if (v.invalid.length) throw new DomainError(`Unsupported evidence references: ${v.invalid.map((i) => `${i.ref} (${i.reason})`).join("; ")}`);
  }
  db.transaction(() => update(db, actor, a, { status: "failed", failure_reason: reason.trim() }, "action.failed", reason.trim(), refs))();
}

export interface VerificationInput {
  kind: "transaction" | "interaction" | "receipt" | "simulated";
  /** txn:/int: reference for imported evidence, or an external receipt/document ID for "receipt". */
  ref: string;
  note?: string;
}

export interface VerificationEvidence { kind: VerificationInput["kind"]; ref: string; note: string | null; label: string; amount_cents: number | null }

/** Verify completion. Requires completion evidence; the verifier must not be the person who executed. */
export function verifyCompletion(db: DB, actor: Actor, actionId: string, input: VerificationInput) {
  requirePermission(actor, "action.verify");
  const a = mustGet(db, actionId);
  assertTransition(a, "verify");
  if (a.executed_by === actor.id) throw new DomainError("Separation of duties: the person who recorded execution cannot verify it.");
  const c = getCaseRow(db, a.case_id)!;
  const ref = input.ref?.trim() ?? "";
  let evidence: VerificationEvidence;

  if (a.execution_mode === "simulated") {
    if (input.kind !== "simulated" || ref !== a.execution_reference) throw new DomainError(`This execution was simulated; verify only against its simulated reference ${a.execution_reference}. It will be reported separately from real completions.`);
    evidence = { kind: "simulated", ref, note: input.note?.trim() || null, label: "Simulated receipt (demonstration only)", amount_cents: a.type === "refund_review" ? a.proposed_amount_cents : null };
  } else if (input.kind === "simulated") {
    throw new DomainError("A recorded execution cannot be verified with simulated evidence.");
  } else if (input.kind === "transaction" || input.kind === "interaction") {
    const prefix = input.kind === "transaction" ? "txn:" : "int:";
    if (!ref.startsWith(prefix)) throw new DomainError(`Reference must start with ${prefix}`);
    const v = validateRefs(db, [ref], { incidentId: a.incident_id, customerIds: [c.customer_id] });
    if (v.invalid.length) throw new DomainError(`Completion evidence not accepted: ${v.invalid[0].reason}.`);
    let amount: number | null = null;
    if (input.kind === "transaction") {
      const t = db.prepare("SELECT * FROM transactions WHERE id = ?").get(ref.slice(4)) as { type: string; status: string; amount_cents: number; ts: string; order_id: string };
      if (a.type === "refund_review") {
        if (t.type !== "refund" || !/complete|settled|issued/i.test(t.status)) throw new DomainError("Refund verification requires a completed refund transaction.");
        if (a.approved_at && Date.parse(t.ts) < Date.parse(a.approved_at)) throw new DomainError("The referenced refund predates approval of this action, so it cannot evidence this action's completion.");
        if (c.order_id && t.order_id !== c.order_id) throw new DomainError(`Refund is for order ${t.order_id}, not the case order ${c.order_id}.`);
      }
      amount = t.type === "refund" ? t.amount_cents : null;
    } else if (a.type === "refund_review") {
      throw new DomainError("Refund verification requires a transaction reference, not an interaction.");
    }
    evidence = { kind: input.kind, ref, note: input.note?.trim() || null, label: resolveRef(db, ref)?.label ?? ref, amount_cents: amount };
  } else {
    if (a.type === "refund_review") throw new DomainError("Refund verification requires an imported refund transaction (txn:…).");
    if (ref.length < 6) throw new DomainError("Provide the receipt, message ID or document reference that evidences completion.");
    if ((input.note?.trim().length ?? 0) < 10) throw new DomainError("Describe what the receipt shows (at least 10 characters).");
    evidence = { kind: "receipt", ref, note: input.note!.trim(), label: `External receipt ${ref}`, amount_cents: null };
  }

  db.transaction(() => update(db, actor, a, {
    status: "verified_complete", verified_by: actor.id, verified_at: nowIso(),
    verification_evidence: JSON.stringify(evidence), verified_amount_cents: evidence.kind === "simulated" ? null : evidence.amount_cents,
  }, "action.verified", input.note?.trim() || null, evidence.kind === "transaction" || evidence.kind === "interaction" ? [ref] : []))();
}

export function reopenAction(db: DB, actor: Actor, actionId: string, reason: string) {
  requirePermission(actor, "action.propose");
  const a = mustGet(db, actionId);
  assertTransition(a, "reopen");
  if (reason.trim().length < 10) throw new DomainError("Reopening requires a reason (at least 10 characters).");
  db.transaction(() => {
    // Execution/verification fields are kept in the audit history; clear them on the live record so
    // the reopened action must be approved, executed and verified again.
    update(db, actor, a, {
      status: "reopened", approved_by: null, approved_at: null, execution_mode: null, executed_by: null, executed_at: null,
      execution_reference: null, execution_note: null, verified_by: null, verified_at: null, verification_evidence: null, verified_amount_cents: null,
    }, "action.reopened", reason.trim());
    const c = getCaseRow(db, a.case_id)!;
    if (c.status === "closed") {
      db.prepare("UPDATE cases SET status = 'reviewed', updated_at = ? WHERE id = ?").run(nowIso(), c.id);
      audit(db, { actor, incidentId: c.incident_id, entityType: "case", entityId: c.id, action: "case.status_changed", prev: { status: "closed" }, next: { status: "reviewed" }, reason: `Action ${a.id} reopened` });
    }
  })();
}

export function parseVerification(a: ActionRow): VerificationEvidence | null {
  return parseJson<VerificationEvidence | null>(a.verification_evidence, null);
}
