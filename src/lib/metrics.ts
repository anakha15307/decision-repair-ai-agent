import type { DB } from "./db";
import { parseJson } from "./db";
import { latestRun } from "./analysis/engine";

export interface Metric {
  key: string;
  label: string;
  value: number | string;
  definition: string;
  detail?: string;
}

export interface DashboardData {
  runLabel: string | null;
  metrics: Metric[];
  money: { proposedCents: number; approvedCents: number; verifiedCents: number; simulatedCents: number; currency: string };
  impactBreakdown: Record<string, number>;
  suggestedBreakdown: Record<string, number>;
  statusBreakdown: Record<string, number>;
  actionBreakdown: Record<string, number>;
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

const n = (db: DB, sql: string, ...p: unknown[]) => (db.prepare(sql).get(...p) as { n: number }).n;

/**
 * Dashboard counts. Merged cases are excluded everywhere (their conversations live on in the
 * target case). Action funnel stages are cumulative by current status, so each action is
 * counted once per stage it has reached and never twice within a stage.
 */
export function computeDashboard(db: DB, incidentId: string): DashboardData {
  const run = latestRun(db, incidentId);
  const ACTIVE = "incident_id = ? AND status != 'merged'";
  const LIVE = `${ACTIVE} AND status != 'match_rejected'`;

  const candidates = run ? n(db, "SELECT COUNT(*) n FROM findings WHERE run_id = ? AND is_candidate = 1", run.id) : 0;
  const exposedConvs = run ? n(db, "SELECT COUNT(*) n FROM findings WHERE run_id = ? AND is_candidate = 1 AND exposure = 'exposed'", run.id) : 0;
  const uniqueCustomers = n(db, `SELECT COUNT(DISTINCT customer_id) n FROM cases WHERE ${LIVE} AND exposure IN ('exposed','undetermined')`, incidentId);
  const uniqueExposed = n(db, `SELECT COUNT(DISTINCT customer_id) n FROM cases WHERE ${LIVE} AND exposure = 'exposed'`, incidentId);
  const totalCases = n(db, `SELECT COUNT(*) n FROM cases WHERE ${ACTIVE}`, incidentId);
  const reviewed = n(db, `SELECT COUNT(*) n FROM cases WHERE ${ACTIVE} AND (decided_by IS NOT NULL OR status = 'match_rejected')`, incidentId);
  const confirmed = n(db, `SELECT COUNT(*) n FROM cases WHERE ${LIVE} AND impact = 'confirmed'`, incidentId);
  const confirmedCustomers = n(db, `SELECT COUNT(DISTINCT customer_id) n FROM cases WHERE ${LIVE} AND impact = 'confirmed'`, incidentId);
  const awaitingCase = n(db, `SELECT COUNT(*) n FROM cases WHERE ${ACTIVE} AND status = 'needs_evidence'`, incidentId);
  const awaitingAction = n(db, "SELECT COUNT(*) n FROM corrective_actions WHERE incident_id = ? AND status = 'needs_evidence'", incidentId);

  const exec = "type != 'no_action'";
  const approved = n(db, `SELECT COUNT(*) n FROM corrective_actions WHERE incident_id = ? AND ${exec} AND status IN ('approved','execution_recorded','verified_complete')`, incidentId);
  const approvedNoAction = n(db, "SELECT COUNT(*) n FROM corrective_actions WHERE incident_id = ? AND type = 'no_action' AND status = 'approved'", incidentId);
  const approvedNotExecuted = n(db, `SELECT COUNT(*) n FROM corrective_actions WHERE incident_id = ? AND ${exec} AND status = 'approved'`, incidentId);
  const executed = n(db, `SELECT COUNT(*) n FROM corrective_actions WHERE incident_id = ? AND status IN ('execution_recorded','verified_complete')`, incidentId);
  const executedSim = n(db, `SELECT COUNT(*) n FROM corrective_actions WHERE incident_id = ? AND status IN ('execution_recorded','verified_complete') AND execution_mode = 'simulated'`, incidentId);
  const verifiedReal = n(db, "SELECT COUNT(*) n FROM corrective_actions WHERE incident_id = ? AND status = 'verified_complete' AND execution_mode = 'recorded'", incidentId);
  const verifiedSim = n(db, "SELECT COUNT(*) n FROM corrective_actions WHERE incident_id = ? AND status = 'verified_complete' AND execution_mode = 'simulated'", incidentId);
  const failed = n(db, "SELECT COUNT(*) n FROM corrective_actions WHERE incident_id = ? AND status IN ('failed','reopened')", incidentId);

  // Time to resolution: case opened → last real (non-simulated) verification, for closed cases
  // whose actions are all settled with at least one verified with recorded evidence.
  const closed = db.prepare(`SELECT c.id, c.created_at,
      (SELECT MAX(verified_at) FROM corrective_actions a WHERE a.case_id = c.id AND a.status = 'verified_complete' AND a.execution_mode = 'recorded') AS done,
      (SELECT COUNT(*) FROM corrective_actions a WHERE a.case_id = c.id AND a.status = 'verified_complete' AND a.execution_mode = 'simulated') AS sim
    FROM cases c WHERE c.incident_id = ? AND c.status = 'closed'`).all(incidentId) as { id: string; created_at: string; done: string | null; sim: number }[];
  const durations = closed.filter((r) => r.done && r.sim === 0).map((r) => (Date.parse(r.done!) - Date.parse(r.created_at)) / 86_400_000);
  const med = median(durations);

  const sums = db.prepare(`SELECT
      COALESCE(SUM(CASE WHEN status NOT IN ('rejected') THEN proposed_amount_cents END),0) AS proposed,
      COALESCE(SUM(CASE WHEN status IN ('approved','execution_recorded','verified_complete') THEN proposed_amount_cents END),0) AS approved,
      COALESCE(SUM(CASE WHEN status = 'verified_complete' AND execution_mode = 'recorded' THEN verified_amount_cents END),0) AS verified,
      COALESCE(SUM(CASE WHEN status = 'verified_complete' AND execution_mode = 'simulated' THEN proposed_amount_cents END),0) AS simulated
    FROM corrective_actions WHERE incident_id = ? AND type = 'refund_review'`).get(incidentId) as { proposed: number; approved: number; verified: number; simulated: number };

  const group = (sql: string) => Object.fromEntries((db.prepare(sql).all(incidentId) as { k: string; n: number }[]).map((r) => [r.k, r.n]));

  const metrics: Metric[] = [
    { key: "candidates", label: "Candidate interactions", value: candidates,
      definition: "Conversations in the latest analysis run that fall inside the incident scope (date window, affected or unrecorded version, no exclusion) and raise the incident topic. Counts conversations, not customers.",
      detail: `${exposedConvs} with incorrect information identified` },
    { key: "customers", label: "Unique customers potentially affected", value: uniqueCustomers,
      definition: "Distinct customer IDs with at least one open or reviewed case (excluding rejected matches and merged duplicates) where exposure is established or undetermined. A customer with several conversations counts once.",
      detail: `${uniqueExposed} with exposure established` },
    { key: "reviewed", label: "Cases reviewed", value: `${reviewed} / ${totalCases}`,
      definition: "Cases with a recorded reviewer determination or a rejected match, out of all cases excluding merged duplicates." },
    { key: "confirmed", label: "Cases with confirmed impact", value: confirmed,
      definition: "Cases where a reviewer confirmed adverse impact against every reviewer-defined criterion. Analyzer suggestions never count here.",
      detail: `${confirmedCustomers} unique customer(s)` },
    { key: "awaiting", label: "Cases awaiting evidence", value: awaitingCase,
      definition: "Cases whose workflow status is Needs evidence. Actions awaiting evidence are shown separately.",
      detail: `${awaitingAction} action(s) also need evidence` },
    { key: "approved", label: "Actions approved", value: approved,
      definition: "Corrective actions (excluding no-action determinations) currently Approved, Execution recorded or Verified complete. Approval is not execution.",
      detail: `${approvedNotExecuted} approved but not yet executed · ${approvedNoAction} no-action determination(s) approved` },
    { key: "executed", label: "Actions executed", value: executed,
      definition: "Actions whose execution has been recorded by staff (or simulated, shown separately). Execution is not verified completion.",
      detail: executedSim ? `includes ${executedSim} simulated` : "none simulated" },
    { key: "verified", label: "Resolutions verified", value: verifiedReal,
      definition: "Actions verified complete against recorded completion evidence (imported transaction, interaction, or receipt). Simulated verifications are excluded from this number.",
      detail: `${verifiedSim} simulated verification(s) not counted · ${failed} failed or reopened` },
    { key: "ttr", label: "Median time to resolution", value: med == null ? "—" : `${med.toFixed(1)} days`,
      definition: "Median days from case opening to the last verified (non-simulated) corrective action, for closed cases only.",
      detail: `n = ${durations.length} closed case(s)` },
  ];

  return {
    runLabel: run ? `${run.analyzer_id === "demo-rules" ? "Demo analyzer (rules-based)" : `Live model ${run.model}`} · ${run.analyzer_version} · ${run.id}` : null,
    metrics,
    money: { proposedCents: sums.proposed, approvedCents: sums.approved, verifiedCents: sums.verified, simulatedCents: sums.simulated, currency: "USD" },
    impactBreakdown: group(`SELECT impact k, COUNT(*) n FROM cases WHERE ${LIVE} GROUP BY impact`),
    suggestedBreakdown: group(`SELECT suggested_impact k, COUNT(*) n FROM cases WHERE ${LIVE} GROUP BY suggested_impact`),
    statusBreakdown: group(`SELECT status k, COUNT(*) n FROM cases WHERE incident_id = ? GROUP BY status`),
    actionBreakdown: group(`SELECT status k, COUNT(*) n FROM corrective_actions WHERE incident_id = ? GROUP BY status`),
  };
}

export function runStats(stats: string) {
  return parseJson<Record<string, unknown>>(stats, {});
}
