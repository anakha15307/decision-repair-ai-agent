import Link from "next/link";
import { getDb } from "@/lib/db";
import { currentIncident } from "@/lib/session";
import { computeDashboard } from "@/lib/metrics";
import { listActions } from "@/lib/remediation";
import { listCases, getFinding } from "@/lib/cases";
import { listAudit } from "@/lib/audit";
import { actorName } from "@/lib/actors";
import { CASE_STATUS_LABELS, IMPACT_LABELS, ACTION_STATUS_LABELS, type CaseStatus, type Impact, type ActionStatus } from "@/lib/types";
import { Card, Empty, money, When, Badge } from "@/components/ui";

function Bars({ data, labels, tones, order }: { data: Record<string, number>; labels: Record<string, string>; tones: Record<string, string>; order: string[] }) {
  const max = Math.max(1, ...Object.values(data));
  const keys = order.filter((k) => data[k]);
  if (!keys.length) return <Empty>No data yet.</Empty>;
  return (
    <div className="bars">
      {keys.map((k) => (
        <div className="bar" key={k}>
          <span>{labels[k] ?? k}</span>
          <span className="track" aria-hidden="true"><span className={`fill ${tones[k] ?? ""}`} style={{ width: `${(100 * data[k]) / max}%`, display: "block" }} /></span>
          <span className="n">{data[k]}</span>
        </div>
      ))}
    </div>
  );
}

export default async function Overview() {
  const incident = await currentIncident();
  if (!incident) {
    return (
      <div className="stack">
        <h1>Overview</h1>
        <Card><Empty>No incidents yet. <Link href="/incidents/new">Register an incident</Link> or run <code>npm run seed</code> to load the demonstration incident.</Empty></Card>
      </div>
    );
  }
  const db = getDb();
  const tz = incident.timezone;
  const d = computeDashboard(db, incident.id);
  const actions = listActions(db, { incidentId: incident.id });
  const allCases = listCases(db, incident.id);
  const attention = [
    ...actions.filter((a) => a.status === "approved" && a.type !== "no_action").map((a) => ({ key: a.id, href: `/review/${a.case_id}#${a.id}`, text: `${a.id} approved but no execution recorded`, tone: "warn" as const })),
    ...actions.filter((a) => a.status === "failed" || a.status === "reopened").map((a) => ({ key: a.id, href: `/review/${a.case_id}#${a.id}`, text: `${a.id} ${a.status === "failed" ? "failed" : "reopened after failure"}: ${a.failure_reason ?? ""}`, tone: "bad" as const })),
    ...actions.filter((a) => a.status === "execution_recorded").map((a) => ({ key: a.id, href: `/review/${a.case_id}#${a.id}`, text: `${a.id} executed${a.execution_mode === "simulated" ? " (simulated)" : ""}; awaiting verification evidence`, tone: "info" as const })),
    ...allCases.filter((c) => c.status === "needs_evidence").map((c) => ({ key: c.id, href: `/review/${c.id}`, text: `${c.id} awaiting evidence`, tone: "warn" as const })),
    ...allCases.filter((c) => c.flags.includes("instruction_like_text")).map((c) => ({ key: `${c.id}-inj`, href: `/review/${c.id}`, text: `${c.id} contains instruction-like text in imported evidence (treated as data)`, tone: "warn" as const })),
    ...allCases.filter((c) => c.primary_finding_id && ["unreviewed", "in_review"].includes(c.status) && (getFinding(db, c.primary_finding_id)?.conflicts.length ?? 0) > 0).map((c) => ({ key: `${c.id}-c`, href: `/review/${c.id}`, text: `${c.id} has conflicting evidence`, tone: "warn" as const })),
  ];
  const recent = listAudit(db, { incidentId: incident.id, limit: 8 });
  const m = d.money;

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>{incident.title}</h1>
          <p>{incident.id} · {incident.ai_system} · <When iso={incident.start_at} tz={tz} /> to <When iso={incident.end_at} tz={tz} /></p>
        </div>
        <div className="row">
          <Link className="btn" href={`/incidents/${incident.id}`}>Incident setup</Link>
          <Link className="btn primary" href="/review">Open review queue</Link>
        </div>
      </div>
      {d.runLabel ? <p className="muted">Counts use the latest analysis run: {d.runLabel}. Expand any measure for its definition.</p> : <div className="alert info"><p>No analysis has run yet. Import evidence and run analysis from the incident page.</p></div>}

      <section aria-labelledby="m-h">
        <h2 id="m-h" className="sr-only">Key measures</h2>
        <div className="metrics">
          {d.metrics.map((x) => (
            <div className="metric" key={x.key}>
              <div className="label">{x.label}</div>
              <div className="value">{x.value}</div>
              {x.detail && <div className="detail">{x.detail}</div>}
              <details><summary>Definition</summary>{x.definition}</details>
            </div>
          ))}
        </div>
      </section>

      <div className="grid cols-2">
        <Card title="Refund amounts" id="money">
          <p className="muted" style={{ fontSize: ".82rem" }}>Shown separately and never added together. Only amounts verified against recorded completion evidence count as remediated.</p>
          <dl className="kv">
            <dt>Proposed (not rejected)</dt><dd className="mono">{money(m.proposedCents)}</dd>
            <dt>Approved</dt><dd className="mono">{money(m.approvedCents)}</dd>
            <dt><strong>Verified with evidence</strong></dt><dd className="mono"><strong>{money(m.verifiedCents)}</strong></dd>
            <dt>Simulated (not real)</dt><dd className="mono">{money(m.simulatedCents)} <Badge tone="sim">Simulated</Badge></dd>
          </dl>
        </Card>
        <Card title="Needs attention" id="attention">
          {attention.length === 0 ? <Empty>Nothing needs attention.</Empty> : (
            <ul style={{ margin: 0, paddingLeft: "1.1rem" }}>
              {attention.slice(0, 12).map((a) => <li key={a.key}><Link href={a.href}>{a.text}</Link></li>)}
            </ul>
          )}
        </Card>
      </div>

      <div className="grid cols-3">
        <Card title="Reviewer determinations" id="impact">
          <p className="hint">Classification, kept separate from workflow status. Excludes merged and rejected matches.</p>
          <Bars data={d.impactBreakdown} labels={IMPACT_LABELS as Record<string, string>} order={["confirmed", "possible", "insufficient_evidence", "none_found", "not_assessed"] satisfies Impact[]} tones={{ confirmed: "bad", possible: "warn", none_found: "ok", not_assessed: "muted", insufficient_evidence: "muted" }} />
          <hr />
          <h3 className="muted" style={{ fontSize: ".8rem" }}>Analyzer suggestions (not determinations)</h3>
          <Bars data={d.suggestedBreakdown} labels={IMPACT_LABELS as Record<string, string>} order={["possible", "insufficient_evidence", "none_found", "not_assessed"]} tones={{ possible: "warn", none_found: "ok", insufficient_evidence: "muted" }} />
        </Card>
        <Card title="Case workflow" id="workflow">
          <Bars data={d.statusBreakdown} labels={CASE_STATUS_LABELS as Record<string, string>} order={["unreviewed", "in_review", "needs_evidence", "reviewed", "closed", "match_rejected", "merged"] satisfies CaseStatus[]} tones={{ closed: "ok", needs_evidence: "warn", match_rejected: "muted", merged: "muted" }} />
        </Card>
        <Card title="Corrective actions" id="actions">
          <Bars data={d.actionBreakdown} labels={ACTION_STATUS_LABELS as Record<string, string>} order={["draft", "under_review", "needs_evidence", "approved", "execution_recorded", "verified_complete", "failed", "reopened", "rejected"] satisfies ActionStatus[]} tones={{ verified_complete: "ok", failed: "bad", reopened: "bad", needs_evidence: "warn", execution_recorded: "warn", rejected: "muted" }} />
          <p className="hint" style={{ marginTop: ".6rem" }}>Approved → Execution recorded → Verified complete are separate states. Approval is not execution; execution is not verified completion.</p>
        </Card>
      </div>

      <Card title="Recent activity" id="recent" actions={<Link href="/reports#audit">Full audit history</Link>} flush>
        <div className="table-wrap">
          <table>
            <thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Entity</th><th>Reason</th></tr></thead>
            <tbody>
              {recent.map((r) => (
                <tr key={r.seq}><td><When iso={r.ts} tz={tz} /></td><td>{actorName(r.actor)}</td><td><code>{r.action}</code></td><td>{r.entity_type} {r.entity_id}</td><td>{r.reason ?? ""}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
