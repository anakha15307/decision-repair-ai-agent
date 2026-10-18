import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb, parseJson } from "@/lib/db";
import { getIncident } from "@/lib/incidents";
import { listPolicies, overlappingAuthoritative } from "@/lib/policy";
import { listBatches } from "@/lib/importers";
import { latestRun, listRuns, type ScopeReason } from "@/lib/analysis/engine";
import { liveProviderConfigured } from "@/lib/analysis/anthropicProvider";
import { DEMO_ANALYZER_VERSION } from "@/lib/analysis/demoAnalyzer";
import { actorName, can, ROLE_LABELS } from "@/lib/actors";
import { currentActor } from "@/lib/session";
import type { Exposure, Impact } from "@/lib/types";
import { AnalyzerBadge, Badge, Card, Empty, ExposureBadge, Flash, ImpactBadge, When } from "@/components/ui";
import { addGapAction, addPolicyAction, runAnalysisAction } from "@/app/server-actions";
import { ImportForm } from "./ImportForm";

const SAMPLES = [
  ["conversations.json", "Conversations (JSON, main export)"],
  ["conversations-email-export.csv", "Conversations (CSV, email channel; contains prompt-injection text)"],
  ["transactions.csv", "Transactions (CSV)"],
  ["interactions.json", "Later interactions (JSON)"],
  ["remediation-ledger.csv", "Remediation ledger (CSV; completion evidence)"],
  ["invalid-transactions.csv", "Invalid file (to see validation errors)"],
  ["policy-refund-3.1.txt", "Policy text v3.1 (paste into the policy form)"],
];

type Search = Promise<{ tab?: string; ok?: string; err?: string; f?: string }>;

export default async function IncidentPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Search }) {
  const { id } = await params;
  const sp = await searchParams;
  const db = getDb();
  const inc = getIncident(db, id);
  if (!inc) notFound();
  const actor = await currentActor();
  const tz = inc.timezone;
  const tab = sp.tab ?? "setup";
  const tabs = [["setup", "Setup & policies"], ["evidence", "Evidence"], ["investigation", "Investigation"], ["runs", "Analysis runs"]];

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <p className="muted mono" style={{ margin: 0 }}>{inc.id}</p>
          <h1>{inc.title}</h1>
          <p>{inc.ai_system} · owner {actorName(inc.owner)} · reviewers {inc.reviewers.map(actorName).join(", ") || "—"}</p>
        </div>
      </div>
      <nav className="tabs" aria-label="Incident sections">
        {tabs.map(([k, l]) => <Link key={k} href={`/incidents/${id}?tab=${k}`} aria-current={tab === k ? "page" : undefined}>{l}</Link>)}
      </nav>
      <Flash ok={sp.ok} err={sp.err} />
      {tab === "setup" && <Setup id={id} />}
      {tab === "evidence" && <Evidence id={id} canImport={can(actor, "evidence.import")} roleLabel={ROLE_LABELS[actor.role]} />}
      {tab === "investigation" && <Investigation id={id} filter={sp.f ?? "candidates"} canRun={can(actor, "analysis.run")} />}
      {tab === "runs" && <Runs id={id} tz={tz} />}
    </div>
  );

  function Setup({ id }: { id: string }) {
    const policies = listPolicies(db, id);
    const overlaps = overlappingAuthoritative(policies);
    return (
      <div className="stack">
        <div className="grid cols-2">
          <Card title="Incident definition" id="definition">
            <dl className="kv">
              <dt>Description</dt><dd>{inc!.description}</dd>
              <dt>Incorrect behavior</dt><dd>{inc!.incorrect_behavior}</dd>
              <dt>Known versions</dt><dd>{inc!.known_versions.map((v) => <code key={v} style={{ marginRight: 6 }}>{v}</code>)}</dd>
              <dt>Start</dt><dd><When iso={inc!.start_at} tz={tz} /> <span className="faint mono">({inc!.start_at})</span></dd>
              <dt>End (exclusive)</dt><dd><When iso={inc!.end_at} tz={tz} /> <span className="faint mono">({inc!.end_at})</span></dd>
              <dt>Timezone</dt><dd>{tz}</dd>
            </dl>
          </Card>
          <Card title="Scope criteria and exclusions" id="scope">
            <dl className="kv">
              <dt>Affected versions</dt><dd>{inc!.scope_criteria.affected_versions.map((v) => <code key={v} style={{ marginRight: 6 }}>{v}</code>)}</dd>
              <dt>Unrecorded versions</dt><dd>{inc!.scope_criteria.include_unknown_versions ? "Included by date (recorded as a gap)" : "Excluded"}</dd>
              <dt>Topic keywords</dt><dd>{inc!.scope_criteria.topic_keywords.join(", ")}</dd>
              <dt>Excluded ID prefixes</dt><dd>{inc!.scope_criteria.excluded_customer_prefixes.join(", ") || "—"}</dd>
              <dt>No assistant messages</dt><dd>{inc!.scope_criteria.exclude_without_assistant_messages ? "Excluded" : "Included"}</dd>
              <dt>Exclusions</dt><dd><ul style={{ margin: 0, paddingLeft: "1rem" }}>{inc!.exclusions.map((e) => <li key={e}>{e}</li>)}</ul></dd>
            </dl>
          </Card>
        </div>
        <Card title="Reviewer-defined criteria for confirmed adverse impact" id="criteria">
          <p className="hint">A case can be classified as <em>Confirmed adverse impact</em> only when a reviewer records every criterion as met. Analyzers can never confirm impact.</p>
          <ol style={{ margin: 0 }}>{inc!.impact_criteria.map((c) => <li key={c.id}><strong>{c.id}</strong> — {c.text}</li>)}</ol>
        </Card>
        <Card title="Policy versions" id="policies">
          {overlaps.length > 0 && <div className="alert err"><p>{overlaps.join(" ")}</p></div>}
          <p className="hint">Determinations use the authoritative version in force at the moment of each conversation. Versions introduced after the incident are recorded for context only.</p>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Version</th><th>Role</th><th>Effective from</th><th>Effective to</th><th>Key terms</th><th>Provisions</th></tr></thead>
              <tbody>
                {policies.map((p) => (
                  <tr key={p.id}>
                    <td><strong>{p.version}</strong><br /><span className="mono faint">{p.id}</span></td>
                    <td>{p.role === "authoritative" ? <Badge tone="ok">Authoritative</Badge> : p.role === "incorrect_used" ? <Badge tone="bad">Outdated — used by AI</Badge> : <Badge tone="neutral">Introduced after incident</Badge>}</td>
                    <td><When iso={p.effective_from} tz={tz} date /></td>
                    <td>{p.effective_to ? <When iso={p.effective_to} tz={tz} date /> : "open"}</td>
                    <td>{p.params.window_days}-day window; sale {p.params.sale_refundable ? "refundable" : "final"}; {p.params.proof === "receipt" ? "receipt required" : "receipt or order no."}{p.params.defective_window_days ? `; defective ${p.params.defective_window_days} days` : ""}</td>
                    <td><details><summary className="mono">{p.provisions.map((x) => x.code).join(" · ") || "—"}</summary><div className="excerpt">{p.text}</div><span className="faint mono">sha256 {p.sha256.slice(0, 16)}…</span></details></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <details className="disclose" style={{ marginTop: ".75rem" }}>
            <summary>Add a policy version (paste text)</summary>
            <form action={addPolicyAction}>
              <input type="hidden" name="incidentId" value={id} />
              <input type="hidden" name="timezone" value={tz} />
              <div className="grid cols-3">
                <div className="field"><label htmlFor="p-version">Version label</label><input id="p-version" name="version" required /></div>
                <div className="field"><label htmlFor="p-role">Role</label>
                  <select id="p-role" name="role"><option value="authoritative">Authoritative (in force)</option><option value="incorrect_used">Outdated — used by the AI</option><option value="introduced_after">Introduced after incident</option></select></div>
                <div className="field"><label htmlFor="p-key">Policy key</label><input id="p-key" name="policy_key" defaultValue="refund" /></div>
                <div className="field"><label htmlFor="p-from">Effective from ({tz})</label><input id="p-from" name="effective_from" type="date" required /></div>
                <div className="field"><label htmlFor="p-to">Effective to (exclusive, optional)</label><input id="p-to" name="effective_to" type="date" /></div>
                <div className="field"><label htmlFor="p-window">Refund window (days)</label><input id="p-window" name="window_days" type="number" min={0} required /></div>
                <div className="field"><label htmlFor="p-proof">Proof of purchase</label><select id="p-proof" name="proof"><option value="receipt_or_order">Receipt or order number</option><option value="receipt">Original receipt required</option></select></div>
                <div className="field"><label htmlFor="p-def">Defective-item window (days, optional)</label><input id="p-def" name="defective_window_days" type="number" min={0} /></div>
                <div className="field"><label className="check" style={{ marginTop: "1.6rem" }}><input type="checkbox" name="sale_refundable" /> Sale items refundable</label></div>
              </div>
              <div className="field"><label htmlFor="p-text">Policy text</label><textarea id="p-text" name="text" className="tall" required placeholder="[RW] Refund window: …&#10;[SALE] …" /><div className="hint">Lines beginning with a bracketed code such as [RW] become citable provisions. Pasted text is stored as data and never interpreted as instructions.</div></div>
              <button className="btn primary" type="submit">Add policy version</button>
            </form>
          </details>
        </Card>
        <Card title="Known gaps in available records" id="gaps">
          <ul>{inc!.known_gaps.map((g, i) => <li key={i}>{g}</li>)}</ul>
          <form action={addGapAction} className="row" style={{ alignItems: "flex-end" }}>
            <input type="hidden" name="incidentId" value={id} />
            <div style={{ flex: 1 }}><label htmlFor="gap">Record another gap</label><input id="gap" name="gap" required minLength={5} /></div>
            <button className="btn" type="submit">Add gap</button>
          </form>
          <p className="hint">Gaps are appended, never removed, and appear in the exported report.</p>
        </Card>
      </div>
    );
  }

  function Evidence({ id, canImport, roleLabel }: { id: string; canImport: boolean; roleLabel: string }) {
    const batches = listBatches(db, id);
    return (
      <div className="grid cols-side">
        <div className="stack">
          <Card title="Import evidence" id="import">
            {!canImport && <div className="alert warn"><p>Your current role ({roleLabel}) cannot import evidence.</p></div>}
            <div className="alert info"><p>Imported text is treated as <strong>untrusted data</strong>. Instruction-like content (for example, “ignore previous instructions”) is flagged for reviewers and never acted on.</p></div>
            <ImportForm incidentId={id} disabled={!canImport} />
          </Card>
          <Card title="Import history" id="batches" flush>
            {batches.length === 0 ? <Empty>No evidence imported yet.</Empty> : (
              <div className="table-wrap"><table>
                <thead><tr><th>Batch</th><th>Type</th><th>File</th><th className="num">Records</th><th className="num">Flagged</th><th>SHA-256</th><th>Imported</th></tr></thead>
                <tbody>{batches.map((b) => (
                  <tr key={b.id}><td className="mono">{b.id}</td><td>{b.kind}</td><td>{b.filename} <span className="faint">({b.format})</span></td><td className="num">{b.record_count}</td>
                    <td className="num">{b.flagged_count ? <Badge tone="warn">{b.flagged_count}</Badge> : 0}</td><td className="mono faint" title={b.sha256}>{b.sha256.slice(0, 12)}…</td>
                    <td><When iso={b.imported_at} tz={tz} /><br /><span className="faint">{actorName(b.imported_by)}</span></td></tr>
                ))}</tbody>
              </table></div>
            )}
          </Card>
        </div>
        <Card title="Sample files" id="samples">
          <p className="hint">Synthetic files used by the seeded demo. Download, inspect, or re-import into a new incident. Identical files are refused as duplicates.</p>
          <ul style={{ paddingLeft: "1rem" }}>{SAMPLES.map(([f, l]) => <li key={f}><a href={`/api/samples/${f}`} download>{f}</a><br /><span className="hint">{l}</span></li>)}</ul>
          <h3 style={{ marginTop: "1rem" }}>Required fields</h3>
          <dl className="kv" style={{ gridTemplateColumns: "110px 1fr", fontSize: ".8rem" }}>
            <dt>Conversations</dt><dd><code>conversation_id, customer_id, messages[seq, role, timestamp, text]</code>; optional <code>channel, app_version, order_id, started_at</code>. CSV: one row per message with <code>message_seq</code>.</dd>
            <dt>Transactions</dt><dd><code>transaction_id, customer_id, order_id, type, amount, currency, timestamp, status</code>; optional <code>item_category, sale_item, defective</code>.</dd>
            <dt>Interactions</dt><dd><code>interaction_id, customer_id, timestamp, channel, outcome, summary</code>; optional <code>order_id</code>.</dd>
          </dl>
          <p className="hint">Timestamps must be ISO-8601 with an offset. Columns that look like evaluation labels (e.g. <code>ground_truth</code>, <code>expected_*</code>) are refused.</p>
        </Card>
      </div>
    );
  }

  function Investigation({ id, filter, canRun }: { id: string; filter: string; canRun: boolean }) {
    const run = latestRun(db, id);
    const live = liveProviderConfigured();
    const where = { candidates: "f.is_candidate = 1", exposed: "f.exposure = 'exposed' AND f.is_candidate = 1", excluded: "f.is_candidate = 0", flagged: "f.flags != '[]'", all: "1=1" }[filter] ?? "f.is_candidate = 1";
    const rows = run ? (db.prepare(`SELECT f.*, c.customer_id, c.started_at, c.app_version, c.channel, (SELECT case_id FROM case_conversations WHERE conversation_id = f.conversation_id) AS case_id
      FROM findings f JOIN conversations c ON c.id = f.conversation_id WHERE f.run_id = ? AND ${where} ORDER BY c.started_at`).all(run.id) as Record<string, string | number | null>[]) : [];
    const stats = run ? parseJson<Record<string, number>>(run.stats, {}) : {};
    return (
      <div className="stack">
        <Card title="Run analysis" id="run">
          <p>Scope screening (dates, versions, exclusions, topic) is always deterministic. Assessment of each candidate uses: {live ? <Badge tone="info">Live model (server-side)</Badge> : <Badge tone="sim">Demo analyzer (rules-based) {DEMO_ANALYZER_VERSION}</Badge>}.</p>
          <p className="hint">Every finding must cite evidence that exists in this incident&apos;s evidence store; outputs citing unsupported references are rejected. Re-running updates suggestions but never overwrites reviewer determinations.</p>
          <form action={runAnalysisAction}><input type="hidden" name="incidentId" value={id} /><button className="btn primary" type="submit" disabled={!canRun}>Run analysis</button>{!canRun && <span className="hint"> Only an AI governance lead can run analysis.</span>}</form>
        </Card>
        {run ? (
          <Card title="Latest run results" id="results" actions={<AnalyzerBadge isLive={run.is_live} id={run.analyzer_id} version={run.analyzer_version} model={run.model} />} flush>
            <div className="card-b" style={{ borderBottom: "1px solid var(--border)" }}>
              <p className="muted" style={{ margin: 0 }}>{run.id} · {stats.conversations} conversations screened · {stats.inScope} in scope · {stats.candidates} candidates · {stats.exposed} with incorrect information · {stats.rejectedOutputs} rejected outputs · {stats.flaggedUntrusted} with instruction-like text</p>
              <nav className="row" style={{ marginTop: ".5rem" }} aria-label="Filter findings">
                {[["candidates", "Candidates"], ["exposed", "Incorrect information"], ["excluded", "Excluded / not candidates"], ["flagged", "Flagged"], ["all", "All"]].map(([k, l]) => (
                  <Link key={k} className={`btn small${filter === k ? " primary" : ""}`} href={`/incidents/${id}?tab=investigation&f=${k}`} aria-current={filter === k ? "page" : undefined}>{l}</Link>
                ))}
              </nav>
            </div>
            <div className="table-wrap"><table>
              <caption>{rows.length} conversation(s)</caption>
              <thead><tr><th>Conversation</th><th>Started</th><th>Version</th><th>Why matched / excluded</th><th>Exposure</th><th>Suggested impact</th><th>Case</th></tr></thead>
              <tbody>{rows.map((r) => {
                const reasons = parseJson<ScopeReason[]>(r.scope_reasons as string, []);
                const flags = parseJson<string[]>(r.flags as string, []);
                return (
                  <tr key={r.id as string}>
                    <td className="mono">{r.conversation_id}<br /><span className="faint">{r.customer_id}</span></td>
                    <td><When iso={r.started_at as string} tz={tz} /></td>
                    <td>{r.app_version ? <code>{r.app_version}</code> : <Badge tone="warn">not recorded</Badge>}</td>
                    <td style={{ maxWidth: 360 }}>
                      <ul style={{ margin: 0, paddingLeft: "1rem", fontSize: ".8rem" }}>{reasons.map((x, i) => <li key={i} className={x.kind === "exclude" ? "muted" : ""}>{x.kind === "exclude" ? "✕ " : x.kind === "gap" ? "△ " : "✓ "}{x.text}</li>)}</ul>
                      {flags.includes("instruction_like_text") && <Badge tone="warn">Instruction-like text</Badge>} {flags.includes("analysis_output_rejected") && <Badge tone="bad">Output rejected</Badge>}
                    </td>
                    <td>{r.is_candidate ? <ExposureBadge exposure={r.exposure as Exposure} /> : <span className="faint">—</span>}</td>
                    <td>{r.is_candidate ? <ImpactBadge impact={r.suggested_impact as Impact} suggested /> : <span className="faint">—</span>}</td>
                    <td>{r.case_id ? <Link href={`/review/${r.case_id}`}>{r.case_id}</Link> : <span className="faint">{r.is_candidate ? "no case (correct advice)" : "—"}</span>}</td>
                  </tr>
                );
              })}</tbody>
            </table></div>
          </Card>
        ) : <Card><Empty>No analysis run yet.</Empty></Card>}
      </div>
    );
  }
}

function Runs({ id, tz }: { id: string; tz: string }) {
  const runs = listRuns(getDb(), id);
  return (
    <Card title="Analysis runs" flush>
      {runs.length === 0 ? <Empty>No runs yet.</Empty> : (
        <div className="table-wrap"><table>
          <thead><tr><th>Run</th><th>Analyzer</th><th>Started</th><th>By</th><th>Results</th></tr></thead>
          <tbody>{runs.map((r) => {
            const s = parseJson<Record<string, number>>(r.stats, {});
            return <tr key={r.id}><td className="mono">{r.id}</td><td><AnalyzerBadge isLive={r.is_live} id={r.analyzer_id} version={r.analyzer_version} model={r.model} /></td><td><When iso={r.started_at} tz={tz} /></td><td>{actorName(r.started_by)}</td>
              <td>{s.candidates} candidates · {s.exposed} exposed · {s.casesCreated} new cases · {s.casesUpdated} updated · {s.rejectedOutputs} rejected</td></tr>;
          })}</tbody>
        </table></div>
      )}
    </Card>
  );
}
