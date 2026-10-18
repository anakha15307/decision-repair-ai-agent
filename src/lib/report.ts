import type { DB } from "./db";
import { parseJson } from "./db";
import { getIncident } from "./incidents";
import { listPolicies } from "./policy";
import { computeDashboard } from "./metrics";
import { listCases, getFinding } from "./cases";
import { listActions, parseVerification } from "./remediation";
import { listBatches } from "./importers";
import { listRuns } from "./analysis/engine";
import { checkAuditChain } from "./audit";
import { toCsv } from "./csv";
import { formatInZone, nowIso } from "./time";
import { actorName } from "./actors";
import { ACTION_STATUS_LABELS, ACTION_TYPE_LABELS, CASE_STATUS_LABELS, EXPOSURE_LABELS, IMPACT_LABELS, type Exposure, type Impact } from "./types";

const usd = (c: number | null | undefined) => (c == null ? "" : `$${(c / 100).toFixed(2)}`);

export function caseListCsv(db: DB, incidentId: string): string {
  const cases = listCases(db, incidentId, { includeMerged: true });
  const actions = listActions(db, { incidentId });
  const rows = cases.map((c) => {
    const f = c.primary_finding_id ? getFinding(db, c.primary_finding_id) : null;
    const acts = actions.filter((a) => a.case_id === c.id);
    return {
      case_id: c.id,
      customer_id: c.customer_id,
      order_id: c.order_id ?? "",
      conversations: c.conversation_ids ?? "",
      workflow_status: CASE_STATUS_LABELS[c.status],
      exposure: EXPOSURE_LABELS[c.exposure],
      suggested_impact: IMPACT_LABELS[c.suggested_impact],
      reviewer_impact: IMPACT_LABELS[c.impact],
      criteria_met: parseJson<string[]>(c.impact_criteria_met, []).join(" "),
      decided_by: actorName(c.decided_by),
      merged_into: c.merged_into ?? "",
      possible_duplicate_of: c.possible_duplicate_of ?? "",
      provisions: f?.provisions.map((p) => p.code).join(" ") ?? "",
      evidence_refs: f?.supporting.map((s) => s.ref).join(" ") ?? "",
      gaps: f?.gaps.join(" | ") ?? "",
      conflicts: f?.conflicts.map((x) => x.text).join(" | ") ?? "",
      flags: f?.flags.join(" ") ?? "",
      actions: acts.map((a) => `${a.id}:${a.type}:${a.status}${a.execution_mode === "simulated" ? ":SIMULATED" : ""}`).join(" "),
      proposed_refund: usd(acts.filter((a) => a.type === "refund_review" && a.status !== "rejected").reduce((s, a) => s + (a.proposed_amount_cents ?? 0), 0) || null),
      verified_refund: usd(acts.filter((a) => a.status === "verified_complete" && a.execution_mode === "recorded").reduce((s, a) => s + (a.verified_amount_cents ?? 0), 0) || null),
      analyzer: f ? `${f.analyzer_id}@${f.analyzer_version}${f.is_live ? "" : " (demo, not a live model)"}` : "",
    };
  });
  const header = Object.keys(rows[0] ?? { case_id: "" });
  return toCsv(header, rows);
}

export function incidentReportMarkdown(db: DB, incidentId: string, generatedBy: string): string {
  const inc = getIncident(db, incidentId);
  if (!inc) throw new Error("Incident not found");
  const tz = inc.timezone;
  const dash = computeDashboard(db, incidentId);
  const policies = listPolicies(db, incidentId);
  const cases = listCases(db, incidentId, { includeMerged: true });
  const actions = listActions(db, { incidentId });
  const batches = listBatches(db, incidentId);
  const runs = listRuns(db, incidentId);
  const chain = checkAuditChain(db);
  const L: string[] = [];
  const p = (s = "") => L.push(s);

  p(`# Incident report: ${inc.title}`);
  p();
  p(`Incident ${inc.id} · generated ${formatInZone(nowIso(), tz)} by ${actorName(generatedBy)} · owner ${actorName(inc.owner)}`);
  p();
  p("> All customer data in this prototype is synthetic. This report is an investigation record, not a statement of legal compliance or a guarantee that every affected person was identified.");
  p();
  p("## 1. What happened");
  p(inc.description);
  p();
  p(`- **AI system:** ${inc.ai_system} (known versions: ${inc.known_versions.join(", ") || "—"})`);
  p(`- **Incident period:** ${formatInZone(inc.start_at, tz)} to ${formatInZone(inc.end_at, tz)} (end exclusive; timezone ${tz})`);
  p(`- **Incorrect behavior:** ${inc.incorrect_behavior}`);
  p();
  p("## 2. Policies");
  p("| Policy | Role | Effective from | Effective to | Key terms |");
  p("|---|---|---|---|---|");
  for (const pol of policies) {
    p(`| ${pol.id} | ${pol.role === "authoritative" ? "Authoritative (in force)" : pol.role === "incorrect_used" ? "Outdated policy used by AI" : "Introduced after incident — not used for determinations"} | ${formatInZone(pol.effective_from, tz, false)} | ${pol.effective_to ? formatInZone(pol.effective_to, tz, false) : "open"} | ${pol.params.window_days}-day window; sale items ${pol.params.sale_refundable ? "refundable" : "final"}; proof: ${pol.params.proof.replace("_", " ")}${pol.params.defective_window_days ? `; defective ${pol.params.defective_window_days} days` : ""} |`);
  }
  p();
  p("## 3. Scope and method");
  p(`- Affected versions: ${inc.scope_criteria.affected_versions.join(", ")}; unrecorded versions ${inc.scope_criteria.include_unknown_versions ? "included by date" : "excluded"}.`);
  p(`- Topic keywords: ${inc.scope_criteria.topic_keywords.join(", ")}.`);
  p(`- Exclusions: ${inc.exclusions.join("; ") || "none"}.`);
  p("- Reviewer-defined criteria for confirmed adverse impact:");
  for (const c of inc.impact_criteria) p(`  - ${c.id}: ${c.text}`);
  p();
  p("Analysis runs:");
  for (const r of runs) p(`- ${r.id}: ${r.analyzer_id === "demo-rules" ? "Demo analyzer (rules-based, NOT a live model)" : `Live model ${r.model}`} version ${r.analyzer_version}, started ${formatInZone(r.started_at, tz)} by ${actorName(r.started_by)}`);
  p();
  p("Evidence imported:");
  for (const b of batches) p(`- ${b.id}: ${b.kind} from ${b.filename} (${b.format}), ${b.record_count} records, sha256 ${b.sha256.slice(0, 16)}…, ${b.flagged_count} item(s) flagged for instruction-like text, imported ${formatInZone(b.imported_at, tz)} by ${actorName(b.imported_by)}`);
  p();
  p("## 4. Results");
  p("| Measure | Value | Definition |");
  p("|---|---|---|");
  for (const m of dash.metrics) p(`| ${m.label} | ${m.value}${m.detail ? ` (${m.detail})` : ""} | ${m.definition} |`);
  p();
  p(`Refund amounts (shown separately, never combined): proposed ${usd(dash.money.proposedCents)}, approved ${usd(dash.money.approvedCents)}, **verified with recorded evidence ${usd(dash.money.verifiedCents)}**, simulated (not real) ${usd(dash.money.simulatedCents)}.`);
  p();
  p("Reviewer determinations:");
  for (const [k, v] of Object.entries(dash.impactBreakdown)) p(`- ${IMPACT_LABELS[k as Impact] ?? k}: ${v}`);
  p();
  p("## 5. Corrective actions");
  p("| Action | Case | Type | Status | Execution | Completion evidence |");
  p("|---|---|---|---|---|---|");
  for (const a of actions) {
    const v = parseVerification(a);
    p(`| ${a.id} | ${a.case_id} | ${ACTION_TYPE_LABELS[a.type]} | ${ACTION_STATUS_LABELS[a.status]} | ${a.execution_mode ? `${a.execution_mode === "simulated" ? "SIMULATED" : "Recorded"} ${a.execution_reference ?? ""}` : "—"} | ${v ? `${v.label}${v.kind === "simulated" ? " (simulated)" : ""}` : a.status === "approved" && a.type !== "no_action" ? "**Approved, no execution evidence yet**" : "—"} |`);
  }
  p();
  p("## 6. Unresolved questions");
  const open = cases.filter((c) => !["closed", "merged", "match_rejected"].includes(c.status));
  p(`- ${open.length} case(s) are not closed.`);
  const needsEv = cases.filter((c) => c.status === "needs_evidence");
  if (needsEv.length) p(`- Awaiting evidence: ${needsEv.map((c) => c.id).join(", ")}.`);
  const conflictCases = cases.filter((c) => c.primary_finding_id && (getFinding(db, c.primary_finding_id)?.conflicts.length ?? 0) > 0);
  if (conflictCases.length) p(`- Conflicting evidence recorded in: ${conflictCases.map((c) => c.id).join(", ")}.`);
  const appr = actions.filter((a) => a.status === "approved" && a.type !== "no_action");
  if (appr.length) p(`- Approved but not executed: ${appr.map((a) => a.id).join(", ")}.`);
  const failed = actions.filter((a) => a.status === "failed" || a.status === "reopened");
  if (failed.length) p(`- Failed or reopened: ${failed.map((a) => `${a.id} (${a.failure_reason ?? "reopened"})`).join("; ")}.`);
  const flagged = cases.filter((c) => parseJson<string[]>(c.flags, []).includes("instruction_like_text"));
  if (flagged.length) p(`- Instruction-like text found in imported evidence (treated as data; not acted on): ${flagged.map((c) => c.id).join(", ")}.`);
  p();
  p("## 7. Data limitations");
  for (const g of inc.known_gaps) p(`- ${g}`);
  p("- Findings are based only on imported records. Customers who abandoned before any recorded interaction, or whose records were not imported, cannot be identified by this process.");
  p("- Exposure to incorrect information does not by itself establish adverse impact; a different outcome under the corrected policy does not by itself establish causation or entitlement.");
  p(`- The application audit history contains ${chain.checked} entries; hash-chain consistency check: ${chain.ok ? "consistent" : `inconsistent from entry ${chain.firstBreak}`}. This check detects casual edits only and is not a tamper-proof guarantee.`);
  p();
  return L.join("\n");
}

export type { Exposure };
