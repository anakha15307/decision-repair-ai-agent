import type { AnalysisProvider, CaseContext, FindingDraft, ProvisionFinding, TransactionRec } from "./provider";
import { DAY_MS } from "../time";

// Deterministic, rules-based analyzer used when no live model is configured.
// It is not a model: it applies transparent pattern and date rules, and its output is
// labelled "Demo analyzer (rules-based)" everywhere it appears.

export const DEMO_ANALYZER_VERSION = "demo-rules-1.3.0";

const WINDOW_CLAIM = /\b(\d{1,3})[- ]day(?:s)?\b[^.]{0,60}\b(refund|return|window)|\b(refund|return)[^.]{0,60}\b(\d{1,3})[- ]?days?\b/i;
const SALE_FINAL = /\bfinal[- ]sale\b|\bsale items? (?:are|is) (?:not|non)[- ]?refundable\b|\bcan(?:no|')t refund (?:sale|discounted)/i;
const SALE_OK = /\bsale items? (?:are|is) (?:also )?(?:refundable|eligible)/i;
const RECEIPT_REQUIRED = /\boriginal receipt (?:is )?(?:required|needed)|\bneed (?:the|your) original receipt|\bwithout (?:a|the|your) (?:original )?receipt\b[^.]{0,40}\b(?:can(?:no|')t|unable|not able)/i;
const RECEIPT_OK = /\b(?:order number|order id)\b[^.]{0,40}\b(?:is enough|works|is fine|suffices|accepted)/i;
const DENIAL = /\b(not eligible|isn'?t eligible|no longer eligible|ineligible|unable to (?:process|offer|approve)|can(?:no|')t (?:offer|process|approve|issue)|outside (?:the|our)[^.]{0,30}window|past the[^.]{0,20}window|won'?t be able to)\b/i;
const CUSTOMER_STATED_DAYS = /\b(?:bought|purchased|ordered|got) (?:it|this|them)?\s*(?:about |around )?(\d{1,3}) days ago\b/i;
const ORDER_RE = /\bORD-\d{4,8}\b/;

function money(cents: number, cur = "USD") {
  return `${(cents / 100).toFixed(2)} ${cur}`;
}

function windowClaim(text: string): number | null {
  const m = WINDOW_CLAIM.exec(text);
  if (!m) return null;
  return Number(m[1] ?? m[4]);
}

export function demoAssess(ctx: CaseContext): FindingDraft {
  const { conversation: conv, messages, applicable, incorrect } = ctx;
  const supporting: FindingDraft["supporting"] = [];
  const gaps: string[] = [];
  const conflicts: FindingDraft["conflicts"] = [];
  const provisions: ProvisionFinding[] = [];
  const facts: Record<string, unknown> = {};
  const assistant = messages.filter((m) => m.role === "assistant");

  if (!applicable) {
    gaps.push("No authoritative policy is registered for the date of this conversation.");
  }
  if (conv.app_version == null) gaps.push("Model/application version was not recorded for this conversation; matched by date only.");

  // 1. What did the assistant state, compared with the policy in force at the time?
  let incorrectStatements = 0;
  let correctStatements = 0;
  for (const m of assistant) {
    const ref = `msg:${m.id}`;
    const claimed = windowClaim(m.text);
    if (claimed != null && applicable) {
      if (claimed !== applicable.params.window_days && !(applicable.params.defective_window_days === claimed)) {
        incorrectStatements++;
        provisions.push({
          code: "RW",
          incorrect_statement: `Stated a ${claimed}-day refund window.`,
          applicable_rule: `${applicable.version}: ${applicable.params.window_days}-day window${applicable.params.defective_window_days ? `; ${applicable.params.defective_window_days} days for defective items` : ""}.`,
          policy_id: applicable.id,
        });
        supporting.push({ ref, note: `Assistant stated a ${claimed}-day window${incorrect && incorrect.params.window_days === claimed ? ` (matches outdated ${incorrect.version})` : ""}.` });
      } else {
        correctStatements++;
        supporting.push({ ref, note: `Assistant stated a ${claimed}-day window, consistent with ${applicable.version}.` });
      }
    }
    if (applicable && SALE_FINAL.test(m.text) && applicable.params.sale_refundable) {
      incorrectStatements++;
      provisions.push({ code: "SALE", incorrect_statement: "Stated sale items are final sale / non-refundable.", applicable_rule: `${applicable.version}: sale items are refundable within the standard window.`, policy_id: applicable.id });
      supporting.push({ ref, note: "Assistant stated sale items are not refundable." });
    } else if (applicable && SALE_OK.test(m.text)) {
      correctStatements++;
      supporting.push({ ref, note: "Assistant correctly stated sale items are refundable." });
    }
    if (applicable && RECEIPT_REQUIRED.test(m.text) && applicable.params.proof === "receipt_or_order") {
      incorrectStatements++;
      provisions.push({ code: "PROOF", incorrect_statement: "Stated an original receipt is required.", applicable_rule: `${applicable.version}: receipt or order number is accepted as proof of purchase.`, policy_id: applicable.id });
      supporting.push({ ref, note: "Assistant required an original receipt." });
    } else if (applicable && RECEIPT_OK.test(m.text)) {
      correctStatements++;
      supporting.push({ ref, note: "Assistant correctly accepted an order number as proof." });
    }
  }
  const denialMsg = assistant.find((m) => DENIAL.test(m.text));
  facts.assistant_denied_or_discouraged = Boolean(denialMsg);
  if (denialMsg && !supporting.some((s) => s.ref === `msg:${denialMsg.id}`)) {
    supporting.push({ ref: `msg:${denialMsg.id}`, note: "Assistant indicated the request could not proceed." });
  }

  const exposure: FindingDraft["exposure"] = incorrectStatements > 0 ? "exposed" : correctStatements > 0 ? "not_exposed" : "undetermined";
  if (exposure === "undetermined") gaps.push("The assistant did not state a checkable refund-policy term in this conversation.");
  if (exposure === "not_exposed" && supporting.length === 0) supporting.push({ ref: `conv:${conv.id}`, note: "Conversation reviewed." });
  if (exposure === "undetermined") supporting.push({ ref: `conv:${conv.id}`, note: "Refund-related conversation without a checkable policy statement." });

  // 2. Link to the order and outcome evidence.
  const orderId = conv.order_id ?? messages.map((m) => ORDER_RE.exec(m.text)?.[0]).find(Boolean) ?? null;
  facts.order_id = orderId;
  if (!orderId) gaps.push("No order reference found in conversation metadata or text.");
  const orderTx = (t: TransactionRec) => orderId != null && t.order_id === orderId;
  const purchases = ctx.transactions.filter((t) => orderTx(t) && t.type === "purchase");
  const purchase = purchases[0];
  const convStart = Date.parse(conv.started_at);

  if (orderId && !purchase) gaps.push(`No purchase record found for ${orderId}.`);
  if (purchases.length > 1) conflicts.push({ text: `Multiple purchase records exist for ${orderId}.`, refs: purchases.map((p) => `txn:${p.id}`) });

  let eligible: boolean | null = null;
  if (purchase) {
    supporting.push({ ref: `txn:${purchase.id}`, note: `Purchase ${money(purchase.amount_cents, purchase.currency)} on order ${purchase.order_id}.` });
    const days = Math.floor((convStart - Date.parse(purchase.ts)) / DAY_MS);
    facts.days_since_purchase = days;
    facts.purchase_amount_cents = purchase.amount_cents;
    facts.currency = purchase.currency;
    facts.sale_item = purchase.sale_item == null ? null : Boolean(purchase.sale_item);
    facts.defective = purchase.defective == null ? null : Boolean(purchase.defective);

    const stated = messages.filter((m) => m.role === "customer").map((m) => ({ m, d: CUSTOMER_STATED_DAYS.exec(m.text) })).find((x) => x.d);
    if (stated && Math.abs(Number(stated.d![1]) - days) > 3) {
      conflicts.push({
        text: `Customer said the purchase was ${stated.d![1]} days earlier; the order record shows ${days} days.`,
        refs: [`msg:${stated.m.id}`, `txn:${purchase.id}`],
      });
    }

    if (applicable) {
      const p = applicable.params;
      const unknowns: string[] = [];
      if (purchase.sale_item == null) unknowns.push("sale status");
      if (purchase.defective == null && p.defective_window_days) unknowns.push("defect status");
      const saleBlocks = purchase.sale_item === 1 && !p.sale_refundable;
      const withinStd = days <= p.window_days;
      const withinDef = p.defective_window_days != null && purchase.defective === 1 && days <= p.defective_window_days;
      if (saleBlocks) eligible = false;
      else if (withinStd || withinDef) eligible = true;
      else if (unknowns.includes("defect status") && p.defective_window_days != null && days <= p.defective_window_days) eligible = null;
      else eligible = false;
      if (unknowns.length && eligible !== false) gaps.push(`Order record does not state ${unknowns.join(" or ")}.`);
      if (eligible === null && !unknowns.length) eligible = false;
      facts.eligible_under_applicable = eligible;
      facts.applicable_basis = withinDef && !withinStd ? `defective-item window (${p.defective_window_days} days)` : `standard window (${p.window_days} days)`;
    }
    if (incorrect) {
      const q = incorrect.params;
      facts.eligible_under_incorrect = !(days > q.window_days || (purchase.sale_item === 1 && !q.sale_refundable));
    }
  }

  // 3. What happened afterwards?
  const after = (ts: string) => Date.parse(ts) >= convStart;
  const later = ctx.transactions.filter((t) => orderTx(t) && after(t.ts) && t.type !== "purchase");
  const refunds = later.filter((t) => t.type === "refund" && /complete|settled|issued/i.test(t.status));
  const reversals = later.filter((t) => t.type === "refund_reversal");
  const failedRefunds = later.filter((t) => t.type === "refund_failed");
  const requests = later.filter((t) => t.type === "refund_request");
  for (const t of later) supporting.push({ ref: `txn:${t.id}`, note: `Later ${t.type.replace("_", " ")}: ${money(t.amount_cents, t.currency)}, status ${t.status}.` });
  const laterInts = ctx.interactions.filter((i) => after(i.ts) && (orderId == null || i.order_id == null || i.order_id === orderId));
  for (const i of laterInts) supporting.push({ ref: `int:${i.id}`, note: `Later ${i.channel} contact: ${i.outcome}.` });

  const refunded = refunds.reduce((s, t) => s + t.amount_cents, 0) - reversals.reduce((s, t) => s + t.amount_cents, 0);
  facts.later_refund_cents = refunded;
  facts.later_refund_request = requests.length > 0;
  if (reversals.length && refunds.length) conflicts.push({ text: "A refund was recorded and later reversed.", refs: [...refunds, ...reversals].map((t) => `txn:${t.id}`) });
  const notReceived = laterInts.filter((i) => /not[_ ]received|never received|missing refund/i.test(i.outcome + " " + i.summary));
  if (refunds.length && notReceived.length) {
    conflicts.push({ text: "Transaction log shows a completed refund, but a later contact reports it was not received.", refs: [...refunds.map((t) => `txn:${t.id}`), ...notReceived.map((i) => `int:${i.id}`)] });
  }
  if (failedRefunds.length) gaps.push("A later refund attempt failed; final outcome is not recorded.");

  // 4. Suggested impact. Never "confirmed": confirmation is a reviewer decision.
  let impact: FindingDraft["suggested_impact"];
  const reasons: string[] = [];
  const purchaseAmt = purchase?.amount_cents ?? 0;
  if (exposure !== "exposed") {
    impact = exposure === "undetermined" ? "insufficient_evidence" : "not_assessed";
  } else if (!purchase || !applicable) {
    impact = "insufficient_evidence";
    reasons.push("Order or policy evidence needed to assess eligibility is missing.");
  } else if (conflicts.length) {
    impact = "insufficient_evidence";
    reasons.push("Evidence conflicts and must be resolved by a reviewer.");
  } else if (eligible === null) {
    impact = "insufficient_evidence";
    reasons.push("Eligibility under the applicable policy depends on information that is not recorded.");
  } else if (eligible === false) {
    impact = "none_found";
    reasons.push(`Under ${applicable.version} the request was outside policy as well, so the incorrect statement does not appear to have changed eligibility.`);
  } else if (refunded >= purchaseAmt && purchaseAmt > 0) {
    impact = "none_found";
    reasons.push(`A refund of ${money(refunded)} was later completed for this order. Any delay is not assessed by this analyzer.`);
  } else if (facts.eligible_under_incorrect === true && !denialMsg) {
    impact = "none_found";
    reasons.push("The request was within both the outdated and the applicable terms, and the assistant did not refuse it.");
  } else {
    impact = "possible";
    reasons.push(
      `Under ${applicable.version} the order appears eligible (${facts.applicable_basis}, day ${facts.days_since_purchase}), ` +
        `the assistant ${denialMsg ? "indicated the request could not proceed" : "gave incorrect terms"}, and no completed refund for this order is recorded afterwards.`,
    );
    if (refunded > 0) reasons.push(`A partial refund of ${money(refunded)} was recorded.`);
  }

  const lead =
    exposure === "exposed"
      ? `The assistant gave ${provisions.length} statement(s) that differ from the policy in force at the time (${applicable?.version ?? "unknown"}): ${provisions.map((p) => p.code).join(", ")}.`
      : exposure === "not_exposed"
        ? `The assistant's policy statements are consistent with ${applicable?.version ?? "the applicable policy"}.`
        : "No checkable policy statement was found.";
  const explanation = [lead, ...reasons, "Exposure to incorrect information does not by itself establish adverse impact; a changed outcome under the corrected policy does not by itself establish causation or entitlement."].join(" ");

  return { exposure, suggested_impact: impact, explanation, provisions, supporting: dedupe(supporting), gaps, conflicts, facts };
}

function dedupe(items: { ref: string; note: string }[]) {
  const seen = new Map<string, { ref: string; note: string }>();
  for (const i of items) if (!seen.has(i.ref)) seen.set(i.ref, i);
  return [...seen.values()];
}

export const demoProvider: AnalysisProvider = {
  id: "demo-rules",
  version: DEMO_ANALYZER_VERSION,
  isLive: false,
  model: null,
  label: "Demo analyzer (rules-based, not a live model)",
  async assess(ctx) {
    return demoAssess(ctx);
  },
};
