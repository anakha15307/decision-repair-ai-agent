import Link from "next/link";
import { getDb } from "@/lib/db";
import { currentIncident } from "@/lib/session";
import { listActions, parseVerification } from "@/lib/remediation";
import { actorName } from "@/lib/actors";
import { ACTION_STATUS_LABELS, ACTION_TYPE_LABELS, type ActionStatus } from "@/lib/types";
import { ActionStatusBadge, Card, Empty, When, money } from "@/components/ui";

const ORDER: ActionStatus[] = ["draft", "under_review", "needs_evidence", "approved", "execution_recorded", "verified_complete", "failed", "reopened", "rejected"];

export default async function ActionsPage({ searchParams }: { searchParams: Promise<{ status?: string; type?: string }> }) {
  const sp = await searchParams;
  const incident = await currentIncident();
  if (!incident) return <Card><Empty>No incident selected.</Empty></Card>;
  const db = getDb();
  const all = listActions(db, { incidentId: incident.id });
  const rows = all.filter((a) => (!sp.status || a.status === sp.status) && (!sp.type || a.type === sp.type));
  const counts = Object.fromEntries(ORDER.map((s) => [s, all.filter((a) => a.status === s).length]));
  const tz = incident.timezone;

  return (
    <div className="stack">
      <div className="page-head"><div>
        <h1>Corrective actions</h1>
        <p>Draft → Under review → Approved → Execution recorded → Verified complete. Each step is recorded separately. Decision Repair never executes actions; staff record work done in the system of record, or simulate it (labelled) in this demo.</p>
      </div></div>
      <nav className="row" aria-label="Filter by status">
        <Link className={`btn small${!sp.status ? " primary" : ""}`} href="/actions">All ({all.length})</Link>
        {ORDER.map((s) => <Link key={s} className={`btn small${sp.status === s ? " primary" : ""}`} href={`/actions?status=${s}`} aria-current={sp.status === s ? "page" : undefined}>{ACTION_STATUS_LABELS[s]} ({counts[s]})</Link>)}
      </nav>
      <Card flush>
        {rows.length === 0 ? <Empty>No corrective actions{sp.status ? ` with status “${ACTION_STATUS_LABELS[sp.status as ActionStatus]}”` : ""}.</Empty> : (
          <div className="table-wrap"><table>
            <thead><tr><th>Action</th><th>Case</th><th>Type</th><th>Status</th><th className="num">Proposed</th><th className="num">Verified</th><th>Approved</th><th>Execution</th><th>Completion evidence</th></tr></thead>
            <tbody>{rows.map((a) => {
              const v = parseVerification(a);
              return (
                <tr key={a.id}>
                  <td><Link href={`/review/${a.case_id}#${a.id}`} className="mono">{a.id}</Link><br /><span className="hint">{a.summary}</span></td>
                  <td className="mono"><Link href={`/review/${a.case_id}`}>{a.case_id}</Link></td>
                  <td>{ACTION_TYPE_LABELS[a.type]}</td>
                  <td><ActionStatusBadge status={a.status} simulated={a.execution_mode === "simulated"} /></td>
                  <td className="num mono">{a.type === "refund_review" ? money(a.proposed_amount_cents) : "—"}</td>
                  <td className="num mono">{a.verified_amount_cents != null ? money(a.verified_amount_cents) : "—"}</td>
                  <td>{a.approved_by ? <>{actorName(a.approved_by)}<br /><When iso={a.approved_at} tz={tz} date /></> : <span className="faint">—</span>}</td>
                  <td>{a.execution_mode ? <>{a.execution_mode === "simulated" ? "Simulated" : "Recorded"} <code>{a.execution_reference}</code><br /><span className="faint">{actorName(a.executed_by)}</span></> : a.status === "approved" && a.type !== "no_action" ? <strong style={{ color: "var(--warn)" }}>Not yet executed</strong> : <span className="faint">—</span>}</td>
                  <td>{v ? <>{v.label}<br /><code>{v.ref}</code></> : a.failure_reason ? <span style={{ color: "var(--bad)" }}>{a.failure_reason}</span> : <span className="faint">—</span>}</td>
                </tr>
              );
            })}</tbody>
          </table></div>
        )}
      </Card>
    </div>
  );
}
