import { openDb, type DB } from "@/lib/db";
import { getActor } from "@/lib/actors";
import { createIncident } from "@/lib/incidents";
import { addPolicyVersion } from "@/lib/policy";
import { importEvidence } from "@/lib/importers";
import { POLICY_TEXTS } from "../scripts/dataset";

export const priya = getActor("priya.raman");
export const marcus = getActor("marcus.lee");
export const dana = getActor("dana.ortiz");
export const sam = getActor("sam.whitfield");
export const ellen = getActor("ellen.park");

export const INC = "INC-T-001";

/** Fresh in-memory database with a small incident (10 Jun 09:00 – 22 Jul 14:00 CDT) and four policy versions. */
export function freshIncident(): DB {
  const db = openDb(":memory:");
  createIncident(db, priya, {
    title: "Test incident: outdated refund policy",
    description: "Assistant cited superseded refund policy.",
    ai_system: "Test assistant",
    known_versions: ["v1"],
    start_local: "2026-06-10T09:00",
    end_local: "2026-07-22T14:00",
    timezone: "America/Chicago",
    incorrect_behavior: "Stated a 14-day refund window.",
    scope: { affected_versions: ["v1"], include_unknown_versions: true, topic_keywords: ["refund", "return"], excluded_customer_prefixes: ["TEST-"], exclude_without_assistant_messages: true },
    exclusions: ["Test accounts"],
    impact_criteria: ["Eligible under policy in force", "Assistant contradicted policy", "No later refund", "Evidence checked"],
    owner: priya.id,
    reviewers: [marcus.id, dana.id],
    known_gaps: [],
  }, INC);
  const P = {
    "2.3": ["incorrect_used", "2025-01-01", "2026-03-01", { window_days: 14, sale_refundable: false, proof: "receipt", defective_window_days: null }],
    "3.0": ["authoritative", "2026-03-01", "2026-07-01", { window_days: 30, sale_refundable: true, proof: "receipt_or_order", defective_window_days: null }],
    "3.1": ["authoritative", "2026-07-01", "2026-09-15", { window_days: 30, sale_refundable: true, proof: "receipt_or_order", defective_window_days: 60 }],
    "4.0": ["introduced_after", "2026-09-15", null, { window_days: 45, sale_refundable: true, proof: "receipt_or_order", defective_window_days: 90 }],
  } as const;
  for (const [v, [role, from, to, params]] of Object.entries(P)) {
    addPolicyVersion(db, priya, INC, { version: v, role, effective_from: from, effective_to: to, timezone: "America/Chicago", text: POLICY_TEXTS[v as keyof typeof POLICY_TEXTS], params });
  }
  return db;
}

let n = 0;
export interface ConvSpec {
  id?: string;
  customer?: string;
  order?: string;
  start: string; // ISO with offset
  version?: string | null;
  customerText?: string;
  assistantText?: string | null;
  daysSincePurchase?: number;
  amount?: number;
  sale?: boolean;
  defective?: boolean;
  laterRefundDays?: number;
}

/** Import one conversation plus its purchase (and optional later refund). Returns ids. */
export function addCase(db: DB, s: ConvSpec) {
  n++;
  const id = s.id ?? `CONV-T${n}`;
  const customer = s.customer ?? `SYN-T-${n}`;
  const order = s.order ?? `ORD-T${n}`;
  const t0 = Date.parse(s.start);
  const iso = (ms: number) => new Date(ms).toISOString();
  const messages = [{ seq: 1, role: "customer", timestamp: iso(t0), text: s.customerText ?? `I'd like a refund for ${order}.` }];
  if (s.assistantText !== null) messages.push({ seq: 2, role: "assistant", timestamp: iso(t0 + 60_000), text: s.assistantText ?? "Our refund policy allows returns within 14 days of purchase, so it is not eligible for a refund." });
  const conv = importEvidence(db, priya, INC, { kind: "conversations", format: "json", filename: `${id}.json`, content: JSON.stringify([{ conversation_id: id, customer_id: customer, app_version: s.version === undefined ? "v1" : s.version, order_id: order, messages }]) });
  if (!conv.ok) throw new Error(JSON.stringify(conv.issues));
  const days = s.daysSincePurchase ?? 20;
  const txns = [{ transaction_id: `TXN-P-${id}`, customer_id: customer, order_id: order, type: "purchase", amount: s.amount ?? 80, currency: "USD", timestamp: iso(t0 - days * 86_400_000 - 3_600_000), status: "settled", sale_item: s.sale ?? false, defective: s.defective ?? false }];
  if (s.laterRefundDays != null) txns.push({ transaction_id: `TXN-R-${id}`, customer_id: customer, order_id: order, type: "refund", amount: s.amount ?? 80, currency: "USD", timestamp: iso(t0 + s.laterRefundDays * 86_400_000), status: "completed", sale_item: false, defective: false });
  const t = importEvidence(db, priya, INC, { kind: "transactions", format: "json", filename: `${id}-txn.json`, content: JSON.stringify(txns) });
  if (!t.ok) throw new Error(JSON.stringify(t.issues));
  return { id, customer, order };
}

export function caseIdFor(db: DB, convId: string): string {
  return (db.prepare("SELECT case_id FROM case_conversations WHERE conversation_id = ?").get(convId) as { case_id: string }).case_id;
}

/** Import a ledger refund for an order at a given time. */
export function addLedgerRefund(db: DB, customer: string, order: string, atIso: string, amount = 80, type = "refund", status = "completed", id = `TXN-L-${++n}`) {
  const r = importEvidence(db, sam, INC, { kind: "transactions", format: "json", filename: `${id}.json`, content: JSON.stringify([{ transaction_id: id, customer_id: customer, order_id: order, type, amount, currency: "USD", timestamp: atIso, status }]) });
  if (!r.ok) throw new Error(JSON.stringify(r.issues));
  return id;
}
