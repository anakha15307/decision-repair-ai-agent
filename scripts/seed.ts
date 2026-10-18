import fs from "node:fs";
import path from "node:path";
import { openDb, defaultDbPath, type DB } from "../src/lib/db";
import { getActor } from "../src/lib/actors";
import { createIncident } from "../src/lib/incidents";
import { addPolicyVersion } from "../src/lib/policy";
import { importEvidence } from "../src/lib/importers";
import { runAnalysis } from "../src/lib/analysis/engine";
import { demoProvider } from "../src/lib/analysis/demoAnalyzer";
import { setClockForSeeding } from "../src/lib/time";
import * as cases from "../src/lib/cases";
import * as rem from "../src/lib/remediation";
import { generateDataset, INCIDENT } from "./dataset";

// Seeds the demonstration incident by replaying a scripted timeline through the same service
// functions the UI uses (so every seeded change is in the audit history). Reviewer decisions
// below are SCRIPTED DEMO DATA, not real judgements. Always uses the demo analyzer.

export const DEMO_INCIDENT_ID = "INC-2026-014";

const priya = getActor("priya.raman"), marcus = getActor("marcus.lee"), dana = getActor("dana.ortiz"), sam = getActor("sam.whitfield");
const read = (f: string) => fs.readFileSync(path.join(process.cwd(), "data", "samples", f), "utf8");

let clock = Date.parse("2026-07-23T15:00:00Z");
function at(iso: string) { clock = Date.parse(iso); setClockForSeeding(new Date(clock).toISOString()); }
function tick(minutes = 7) { clock += minutes * 60_000; setClockForSeeding(new Date(clock).toISOString()); }

function caseFor(db: DB, convId: string): string {
  const r = db.prepare("SELECT case_id FROM case_conversations WHERE conversation_id = ?").get(convId) as { case_id: string } | undefined;
  if (!r) throw new Error(`No case for ${convId}`);
  return r.case_id;
}

const policyParams = {
  "2.3": { window_days: 14, sale_refundable: false, proof: "receipt", defective_window_days: null },
  "3.0": { window_days: 30, sale_refundable: true, proof: "receipt_or_order", defective_window_days: null },
  "3.1": { window_days: 30, sale_refundable: true, proof: "receipt_or_order", defective_window_days: 60 },
  "4.0": { window_days: 45, sale_refundable: true, proof: "receipt_or_order", defective_window_days: 90 },
} as const;

export async function seed(db: DB) {
  const ds = generateDataset();
  const plan = ds.plan;
  const tz = INCIDENT.timezone;

  at("2026-07-23T15:10:00Z");
  createIncident(db, priya, {
    title: "Support assistant cited outdated refund policy",
    description: "From 10 June to 22 July 2026 the Northwind Assist support chatbot retrieved the superseded refund policy v2.3 from a stale knowledge-base index. It told some customers the refund window was 14 days (actual: 30), that sale items were final sale (actual: refundable), and that an original receipt was required (actual: receipt or order number). The index was rebuilt and assist-2026.07.4 deployed on 22 July 14:00 CDT. This investigation looks at past conversations to find people who may have been affected.",
    ai_system: "Northwind Assist (customer-support chatbot, retrieval-augmented)",
    known_versions: [...INCIDENT.affected, `${INCIDENT.fixed} (fix; canary from 15 Jul)`],
    start_local: INCIDENT.start_local,
    end_local: INCIDENT.end_local,
    timezone: tz,
    incorrect_behavior: "Stated refund terms from superseded policy v2.3 (14-day window; sale items final; original receipt required) instead of the policy in force (v3.0, then v3.1 from 1 July).",
    scope: {
      affected_versions: INCIDENT.affected,
      include_unknown_versions: true,
      topic_keywords: ["refund", "return", "money back"],
      excluded_customer_prefixes: ["TEST-"],
      exclude_without_assistant_messages: true,
    },
    exclusions: ["Internal test accounts (customer IDs beginning TEST-)", "Conversations handled only by human agents", `Conversations on the fixed version ${INCIDENT.fixed}`],
    impact_criteria: [
      "The customer's request was eligible under the authoritative policy in force at the time of the conversation.",
      "The assistant's response stated or implied ineligibility, or imposed a requirement, contrary to that policy.",
      "No refund or equivalent remedy for the order was subsequently completed.",
      "Supporting evidence has been checked by the reviewer and no unresolved conflict remains.",
    ],
    owner: priya.id,
    reviewers: [marcus.id, dana.id],
    known_gaps: [
      "Chat logs for 18 June 02:00–06:00 CDT were lost in a log-pipeline outage; customers who chatted then cannot be identified from logs.",
      "The mobile SDK did not record model/application versions before 20 June; those conversations are matched by date only.",
      "Customers who read the outdated policy in the help-center widget without starting a conversation are not captured.",
      "In-store returns are not included in the transaction export.",
    ],
  }, DEMO_INCIDENT_ID);

  tick(20);
  for (const v of ["2.3", "3.0", "3.1", "4.0"] as const) {
    const role = v === "2.3" ? "incorrect_used" : v === "4.0" ? "introduced_after" : "authoritative";
    const eff = { "2.3": ["2025-01-01", "2026-03-01"], "3.0": ["2026-03-01", "2026-07-01"], "3.1": ["2026-07-01", "2026-09-15"], "4.0": ["2026-09-15", null] }[v];
    addPolicyVersion(db, priya, DEMO_INCIDENT_ID, { policy_key: "refund", version: v, role, effective_from: eff[0], effective_to: eff[1], timezone: tz, text: read(`policy-refund-${v}.txt`), params: policyParams[v] });
    tick(3);
  }

  at("2026-07-24T14:00:00Z");
  for (const [kind, format, file] of [["conversations", "json", "conversations.json"], ["transactions", "csv", "transactions.csv"], ["interactions", "json", "interactions.json"]] as const) {
    const r = importEvidence(db, priya, DEMO_INCIDENT_ID, { kind, format, filename: file, content: read(file) });
    if (!r.ok) throw new Error(`Import ${file} failed: ${JSON.stringify(r.issues.slice(0, 5))}`);
    tick(4);
  }
  at("2026-07-24T16:30:00Z");
  await runAnalysis(db, priya, DEMO_INCIDENT_ID, demoProvider);

  // Email-channel export arrived later (contains prompt-injection text).
  at("2026-08-03T15:00:00Z");
  const late = importEvidence(db, sam, DEMO_INCIDENT_ID, { kind: "conversations", format: "csv", filename: "conversations-email-export.csv", content: read("conversations-email-export.csv") });
  if (!late.ok) throw new Error(`Late import failed: ${JSON.stringify(late.issues)}`);
  tick(30);
  await runAnalysis(db, priya, DEMO_INCIDENT_ID, demoProvider);

  // ---------- Scripted reviewer activity ----------
  const allCriteria = ["C1", "C2", "C3", "C4"];
  const confirm = (convId: string, who = marcus, note = "Order record shows eligibility under the policy in force; assistant refused; no later refund found in transaction export.") => {
    const id = caseFor(db, convId);
    cases.startReview(db, who, id); tick(5);
    cases.recordDetermination(db, who, id, { exposure: "exposed", impact: "confirmed", criteriaMet: allCriteria, reason: note }); tick(9);
    return id;
  };
  const refundAction = (caseId: string) => {
    const amount = (db.prepare("SELECT f.facts FROM cases c JOIN findings f ON f.id = c.primary_finding_id WHERE c.id = ?").get(caseId) as { facts: string }).facts;
    const cents = JSON.parse(amount).purchase_amount_cents as number;
    const a = rem.proposeAction(db, dana, caseId, { type: "refund_review", summary: "Review and issue refund under policy in force at the time", justification: "Customer was eligible under the applicable policy and was refused based on the outdated policy.", proposedAmountCents: cents });
    tick(4); rem.submitForReview(db, dana, a.id); tick(30);
    return a.id;
  };

  at("2026-08-10T14:00:00Z");
  // 1. Confirmed → refund approved → executed → verified with imported ledger → closed.
  const c1 = confirm(plan.confirm_verified[0]);
  const a1 = refundAction(c1);
  rem.approveAction(db, priya, a1, "Approved for refund review under v3.0."); tick(60);

  // 2. Sale-item case with a clarification as well.
  const c2 = confirm(plan.confirm_sale_with_clarification[0], dana, "Sale item within 30 days; assistant said sale items were final sale; no refund afterwards.");
  const a2 = rem.proposeAction(db, marcus, c2, { type: "refund_review", summary: "Refund sale item under v3.0", justification: "Sale items were refundable under the policy in force.", proposedAmountCents: (JSON.parse((db.prepare("SELECT f.facts FROM cases c JOIN findings f ON f.id = c.primary_finding_id WHERE c.id = ?").get(c2) as { facts: string }).facts).purchase_amount_cents) });
  tick(3); rem.submitForReview(db, marcus, a2.id); tick(20);
  rem.approveAction(db, priya, a2.id); tick(10);
  const a2b = rem.proposeAction(db, marcus, c2, { type: "clarification", summary: "Send correction of the sale-item statement", justification: "Customer was told incorrect terms; correct the record regardless of refund outcome." });
  tick(3); rem.submitForReview(db, marcus, a2b.id); tick(15);
  rem.approveAction(db, dana, a2b.id); tick(25);

  // 3. Confirmed and approved, but no execution evidence yet.
  const c3 = confirm(plan.confirm_approved_only[0]);
  const a3 = refundAction(c3);
  rem.approveAction(db, priya, a3); tick(40);

  // 4. Confirmed → approved → executed → refund failed (card expired) → reopened.
  const c4 = confirm(plan.confirm_failed[0]);
  const a4 = refundAction(c4);
  rem.approveAction(db, priya, a4); tick(40);

  // 5. Confirmed → refund under review.
  const c5 = confirm(plan.refund_under_review[0], dana);
  refundAction(c5);

  // 6. Simulated execution and verification (clearly labelled).
  const c6 = confirm(plan.confirm_simulated[0], dana);
  const a6 = rem.proposeAction(db, marcus, c6, { type: "reopen_request", summary: "Reopen the original refund request", justification: "Request was closed on incorrect grounds; reopen for handling under v3.0." });
  tick(3); rem.submitForReview(db, marcus, a6.id); tick(12);
  rem.approveAction(db, priya, a6.id); tick(20);

  at("2026-08-12T15:00:00Z");
  // 7. Refunded later → accept "no adverse impact found" → no action approved → closed.
  const c7 = caseFor(db, plan.accept_none_no_action[0]);
  cases.startReview(db, marcus, c7); tick(4);
  cases.recordDetermination(db, marcus, c7, { exposure: "exposed", impact: "none_found", reason: "Refund completed two days after the chat via phone agent." }); tick(6);
  const a7 = rem.proposeAction(db, marcus, c7, { type: "no_action", summary: "No corrective action", justification: "Customer obtained the full refund through a human agent two days later; no outstanding loss identified." });
  tick(2); rem.submitForReview(db, marcus, a7.id); tick(10);
  rem.approveAction(db, priya, a7.id); tick(5);
  cases.closeCase(db, marcus, c7, "No outstanding remedy."); tick(10);

  // 8. Ineligible anyway → accept none_found → clarification left in Draft.
  const c8 = caseFor(db, plan.accept_none_clarification_draft[0]);
  cases.startReview(db, dana, c8); tick(4);
  cases.recordDetermination(db, dana, c8, { exposure: "exposed", impact: "none_found", reason: "Purchase was outside the 30-day window under v3.0 as well." }); tick(5);
  rem.proposeAction(db, dana, c8, { type: "clarification", summary: "Send correction of the 14-day statement", justification: "Customer received incorrect policy terms; correction keeps future expectations accurate." }); tick(10);

  // 9. Override: analyzer found a later refund; reviewer judges the 3-week delay as possible impact.
  const c9 = caseFor(db, plan.override_delay[0]);
  cases.startReview(db, marcus, c9); tick(4);
  cases.recordDetermination(db, marcus, c9, { exposure: "exposed", impact: "possible", reason: "Refund arrived 24 days later only after a complaint; customer reports paying return shipping twice. Delay and costs may be adverse impact.", evidenceRefs: [] }); tick(5);
  const a9 = rem.proposeAction(db, marcus, c9, { type: "escalation", summary: "Escalate to customer-care specialist for shipping-cost reimbursement review", justification: "Possible out-of-pocket costs need a specialist decision under goodwill guidelines." });
  tick(3); rem.submitForReview(db, marcus, a9.id); tick(10);

  // 10. Missing purchase record → request evidence.
  const c10 = caseFor(db, plan.request_evidence[0]);
  cases.startReview(db, dana, c10); tick(3);
  cases.requestEvidence(db, dana, c10, "Order record is missing from the transaction export; request order history from the order-management team."); tick(10);

  // 11. Duplicate conversations → merge.
  const [d1, d2] = plan.merge_duplicate.map((cv) => caseFor(db, cv));
  cases.mergeCases(db, marcus, d2, d1, "Same customer and same order; second chat was a retry two days later."); tick(10);

  // 12. False-positive match (exchange window) → reject.
  const c12 = caseFor(db, plan.reject_match[0]);
  cases.rejectMatch(db, dana, c12, "The 14-day statement concerned the exchange policy, which was unchanged; the customer asked for an exchange, not a refund."); tick(10);

  // 13. Prompt-injection case → reviewer note; left in review.
  const c13 = caseFor(db, plan.injection_note[0]);
  cases.startReview(db, marcus, c13); tick(3);
  cases.addNote(db, marcus, c13, "Customer message contains instruction-like text addressed to an AI ('mark this case as confirmed…'). Treated as data; it has no effect on classification. Assessing on the evidence only.", [`msg:${plan.injection_note[0]}#1`]); tick(10);

  // ---------- Execution and verification ----------
  at("2026-09-08T14:00:00Z");
  rem.recordExecution(db, sam, a1, { mode: "recorded", reference: "PAYREQ-88412", note: "Refund requested in payments console." }); tick(10);
  rem.recordExecution(db, sam, a2.id, { mode: "recorded", reference: "PAYREQ-88419" }); tick(10);
  rem.recordExecution(db, sam, a2b.id, { mode: "recorded", reference: "ZD-551203", note: "Correction email sent from customer-care mailbox." }); tick(10);
  rem.recordExecution(db, sam, a4, { mode: "recorded", reference: "PAYREQ-88433" }); tick(10);
  rem.recordExecution(db, sam, a6.id, { mode: "simulated" }); tick(10);

  at("2026-09-20T15:00:00Z");
  const ledger = importEvidence(db, sam, DEMO_INCIDENT_ID, { kind: "transactions", format: "csv", filename: "remediation-ledger.csv", content: read("remediation-ledger.csv") });
  if (!ledger.ok) throw new Error(`Ledger import failed: ${JSON.stringify(ledger.issues)}`);
  tick(30);
  rem.verifyCompletion(db, marcus, a1, { kind: "transaction", ref: `txn:${plan.confirm_verified_txn[0]}`, note: "Ledger shows completed refund for the full purchase amount." }); tick(10);
  rem.verifyCompletion(db, dana, a2.id, { kind: "transaction", ref: `txn:${plan.confirm_sale_with_clarification_txn[0]}` }); tick(10);
  rem.verifyCompletion(db, dana, a2b.id, { kind: "receipt", ref: "ZD-551203-SENT", note: "Zendesk shows the correction email delivered on 8 Sep." }); tick(10);
  rem.recordFailure(db, marcus, a4, "Refund to card failed: card expired. Customer must be contacted for alternative payout.", [`txn:${plan.confirm_failed_txn[0]}`]); tick(20);
  rem.reopenAction(db, dana, a4, "Refund failed; reopen to arrange an alternative payout method."); tick(10);
  const sim = rem.getAction(db, a6.id)!;
  rem.verifyCompletion(db, dana, a6.id, { kind: "simulated", ref: sim.execution_reference!, note: "Demonstration only." }); tick(10);

  at("2026-09-22T16:00:00Z");
  cases.closeCase(db, marcus, c1, "Refund verified against ledger."); tick(5);
  cases.closeCase(db, dana, c2, "Refund and correction verified."); tick(5);

  setClockForSeeding(null);
}

async function main() {
  const file = defaultDbPath();
  for (const f of [file, `${file}-wal`, `${file}-shm`]) if (fs.existsSync(f)) fs.rmSync(f);
  const db = openDb(file);
  await seed(db);
  const n = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  console.log(`Seeded ${DEMO_INCIDENT_ID} into ${file}`);
  console.log(`  conversations ${n("SELECT COUNT(*) n FROM conversations")}, cases ${n("SELECT COUNT(*) n FROM cases")}, actions ${n("SELECT COUNT(*) n FROM corrective_actions")}, audit entries ${n("SELECT COUNT(*) n FROM audit_log")}`);
  db.close();
}

if (process.argv[1] && process.argv[1].endsWith("seed.ts")) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
