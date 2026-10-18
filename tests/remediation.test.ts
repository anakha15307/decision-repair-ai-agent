import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DB } from "@/lib/db";
import { runAnalysis } from "@/lib/analysis/engine";
import { demoProvider } from "@/lib/analysis/demoAnalyzer";
import { recordDetermination, startReview, closeCase, getCaseRow } from "@/lib/cases";
import * as rem from "@/lib/remediation";
import { setClockForSeeding } from "@/lib/time";
import { addCase, addLedgerRefund, caseIdFor, dana, ellen, freshIncident, INC, marcus, priya, sam } from "./helpers";

let db: DB;
let caseId: string;
let customer: string;
let order: string;

const at = (iso: string) => setClockForSeeding(iso);

beforeEach(async () => {
  at("2026-08-01T15:00:00Z");
  db = freshIncident();
  const c = addCase(db, { start: "2026-06-20T10:00:00-05:00", daysSincePurchase: 20, amount: 80 });
  customer = c.customer; order = c.order;
  await runAnalysis(db, priya, INC, demoProvider);
  caseId = caseIdFor(db, c.id);
});
afterEach(() => setClockForSeeding(null));

function confirmCase() {
  startReview(db, marcus, caseId);
  recordDetermination(db, marcus, caseId, { exposure: "exposed", impact: "confirmed", criteriaMet: ["C1", "C2", "C3", "C4"], reason: "Eligible at day 20; refused; no later refund." });
}

function approvedRefund() {
  confirmCase();
  const a = rem.proposeAction(db, dana, caseId, { type: "refund_review", summary: "Refund under v3.0", justification: "Eligible and refused.", proposedAmountCents: 8000 });
  rem.submitForReview(db, dana, a.id);
  at("2026-08-05T15:00:00Z");
  rem.approveAction(db, priya, a.id);
  return a.id;
}

describe("human determinations", () => {
  it("requires every reviewer-defined criterion to confirm impact, and a reason to override", () => {
    startReview(db, marcus, caseId);
    expect(() => recordDetermination(db, marcus, caseId, { exposure: "exposed", impact: "confirmed", criteriaMet: ["C1", "C2"], reason: "Looks affected to me." })).toThrow(/Not met: C3, C4/);
    expect(() => recordDetermination(db, marcus, caseId, { exposure: "exposed", impact: "none_found" })).toThrow(/override .* requires a reason/);
    recordDetermination(db, marcus, caseId, { exposure: "exposed", impact: "none_found", reason: "Customer confirmed by phone they kept the item happily." });
    const d = db.prepare("SELECT kind, reason FROM review_decisions WHERE case_id = ?").all(caseId) as { kind: string; reason: string }[];
    expect(d.at(-1)).toEqual({ kind: "override", reason: "Customer confirmed by phone they kept the item happily." });
    const audit = db.prepare("SELECT reason FROM audit_log WHERE action = 'review.override'").get() as { reason: string };
    expect(audit.reason).toMatch(/kept the item/);
  });

  it("does not allow confirming impact without established exposure", () => {
    startReview(db, marcus, caseId);
    expect(() => recordDetermination(db, marcus, caseId, { exposure: "undetermined", impact: "confirmed", criteriaMet: ["C1", "C2", "C3", "C4"], reason: "Confirmed though exposure is unclear." })).toThrow(/exposure/);
  });
});

describe("approval and execution boundaries", () => {
  it("keeps approval, execution and verification as distinct states", () => {
    const id = approvedRefund();
    const a = rem.getAction(db, id)!;
    expect(a.status).toBe("approved");
    expect(a.executed_at).toBeNull();
    expect(a.verified_at).toBeNull();
    rem.recordExecution(db, sam, id, { mode: "recorded", reference: "PAYREQ-1" });
    const b = rem.getAction(db, id)!;
    expect(b.status).toBe("execution_recorded");
    expect(b.verified_at).toBeNull();
  });

  it("refuses execution before approval and approval by the drafter", () => {
    confirmCase();
    const a = rem.proposeAction(db, dana, caseId, { type: "refund_review", summary: "Refund", justification: "Eligible and refused.", proposedAmountCents: 8000 });
    expect(() => rem.recordExecution(db, sam, a.id, { mode: "recorded", reference: "PAYREQ-1" })).toThrow(/Cannot record execution an action that is "Draft"/);
    rem.submitForReview(db, dana, a.id);
    expect(() => rem.recordExecution(db, sam, a.id, { mode: "recorded", reference: "PAYREQ-1" })).toThrow(/Under review/);
    expect(() => rem.approveAction(db, dana, a.id)).toThrow(/Separation of duties/);
    expect(() => rem.approveAction(db, sam, a.id)).toThrow(/not permitted/); // ops lead cannot approve
    expect(() => rem.approveAction(db, ellen, a.id)).toThrow(/not permitted/); // auditor is read-only
    rem.approveAction(db, marcus, a.id);
    expect(() => rem.recordExecution(db, marcus, a.id, { mode: "recorded", reference: "PAYREQ-1" })).toThrow(/not permitted/); // reviewers do not execute
    expect(() => rem.recordExecution(db, sam, a.id, { mode: "recorded", reference: "" })).toThrow(/external system reference/);
  });

  it("refuses refund approval before a reviewer determination of confirmed or possible impact", () => {
    startReview(db, marcus, caseId);
    const a = rem.proposeAction(db, dana, caseId, { type: "refund_review", summary: "Refund", justification: "Eligible and refused.", proposedAmountCents: 8000 });
    rem.submitForReview(db, dana, a.id);
    expect(() => rem.approveAction(db, priya, a.id)).toThrow(/reviewer determination/);
    recordDetermination(db, marcus, caseId, { exposure: "exposed", impact: "none_found", reason: "Customer was refunded in store (not in export)." });
    expect(() => rem.approveAction(db, priya, a.id)).toThrow(/confirmed or possible/);
  });

  it("gives no-action determinations no execution step and requires justification", () => {
    confirmCase();
    expect(() => rem.proposeAction(db, dana, caseId, { type: "no_action", summary: "No action", justification: "n/a" })).toThrow(/at least 20/);
    const a = rem.proposeAction(db, dana, caseId, { type: "no_action", summary: "No action", justification: "Customer already obtained a full refund in store." });
    rem.submitForReview(db, dana, a.id);
    rem.approveAction(db, priya, a.id);
    expect(rem.allowedTransitions(rem.getAction(db, a.id)!)).toEqual([]);
    expect(() => rem.recordExecution(db, sam, a.id, { mode: "simulated" })).toThrow(/no execution step/);
  });

  it("freezes approved actions against editing", () => {
    const id = approvedRefund();
    expect(() => rem.editDraft(db, dana, id, { proposedAmountCents: 999999 })).toThrow(/Approved actions are fixed/);
  });
});

describe("completion verification", () => {
  it("requires completion evidence; execution alone is not completion", () => {
    const id = approvedRefund();
    rem.recordExecution(db, sam, id, { mode: "recorded", reference: "PAYREQ-1" });
    expect(() => rem.verifyCompletion(db, marcus, id, { kind: "receipt", ref: "EMAIL-123456", note: "Customer says thanks a lot." })).toThrow(/requires an imported refund transaction/);
    expect(() => rem.verifyCompletion(db, marcus, id, { kind: "transaction", ref: "txn:DOES-NOT-EXIST" })).toThrow(/no such record/);
    expect(rem.getAction(db, id)!.status).toBe("execution_recorded");
  });

  it("refuses the executor verifying their own work", () => {
    const id = approvedRefund();
    rem.recordExecution(db, sam, id, { mode: "recorded", reference: "PAYREQ-1" });
    const txn = addLedgerRefund(db, customer, order, "2026-08-10T15:00:00Z");
    expect(() => rem.verifyCompletion(db, sam, id, { kind: "transaction", ref: `txn:${txn}` })).toThrow(/Separation of duties/);
  });

  it("only accepts a completed refund for the case order, dated after approval", () => {
    const id = approvedRefund(); // approved 2026-08-05
    rem.recordExecution(db, sam, id, { mode: "recorded", reference: "PAYREQ-1" });
    const early = addLedgerRefund(db, customer, order, "2026-08-01T10:00:00Z");
    const other = addLedgerRefund(db, customer, "ORD-OTHER", "2026-08-10T10:00:00Z");
    const failed = addLedgerRefund(db, customer, order, "2026-08-10T10:00:00Z", 80, "refund_failed", "declined");
    const someoneElse = addLedgerRefund(db, "SYN-STRANGER", order, "2026-08-10T10:00:00Z");
    expect(() => rem.verifyCompletion(db, marcus, id, { kind: "transaction", ref: `txn:${early}` })).toThrow(/predates approval/);
    expect(() => rem.verifyCompletion(db, marcus, id, { kind: "transaction", ref: `txn:${other}` })).toThrow(/not the case order/);
    expect(() => rem.verifyCompletion(db, marcus, id, { kind: "transaction", ref: `txn:${failed}` })).toThrow(/completed refund/);
    expect(() => rem.verifyCompletion(db, marcus, id, { kind: "transaction", ref: `txn:${someoneElse}` })).toThrow(/different customer/);
    const good = addLedgerRefund(db, customer, order, "2026-08-12T10:00:00Z", 80);
    at("2026-08-13T10:00:00Z");
    rem.verifyCompletion(db, marcus, id, { kind: "transaction", ref: `txn:${good}`, note: "Ledger shows refund." });
    const a = rem.getAction(db, id)!;
    expect(a.status).toBe("verified_complete");
    expect(a.verified_amount_cents).toBe(8000);
    expect(rem.parseVerification(a)?.ref).toBe(`txn:${good}`);
  });

  it("keeps simulated execution separate: verifiable only with its simulated reference and never with real evidence", () => {
    const id = approvedRefund();
    rem.recordExecution(db, sam, id, { mode: "simulated" });
    const a = rem.getAction(db, id)!;
    expect(a.execution_reference).toMatch(/^SIMULATED-/);
    const txn = addLedgerRefund(db, customer, order, "2026-08-10T15:00:00Z");
    expect(() => rem.verifyCompletion(db, marcus, id, { kind: "transaction", ref: `txn:${txn}` })).toThrow(/simulated/);
    rem.verifyCompletion(db, marcus, id, { kind: "simulated", ref: a.execution_reference! });
    const v = rem.getAction(db, id)!;
    expect(v.status).toBe("verified_complete");
    expect(v.verified_amount_cents).toBeNull();
  });

  it("supports failure → reopen, clearing execution so the action must be re-approved and re-verified", () => {
    const id = approvedRefund();
    rem.recordExecution(db, sam, id, { mode: "recorded", reference: "PAYREQ-1" });
    const failed = addLedgerRefund(db, customer, order, "2026-08-10T10:00:00Z", 80, "refund_failed", "declined_card_expired");
    rem.recordFailure(db, marcus, id, "Card expired; refund bounced.", [`txn:${failed}`]);
    expect(rem.getAction(db, id)!.status).toBe("failed");
    rem.reopenAction(db, dana, id, "Arrange alternative payout.");
    const r = rem.getAction(db, id)!;
    expect(r.status).toBe("reopened");
    expect([r.approved_by, r.executed_by, r.execution_reference, r.verified_at]).toEqual([null, null, null, null]);
    expect(() => rem.recordExecution(db, sam, id, { mode: "recorded", reference: "PAYREQ-2" })).toThrow(/Reopened/);
    const hist = db.prepare("SELECT action FROM audit_log WHERE entity_id = ? ORDER BY seq").all(id).map((x) => (x as { action: string }).action);
    expect(hist).toEqual(["action.proposed", "action.submitted", "action.approved", "action.execution_recorded", "action.failed", "action.reopened"]);
  });

  it("refuses to close a case until its actions are verified complete", () => {
    const id = approvedRefund();
    expect(() => closeCase(db, marcus, caseId, "done")).toThrow(/not verified complete/);
    rem.recordExecution(db, sam, id, { mode: "recorded", reference: "PAYREQ-1" });
    expect(() => closeCase(db, marcus, caseId, "done")).toThrow(/not verified complete/);
    const good = addLedgerRefund(db, customer, order, "2026-08-12T10:00:00Z");
    rem.verifyCompletion(db, marcus, id, { kind: "transaction", ref: `txn:${good}` });
    closeCase(db, marcus, caseId, "Refund verified.");
    expect(getCaseRow(db, caseId)!.status).toBe("closed");
  });
});
