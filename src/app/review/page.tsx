import Link from "next/link";
import { getDb, parseJson } from "@/lib/db";
import { currentIncident } from "@/lib/session";
import { listCases } from "@/lib/cases";
import { CASE_STATUS_LABELS, EXPOSURE_LABELS, IMPACT_LABELS, ACTION_STATUS_LABELS, type ActionStatus } from "@/lib/types";
import { Badge, Card, CaseStatusBadge, Empty, ExposureBadge, ImpactBadge } from "@/components/ui";

type Search = Promise<Record<string, string | undefined>>;

export default async function ReviewQueue({ searchParams }: { searchParams: Search }) {
  const sp = await searchParams;
  const incident = await currentIncident();
  if (!incident) return <Card><Empty>No incident selected.</Empty></Card>;
  const db = getDb();
  const filters = { q: sp.q, status: sp.status, impact: sp.impact, suggested: sp.suggested, exposure: sp.exposure, flag: sp.flag };
  const rows = listCases(db, incident.id, filters);
  const total = listCases(db, incident.id).length;
  const sel = (name: string, label: string, options: Record<string, string>) => (
    <div className="field" style={{ margin: 0 }}>
      <label htmlFor={`f-${name}`}>{label}</label>
      <select id={`f-${name}`} name={name} defaultValue={sp[name] ?? ""}>
        <option value="">Any</option>
        {Object.entries(options).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
      </select>
    </div>
  );
  const active = Object.values(filters).some(Boolean);

  return (
    <div className="stack">
      <div className="page-head"><div>
        <h1>Review queue</h1>
        <p>{incident.id}. Classification (exposure and impact) is shown separately from workflow status. “Suggested” values come from the analyzer and are not determinations.</p>
      </div></div>
      <Card>
        <form method="get" className="grid filters" role="search" aria-label="Filter cases">
          <div className="field" style={{ margin: 0 }}><label htmlFor="q">Search</label><input id="q" name="q" type="search" defaultValue={sp.q ?? ""} placeholder="Case, customer, order or conversation ID" /></div>
          {sel("status", "Workflow status", CASE_STATUS_LABELS)}
          {sel("exposure", "Exposure", EXPOSURE_LABELS)}
          {sel("suggested", "Suggested impact", { possible: IMPACT_LABELS.possible, none_found: IMPACT_LABELS.none_found, insufficient_evidence: IMPACT_LABELS.insufficient_evidence })}
          {sel("impact", "Reviewer impact", IMPACT_LABELS)}
          {sel("flag", "Flag", { duplicate: "Possible duplicate", conflict: "Conflicting evidence", gap: "Missing information", instruction_like_text: "Instruction-like text", analysis_output_rejected: "Analysis output rejected" })}
          <div className="row"><button className="btn primary" type="submit">Apply</button>{active && <Link className="btn" href="/review">Clear</Link>}</div>
        </form>
      </Card>
      <Card flush>
        {rows.length === 0 ? <Empty>{total === 0 ? "No cases yet. Run analysis from the incident's Investigation tab." : "No cases match these filters."}</Empty> : (
          <div className="table-wrap"><table>
            <caption>{rows.length} of {total} case(s), excluding merged duplicates{sp.status === "merged" ? " (showing merged)" : ""}</caption>
            <thead><tr><th>Case</th><th>Customer / order</th><th>Conversations</th><th>Exposure</th><th>Impact</th><th>Workflow</th><th>Flags</th><th>Actions</th></tr></thead>
            <tbody>{rows.map((c) => {
              const flags = parseJson<string[]>(c.flags, []);
              const acts = (c.action_statuses ?? "").split(",").filter(Boolean) as ActionStatus[];
              return (
                <tr key={c.id}>
                  <td><Link href={`/review/${c.id}`}><strong className="mono">{c.id}</strong></Link></td>
                  <td className="mono">{c.customer_id}<br /><span className="faint">{c.order_id ?? "no order"}</span></td>
                  <td className="mono" style={{ fontSize: ".78rem" }}>{(c.conversation_ids ?? "").split(",").map((x) => <div key={x}>{x}</div>)}</td>
                  <td><ExposureBadge exposure={c.exposure} /></td>
                  <td>{c.decided_by ? <ImpactBadge impact={c.impact} /> : <ImpactBadge impact={c.suggested_impact} suggested />}</td>
                  <td><CaseStatusBadge status={c.status} /></td>
                  <td><div className="row" style={{ gap: 4 }}>
                    {c.possible_duplicate_of && <Badge tone="warn" title={`Same customer and order as ${c.possible_duplicate_of}`}>Duplicate of {c.possible_duplicate_of}?</Badge>}
                    {flags.includes("instruction_like_text") && <Badge tone="warn">Instruction-like text</Badge>}
                    {flags.includes("analysis_output_rejected") && <Badge tone="bad">Output rejected</Badge>}
                  </div></td>
                  <td style={{ fontSize: ".78rem" }}>{acts.length ? acts.map((s, i) => <div key={i}>{ACTION_STATUS_LABELS[s]}</div>) : <span className="faint">—</span>}</td>
                </tr>
              );
            })}</tbody>
          </table></div>
        )}
      </Card>
    </div>
  );
}
