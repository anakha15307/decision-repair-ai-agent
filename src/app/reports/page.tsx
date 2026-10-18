import Link from "next/link";
import { getDb } from "@/lib/db";
import { currentActor, currentIncident } from "@/lib/session";
import { incidentReportMarkdown } from "@/lib/report";
import { checkAuditChain, listAudit } from "@/lib/audit";
import { evaluate, loadLabels } from "@/lib/evaluation";
import { actorName, can } from "@/lib/actors";
import { Badge, Card, Empty, When } from "@/components/ui";
import { Markdown } from "@/components/Markdown";

const pct = (x: number | null) => (x == null ? "—" : `${(x * 100).toFixed(1)}%`);

export default async function ReportsPage({ searchParams }: { searchParams: Promise<{ entity?: string; action?: string }> }) {
  const sp = await searchParams;
  const incident = await currentIncident();
  if (!incident) return <Card><Empty>No incident selected.</Empty></Card>;
  const actor = await currentActor();
  const db = getDb();
  const tz = incident.timezone;
  const md = incidentReportMarkdown(db, incident.id, actor.id);
  const chain = checkAuditChain(db);
  const rows = listAudit(db, { incidentId: incident.id, limit: 2000 }).filter((r) => (!sp.entity || r.entity_type === sp.entity) && (!sp.action || r.action.includes(sp.action)));
  const labels = loadLabels();
  const ev = labels ? evaluate(db, incident.id, labels) : null;
  const canExport = can(actor, "report.export");

  return (
    <div className="stack">
      <div className="page-head">
        <div><h1>Reports</h1><p>Human-readable incident report, case list, and the application audit history. Exports are themselves recorded in the audit history.</p></div>
        {canExport && (
          <div className="row">
            <a className="btn primary" href={`/api/incidents/${incident.id}/report`}>Download report (.md)</a>
            <a className="btn" href={`/api/incidents/${incident.id}/cases`}>Case list (.csv)</a>
            <a className="btn" href={`/api/incidents/${incident.id}/audit`}>Audit history (.csv)</a>
          </div>
        )}
      </div>

      <Card title="Incident report preview" id="report"><Markdown source={md} /></Card>

      <Card title="Analyzer evaluation against hidden labels" id="evaluation">
        <div className="alert info"><p>The synthetic dataset includes ground-truth labels stored separately in <code>data/eval/labels.json</code>. They are never imported as evidence or read by the analyzer; they are used only here to measure matching and classification. Real incidents have no such labels.</p></div>
        {!ev ? <Empty>No labels file or no analysis run.</Empty> : (
          <div className="stack">
            <p className="muted">Run {ev.runId} · {ev.analyzer} · {ev.labelled} labelled conversations</p>
            <div className="metrics">
              <div className="metric"><div className="label">Candidate matching precision</div><div className="value">{pct(ev.matching.precision)}</div><div className="detail">TP {ev.matching.tp} · FP {ev.matching.fp}</div></div>
              <div className="metric"><div className="label">Candidate matching recall</div><div className="value">{pct(ev.matching.recall)}</div><div className="detail">FN {ev.matching.fn} · TN {ev.matching.tn}</div></div>
              <div className="metric"><div className="label">Exposure precision</div><div className="value">{pct(ev.exposure.precision)}</div><div className="detail">TP {ev.exposure.tp} · FP {ev.exposure.fp}</div></div>
              <div className="metric"><div className="label">Exposure recall</div><div className="value">{pct(ev.exposure.recall)}</div><div className="detail">FN {ev.exposure.fn}</div></div>
              <div className="metric"><div className="label">Suggested impact agreement</div><div className="value">{ev.impact.agree}/{ev.impact.total}</div><div className="detail">exposed conversations only</div></div>
              <div className="metric"><div className="label">Reviewer determinations agreeing</div><div className="value">{ev.reviewer.agree}/{ev.reviewer.total}</div><div className="detail">seeded decisions are scripted demo data</div></div>
            </div>
            <p className="hint">These figures describe this synthetic dataset only. They are not a detection guarantee and should not be read as an expected accuracy on real incidents.</p>
            {ev.misses.length > 0 && (
              <div className="table-wrap"><table>
                <caption>Disagreements with labels</caption>
                <thead><tr><th>Conversation</th><th>Scenario</th><th>Problem</th></tr></thead>
                <tbody>{ev.misses.map((m) => <tr key={m.conversation_id + m.problem}><td className="mono">{m.conversation_id}</td><td>{m.scenario}</td><td>{m.problem}</td></tr>)}</tbody>
              </table></div>
            )}
          </div>
        )}
      </Card>

      <Card title="Audit history" id="audit" actions={chain.ok ? <Badge tone="ok">Hash chain consistent ({chain.checked} entries)</Badge> : <Badge tone="bad">Hash chain inconsistent at entry {chain.firstBreak}</Badge>} flush>
        <div className="card-b" style={{ borderBottom: "1px solid var(--border)" }}>
          <p className="hint" style={{ margin: 0 }}>Append-only within the application: the database rejects updates and deletes to this table, and each entry is chained to the previous one by hash. This detects casual edits; it is not tamper-proof against someone with direct access to the database file.</p>
          <form method="get" className="row" style={{ marginTop: ".5rem", alignItems: "flex-end" }}>
            <div><label htmlFor="entity">Entity</label><select id="entity" name="entity" defaultValue={sp.entity ?? ""}><option value="">Any</option>{["incident", "policy_version", "import_batch", "analysis_run", "case", "corrective_action"].map((e) => <option key={e} value={e}>{e}</option>)}</select></div>
            <div><label htmlFor="action">Action contains</label><input id="action" name="action" defaultValue={sp.action ?? ""} placeholder="e.g. override, verified" /></div>
            <button className="btn" type="submit">Filter</button>
            {(sp.entity || sp.action) && <Link className="btn" href="/reports#audit">Clear</Link>}
          </form>
        </div>
        <div className="table-wrap"><table>
          <caption>{rows.length} entr{rows.length === 1 ? "y" : "ies"}, newest first</caption>
          <thead><tr><th>#</th><th>When</th><th>Actor</th><th>Action</th><th>Entity</th><th>Previous → new</th><th>Evidence</th><th>Reason</th></tr></thead>
          <tbody>{rows.slice(0, 400).map((r) => (
            <tr key={r.seq}>
              <td className="mono faint">{r.seq}</td><td><When iso={r.ts} tz={tz} /></td><td>{actorName(r.actor)}<br /><span className="faint" style={{ fontSize: ".72rem" }}>{r.actor_role}</span></td>
              <td><code>{r.action}</code></td><td className="mono" style={{ fontSize: ".78rem" }}>{r.entity_type}<br />{r.entity_id}</td>
              <td style={{ maxWidth: 380 }}><details><summary className="hint">view values</summary><div className="mono" style={{ fontSize: ".72rem", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>prev: {r.prev_value ?? "—"}{"\n"}new: {r.new_value ?? "—"}</div></details></td>
              <td className="mono" style={{ fontSize: ".72rem", maxWidth: 200, overflowWrap: "anywhere" }}>{JSON.parse(r.evidence_refs).join(" ")}</td>
              <td style={{ fontSize: ".82rem" }}>{r.reason ?? ""}</td>
            </tr>
          ))}</tbody>
        </table></div>
      </Card>
    </div>
  );
}
