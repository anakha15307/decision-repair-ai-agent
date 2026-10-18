import Link from "next/link";
import { getDb } from "@/lib/db";
import { listIncidents } from "@/lib/incidents";
import { actorName } from "@/lib/actors";
import { Card, Empty, When } from "@/components/ui";

export default function IncidentsPage() {
  const db = getDb();
  const incidents = listIncidents(db);
  const count = db.prepare("SELECT incident_id, COUNT(*) n FROM cases WHERE status != 'merged' GROUP BY incident_id").all() as { incident_id: string; n: number }[];
  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Incidents</h1>
          <p>Each incident defines a period, the affected AI system, the incorrect behavior, the policy that actually applied, and reviewer-defined criteria for confirming impact.</p>
        </div>
        <Link className="btn primary" href="/incidents/new">Register incident</Link>
      </div>
      <Card flush>
        {incidents.length === 0 ? <Empty>No incidents registered.</Empty> : (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Incident</th><th>AI system</th><th>Period</th><th>Owner</th><th className="num">Cases</th></tr></thead>
              <tbody>
                {incidents.map((i) => (
                  <tr key={i.id}>
                    <td><Link href={`/incidents/${i.id}`}><strong>{i.title}</strong></Link><br /><span className="muted mono">{i.id}</span></td>
                    <td>{i.ai_system}</td>
                    <td><When iso={i.start_at} tz={i.timezone} /> –<br /><When iso={i.end_at} tz={i.timezone} /></td>
                    <td>{actorName(i.owner)}</td>
                    <td className="num">{count.find((c) => c.incident_id === i.id)?.n ?? 0}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
