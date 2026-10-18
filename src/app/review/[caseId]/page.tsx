import { Fragment } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getDb, parseJson } from "@/lib/db";
import { getCaseDetail, listCases, type CaseDetail } from "@/lib/cases";
import { getIncident, type Incident } from "@/lib/incidents";
import { getPolicy, listPolicies, type PolicyVersion } from "@/lib/policy";
import { resolveRef } from "@/lib/evidence";
import { listActions, allowedTransitions, parseVerification, type ActionRow } from "@/lib/remediation";
import { listAudit } from "@/lib/audit";
import { actorName, can } from "@/lib/actors";
import { currentActor } from "@/lib/session";
import { ACTION_TYPE_LABELS, EXPOSURE_LABELS, IMPACT_LABELS, type Actor, type ActionType } from "@/lib/types";
import { ActionStatusBadge, AnalyzerBadge, Badge, Card, CaseStatusBadge, Empty, ExposureBadge, Flash, ImpactBadge, When, money } from "@/components/ui";
import {
  actionTransition, closeCaseAction, determinationAction, editDraftAction, evidenceReceivedAction, mergeAction,
  noteAction, proposeActionAction, rejectMatchAction, reopenMatchAction, requestEvidenceAction, startReviewAction,
} from "@/app/server-actions";

type Search = Promise<{ ok?: string; err?: string }>;

export default async function CasePage({ params, searchParams }: { params: Promise<{ caseId: string }>; searchParams: Search }) {
  const { caseId } = await params;
  const sp = await searchParams;
  const db = getDb();
  const d = getCaseDetail(db, caseId);
  if (!d) notFound();
  const inc = getIncident(db, d.case.incident_id)!;
  const tz = inc.timezone;
  const actor = await currentActor();
  const c = d.case;
  const f = d.finding;
  const policies = listPolicies(db, inc.id);
  const applicable = f?.applicable_policy_id ? getPolicy(db, f.applicable_policy_id) : null;
  const outdated = policies.find((p) => p.role === "incorrect_used") ?? null;
  const later = policies.filter((p) => p.role === "introduced_after");
  const actions = listActions(db, { caseId });
  const siblings = listCases(db, inc.id).filter((x) => x.customer_id === c.customer_id && x.id !== c.id && x.status !== "match_rejected");
  const canReview = can(actor, "case.review");
  const interactionFlags = d.interactions.filter((i) => i.flags.length);
  const msgFlags = d.conversations.some((cv) => cv.messages.some((m) => m.flags.length));

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <p className="muted" style={{ margin: 0 }}><Link href="/review">Review queue</Link> / {inc.id}</p>
          <h1 className="mono">{c.id}</h1>
          <div className="row">
            <span>Customer <strong className="mono">{c.customer_id}</strong></span>
            <span>· Order <strong className="mono">{c.order_id ?? "not identified"}</strong></span>
            <span>· {d.conversations.length} conversation(s)</span>
          </div>
        </div>
        <div className="stack" style={{ textAlign: "right" }}>
          <div className="row" style={{ justifyContent: "flex-end" }}>
            <span className="muted">Workflow</span> <CaseStatusBadge status={c.status} />
          </div>
          <div className="row" style={{ justifyContent: "flex-end" }}>
            <span className="muted">Classification</span> <ExposureBadge exposure={c.exposure} /> {c.decided_by ? <ImpactBadge impact={c.impact} /> : <ImpactBadge impact={c.suggested_impact} suggested />}
          </div>
        </div>
      </div>
      <Flash ok={sp.ok} err={sp.err} />
      {c.status === "merged" && <div className="alert info"><p>This case was merged into <Link href={`/review/${c.merged_into}`}>{c.merged_into}</Link>. Its history is kept below.</p></div>}
      {d.mergedFrom.length > 0 && <div className="alert info"><p>Includes conversations merged from {d.mergedFrom.map((m) => <Link key={m} href={`/review/${m}`} style={{ marginRight: 6 }}>{m}</Link>)}.</p></div>}
      {c.possible_duplicate_of && <div className="alert warn"><p>Possible duplicate of <Link href={`/review/${c.possible_duplicate_of}`}>{c.possible_duplicate_of}</Link> (same customer and order). Merging is a reviewer decision.</p></div>}
      {(msgFlags || interactionFlags.length > 0) && (
        <div className="alert warn" role="note"><p><strong>Instruction-like text found in imported evidence.</strong> It is shown verbatim and highlighted below. It is treated as data and has no effect on analysis, classification, or actions.</p></div>
      )}
      {c.status === "unreviewed" && canReview && (
        <form action={startReviewAction}><input type="hidden" name="caseId" value={c.id} /><button className="btn primary" type="submit">Start review</button></form>
      )}

      <div className="grid cols-side">
        <div className="stack">
          <Finding d={d} applicable={applicable} outdated={outdated} later={later} tz={tz} />
          <Timeline d={d} tz={tz} actions={actions} />
          <Conversations d={d} tz={tz} />
          <Records d={d} tz={tz} />
          <Card title="Corrective actions" id="actions">
            {actions.length === 0 ? <Empty>No corrective actions yet.</Empty> : actions.map((a) => <ActionCard key={a.id} a={a} d={d} actor={actor} tz={tz} />)}
          </Card>
          <History d={d} tz={tz} />
        </div>
        <aside className="stack" aria-label="Review controls">
          <ReviewPanel d={d} inc={inc} actor={actor} siblings={siblings.map((s) => s.id)} />
          <ProposePanel d={d} actor={actor} />
        </aside>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function Finding({ d, applicable, outdated, later, tz }: { d: CaseDetail; applicable: PolicyVersion | null; outdated: PolicyVersion | null; later: PolicyVersion[]; tz: string }) {
  const f = d.finding;
  if (!f) return <Card title="Suggested finding"><Empty>No finding recorded.</Empty></Card>;
  const db = getDb();
  const cited = f.supporting.map((s) => ({ ...s, r: resolveRef(db, s.ref) }));
  const assistantMsgs = cited.filter((x) => x.r?.kind === "msg" && /assistant/.test(x.r.label));
  const codes = [...new Set(f.provisions.map((p) => p.code))];
  const provText = (p: PolicyVersion | null, code: string) => p?.provisions.find((x) => x.code === code)?.text;
  return (
    <Card title="Suggested finding" id="finding" actions={<AnalyzerBadge isLive={f.is_live} id={f.analyzer_id} version={f.analyzer_version} model={f.model} />}>
      <p className="hint">Run {f.run_id}. A suggestion explains the evidence; it is not a determination. No confidence score is given because none would be calibrated.</p>
      <div className="row" style={{ marginBottom: ".5rem" }}><ExposureBadge exposure={f.exposure} /><ImpactBadge impact={f.suggested_impact} suggested /></div>
      <p>{f.explanation}</p>

      <h3>Why this interaction matched</h3>
      <ul style={{ fontSize: ".86rem" }}>{f.scope_reasons.map((r, i) => <li key={i}>{r.kind === "exclude" ? "✕ " : r.kind === "gap" ? "△ " : "✓ "}{r.text}</li>)}</ul>

      {codes.length > 0 && (
        <>
          <h3>Incorrect response and applicable policy</h3>
          <div className="compare">
            <div className="wrong">
              <h4>What the assistant said</h4>
              {assistantMsgs.length === 0 ? <p className="muted">No assistant message cited.</p> : assistantMsgs.map((m) => (
                <div key={m.ref}><span className="ref mono">{m.ref}</span> <When iso={m.r!.ts} tz={tz} /><div className="excerpt">{m.r!.excerpt}</div></div>
              ))}
              {outdated && <p className="hint">Matches outdated {outdated.version}: {codes.map((code) => provText(outdated, code)).filter(Boolean).join(" ")}</p>}
            </div>
            <div className="right">
              <h4>Policy in force at the time{applicable ? ` — ${applicable.version}` : ""}</h4>
              {applicable ? (
                <>
                  <p className="hint">Effective <When iso={applicable.effective_from} tz={tz} date /> to {applicable.effective_to ? <When iso={applicable.effective_to} tz={tz} date /> : "open"}</p>
                  {[...codes, ...(codes.includes("RW") && applicable.params.defective_window_days ? ["DEF"] : [])].map((code) => (
                    <div key={code}><span className="ref mono">pol:{applicable.id}#{code}</span><div className="excerpt">{provText(applicable, code) ?? "(no matching provision)"}</div></div>
                  ))}
                </>
              ) : <p className="muted">No authoritative policy registered for this date.</p>}
              {later.length > 0 && <p className="hint">Not used: {later.map((p) => p.version).join(", ")} (introduced after the incident).</p>}
            </div>
          </div>
          <div className="table-wrap" style={{ marginTop: ".5rem" }}>
            <table><thead><tr><th>Provision</th><th>Incorrect statement</th><th>Applicable rule</th></tr></thead>
              <tbody>{f.provisions.map((p, i) => <tr key={i}><td className="mono">{p.code}</td><td>{p.incorrect_statement}</td><td>{p.applicable_rule}</td></tr>)}</tbody></table>
          </div>
        </>
      )}

      <h3 style={{ marginTop: "1rem" }}>Supporting evidence</h3>
      {cited.map((s) => (
        <div className="evidence" key={s.ref}>
          <div className="row between"><span className="ref">{s.ref}</span>{s.r ? <span className="faint" style={{ fontSize: ".75rem" }}>{s.r.label}{s.r.ts ? " · " : ""}{s.r.ts && <When iso={s.r.ts} tz={tz} />}</span> : <Badge tone="bad">Reference not found</Badge>}</div>
          <div style={{ fontSize: ".84rem" }}>{s.note}</div>
          {s.r && s.r.kind !== "conv" && <div className={`excerpt${s.r.flags.length ? " flagged" : ""}`}>{s.r.excerpt}</div>}
        </div>
      ))}

      <div className="grid cols-2" style={{ marginTop: "1rem" }}>
        <div>
          <h3>Missing information</h3>
          {f.gaps.length ? <ul style={{ fontSize: ".86rem" }}>{f.gaps.map((g, i) => <li key={i}>{g}</li>)}</ul> : <p className="muted">None identified by the analyzer.</p>}
        </div>
        <div>
          <h3>Conflicting evidence</h3>
          {f.conflicts.length ? <ul style={{ fontSize: ".86rem" }}>{f.conflicts.map((x, i) => <li key={i}>{x.text} <span className="mono faint">{x.refs.join(", ")}</span></li>)}</ul> : <p className="muted">None identified by the analyzer.</p>}
        </div>
      </div>
      {Object.keys(f.facts).length > 0 && (
        <details className="disclose"><summary>Derived facts (deterministic)</summary>
          <dl className="kv" style={{ fontSize: ".82rem" }}>{Object.entries(f.facts).map(([k, v]) => <Fragment key={k}><dt>{k}</dt><dd className="mono">{k.endsWith("_cents") && typeof v === "number" ? money(v) : String(v)}</dd></Fragment>)}</dl>
        </details>
      )}
    </Card>
  );
}

function Timeline({ d, tz, actions }: { d: CaseDetail; tz: string; actions: ActionRow[] }) {
  type Ev = { ts: string; text: string; k: string; ref?: string };
  const evs: Ev[] = [];
  const orderTx = d.transactions.filter((t) => !d.case.order_id || t.order_id === d.case.order_id);
  for (const t of orderTx) evs.push({ ts: t.ts, k: t.type === "purchase" ? "" : t.type === "refund" ? "k-ok" : t.type.includes("fail") || t.type.includes("reversal") ? "k-bad" : "", text: `${t.type.replace("_", " ")} ${money(t.amount_cents, t.currency)} (${t.status})`, ref: `txn:${t.id}` });
  for (const cv of d.conversations) {
    evs.push({ ts: cv.started_at, k: "k-info", text: `Conversation on ${cv.channel}, version ${cv.app_version ?? "not recorded"}`, ref: `conv:${cv.id}` });
  }
  for (const i of d.interactions) evs.push({ ts: i.ts, k: i.outcome.includes("not_received") || i.outcome === "complaint" ? "k-warn" : "", text: `${i.channel}: ${i.outcome.replace(/_/g, " ")}`, ref: `int:${i.id}` });
  evs.push({ ts: d.case.created_at, k: "k-info", text: "Case opened by analysis" });
  for (const x of d.decisions) evs.push({ ts: x.ts, k: "k-info", text: `${actorName(x.actor)}: ${x.kind.replace(/_/g, " ")}` });
  for (const a of actions) {
    for (const r of listAudit(getDb(), { entityType: "corrective_action", entityId: a.id })) {
      evs.push({ ts: r.ts, k: r.action.includes("verified") ? "k-ok" : r.action.includes("failed") || r.action.includes("reopened") ? "k-bad" : "", text: `${a.id}: ${r.action.replace("action.", "").replace(/_/g, " ")} by ${actorName(r.actor)}` });
    }
  }
  evs.sort((a, b) => a.ts.localeCompare(b.ts));
  return (
    <Card title="Timeline" id="timeline">
      <ol className="timeline">{evs.map((e, i) => <li key={i} className={e.k}><div className="when"><When iso={e.ts} tz={tz} />{e.ref && <span className="mono"> · {e.ref}</span>}</div>{e.text}</li>)}</ol>
    </Card>
  );
}

function Conversations({ d, tz }: { d: CaseDetail; tz: string }) {
  return (
    <Card title="Conversations" id="conversations">
      {d.conversations.map((cv) => (
        <div key={cv.id} style={{ marginBottom: "1rem" }}>
          <div className="row between" style={{ marginBottom: ".4rem" }}>
            <strong className="mono">{cv.id}</strong>
            <span className="muted" style={{ fontSize: ".8rem" }}>{cv.channel} · {cv.app_version ? <code>{cv.app_version}</code> : <Badge tone="warn">version not recorded</Badge>} · <When iso={cv.started_at} tz={tz} /></span>
          </div>
          <div className="transcript">
            {cv.messages.map((m) => (
              <div key={m.id} className={`msg ${m.role}${m.flags.length ? " flagged" : ""}`}>
                <div className="meta"><strong>{m.role}</strong><span className="mono">msg:{m.id}</span><When iso={m.ts} tz={tz} />{m.flags.length > 0 && <Badge tone="warn">Instruction-like text — treated as data</Badge>}</div>
                <div className="text">{m.text}</div>
              </div>
            ))}
          </div>
        </div>
      ))}
    </Card>
  );
}

function Records({ d, tz }: { d: CaseDetail; tz: string }) {
  return (
    <Card title="Linked transactions and later interactions" id="records" flush>
      <div className="table-wrap"><table>
        <caption>All transactions for this customer in the evidence store</caption>
        <thead><tr><th>Reference</th><th>When</th><th>Type</th><th>Order</th><th className="num">Amount</th><th>Status</th><th>Attributes</th></tr></thead>
        <tbody>{d.transactions.length === 0 ? <tr><td colSpan={7} className="muted">No transactions found for this customer.</td></tr> : d.transactions.map((t) => (
          <tr key={t.id}><td className="mono">txn:{t.id}</td><td><When iso={t.ts} tz={tz} /></td><td>{t.type.replace("_", " ")}</td><td className="mono">{t.order_id}</td><td className="num">{money(t.amount_cents, t.currency)}</td><td>{t.status}</td>
            <td style={{ fontSize: ".78rem" }}>{t.item_category ?? ""}{t.sale_item === 1 ? " · sale item" : ""}{t.defective === 1 ? " · defective" : ""}{t.type === "purchase" && t.sale_item == null ? " · sale status unknown" : ""}</td></tr>
        ))}</tbody>
      </table></div>
      <div className="table-wrap"><table>
        <caption>Later interactions</caption>
        <thead><tr><th>Reference</th><th>When</th><th>Channel</th><th>Outcome</th><th>Summary</th></tr></thead>
        <tbody>{d.interactions.length === 0 ? <tr><td colSpan={5} className="muted">No later interactions found.</td></tr> : d.interactions.map((i) => (
          <tr key={i.id}><td className="mono">int:{i.id}</td><td><When iso={i.ts} tz={tz} /></td><td>{i.channel}</td><td>{i.outcome.replace(/_/g, " ")}</td>
            <td>{i.flags.length > 0 && <><Badge tone="warn">Instruction-like text — treated as data</Badge><br /></>}<span style={{ whiteSpace: "pre-wrap" }}>{i.summary}</span></td></tr>
        ))}</tbody>
      </table></div>
    </Card>
  );
}

const STEPS = ["draft", "under_review", "approved", "execution_recorded", "verified_complete"] as const;
const STEP_LABEL = { draft: "Draft", under_review: "Under review", approved: "Approved", execution_recorded: "Execution recorded", verified_complete: "Verified complete" };

function ActionCard({ a, d, actor, tz }: { a: ActionRow; d: CaseDetail; actor: Actor; tz: string }) {
  const allowed = allowedTransitions(a);
  const idx = STEPS.indexOf(a.status as (typeof STEPS)[number]);
  const v = parseVerification(a);
  const editable = ["draft", "needs_evidence", "reopened"].includes(a.status);
  const ids = <><input type="hidden" name="actionId" value={a.id} /><input type="hidden" name="caseId" value={d.case.id} /></>;
  const hidden = (op: string) => <>{ids}<input type="hidden" name="op" value={op} /></>;
  const candidates = d.transactions.filter((t) => t.type === "refund" && (!d.case.order_id || t.order_id === d.case.order_id) && (!a.approved_at || t.ts >= a.approved_at));
  const history = listAudit(getDb(), { entityType: "corrective_action", entityId: a.id }).reverse();
  const steps = a.type === "no_action" ? STEPS.slice(0, 3) : STEPS;

  return (
    <article id={a.id} className="card" style={{ marginBottom: "1rem" }} aria-labelledby={`${a.id}-h`}>
      <div className="card-h">
        <h3 id={`${a.id}-h`}><span className="mono">{a.id}</span> · {ACTION_TYPE_LABELS[a.type]}</h3>
        <ActionStatusBadge status={a.status} simulated={a.execution_mode === "simulated"} />
      </div>
      <div className="card-b">
        <ol className="stepper" aria-label="Lifecycle">
          {steps.map((s, i) => <li key={s} className={idx === i ? "current" : idx > i ? "done" : ""} aria-current={idx === i ? "step" : undefined}>{STEP_LABEL[s]}</li>)}
        </ol>
        {idx < 0 && <p className="hint">Current state is outside the main path: <strong>{a.status.replace(/_/g, " ")}</strong>{a.failure_reason ? ` — ${a.failure_reason}` : ""}.</p>}
        {a.status === "approved" && a.type !== "no_action" && <div className="alert warn"><p>Approved, but no execution has been recorded. Approval is not execution.</p></div>}
        {a.status === "execution_recorded" && <div className="alert info"><p>Execution recorded but not verified. Completion evidence is required.</p></div>}
        {a.execution_mode === "simulated" && <div className="alert sim"><p><strong>Simulated.</strong> This execution was simulated for demonstration. No refund, message or record change happened. It is excluded from verified totals.</p></div>}
        <dl className="kv" style={{ fontSize: ".85rem" }}>
          <dt>Summary</dt><dd>{a.summary}</dd>
          <dt>Justification</dt><dd>{a.justification}</dd>
          {a.type === "refund_review" && <><dt>Proposed amount</dt><dd className="mono">{money(a.proposed_amount_cents)}</dd></>}
          <dt>Drafted</dt><dd>{actorName(a.created_by)} · <When iso={a.created_at} tz={tz} /></dd>
          {a.approved_by && <><dt>Approved</dt><dd>{actorName(a.approved_by)} · <When iso={a.approved_at} tz={tz} /></dd></>}
          {a.executed_by && <><dt>Execution</dt><dd>{a.execution_mode === "simulated" ? <Badge tone="sim">Simulated</Badge> : "Recorded"} by {actorName(a.executed_by)} · <When iso={a.executed_at} tz={tz} /> · ref <code>{a.execution_reference}</code>{a.execution_note ? ` — ${a.execution_note}` : ""}</dd></>}
          {v && <><dt>Completion evidence</dt><dd>{v.label} <code>{v.ref}</code>{v.amount_cents != null ? ` · ${money(v.amount_cents)}` : ""}{v.note ? ` — ${v.note}` : ""}<br /><span className="faint">Verified by {actorName(a.verified_by)} · <When iso={a.verified_at} tz={tz} /></span></dd></>}
          {a.failure_reason && <><dt>Failure</dt><dd>{a.failure_reason}</dd></>}
        </dl>

        {a.type !== "no_action" && (
          <details className="disclose" open={editable}>
            <summary>Communication draft <Badge tone="outline">Not sent</Badge></summary>
            {editable && can(actor, "action.propose") ? (
              <form action={editDraftAction}>
                <input type="hidden" name="actionId" value={a.id} /><input type="hidden" name="caseId" value={d.case.id} />
                <input type="hidden" name="summary" value={a.summary} /><input type="hidden" name="justification" value={a.justification} />
                <label htmlFor={`${a.id}-comm`} className="sr-only">Communication draft</label>
                <textarea id={`${a.id}-comm`} name="communication" className="tall" defaultValue={a.communication_draft ?? ""} />
                {a.type === "refund_review" && <div className="field"><label htmlFor={`${a.id}-amt`}>Proposed amount (USD)</label><input id={`${a.id}-amt`} name="amount" type="number" step="0.01" min="0.01" defaultValue={a.proposed_amount_cents ? (a.proposed_amount_cents / 100).toFixed(2) : ""} /></div>}
                <button className="btn small" type="submit">Save draft</button> <span className="hint">Decision Repair never sends this. Staff send approved text through normal channels.</span>
              </form>
            ) : <div className="excerpt">{a.communication_draft ?? "—"}</div>}
          </details>
        )}

        <div className="stack" style={{ marginTop: ".75rem" }}>
          {allowed.includes("submit") && can(actor, "action.propose") && (
            <form action={actionTransition}>{hidden("submit")}<button className="btn primary" type="submit">Submit for review</button></form>
          )}
          {allowed.includes("approve") && can(actor, "action.approve") && (
            <form action={actionTransition} className="stack">
              {ids}
              <div className="field" style={{ margin: 0 }}><label htmlFor={`${a.id}-r`}>Decision note or reason</label><textarea id={`${a.id}-r`} name="reason" placeholder="Required for rejection or evidence requests" /></div>
              <div className="row">
                <button className="btn primary" type="submit" name="op" value="approve">Approve</button>
                <button className="btn" type="submit" name="op" value="request_evidence">Request evidence</button>
                <button className="btn danger" type="submit" name="op" value="reject">Reject</button>
              </div>
              {a.created_by === actor.id && <p className="hint">You drafted this action, so approval by you will be refused (separation of duties).</p>}
            </form>
          )}
          {allowed.includes("record_execution") && can(actor, "action.execute") && (
            <form action={actionTransition} className="stack">
              {ids}
              <div className="grid cols-2">
                <div className="field" style={{ margin: 0 }}><label htmlFor={`${a.id}-ref`}>External reference</label><input id={`${a.id}-ref`} name="reference" placeholder="Payment request, ticket or email ID" /></div>
                <div className="field" style={{ margin: 0 }}><label htmlFor={`${a.id}-note`}>Note</label><input id={`${a.id}-note`} name="note" /></div>
              </div>
              <div className="row">
                <button className="btn primary" type="submit" name="op" value="execute">Record execution performed outside this tool</button>
                <button className="btn sim" type="submit" name="op" value="simulate">Simulate execution (demo)</button>
              </div>
              <p className="hint">Recording execution does not perform it. Do the work in the system of record first.</p>
            </form>
          )}
          {allowed.includes("verify") && can(actor, "action.verify") && (
            <form action={actionTransition} className="stack">
              {hidden("verify")}
              <div className="grid cols-2">
                <div className="field" style={{ margin: 0 }}><label htmlFor={`${a.id}-kind`}>Evidence type</label>
                  <select id={`${a.id}-kind`} name="kind" defaultValue={a.execution_mode === "simulated" ? "simulated" : a.type === "refund_review" ? "transaction" : "receipt"}>
                    {a.execution_mode === "simulated" ? <option value="simulated">Simulated receipt</option> : <>
                      <option value="transaction">Imported transaction (txn:…)</option>
                      {a.type !== "refund_review" && <><option value="interaction">Imported interaction (int:…)</option><option value="receipt">External receipt / message ID</option></>}
                    </>}
                  </select></div>
                <div className="field" style={{ margin: 0 }}><label htmlFor={`${a.id}-vref`}>Reference</label><input id={`${a.id}-vref`} name="ref" defaultValue={a.execution_mode === "simulated" ? a.execution_reference ?? "" : ""} /></div>
              </div>
              <div className="field" style={{ margin: 0 }}><label htmlFor={`${a.id}-vnote`}>What the evidence shows</label><input id={`${a.id}-vnote`} name="note" /></div>
              {a.type === "refund_review" && a.execution_mode !== "simulated" && (
                <p className="hint">{candidates.length ? <>Completed refunds for this order after approval: {candidates.map((t) => <code key={t.id} style={{ marginRight: 6 }}>txn:{t.id}</code>)}</> : "No completed refund for this order after approval is in the evidence store yet. Import the remediation ledger first."}</p>
              )}
              <div className="row"><button className="btn primary" type="submit">Verify complete</button>
                {a.executed_by === actor.id && <span className="hint">You recorded execution, so your verification will be refused.</span>}</div>
            </form>
          )}
          {allowed.includes("record_failure") && (can(actor, "action.execute") || can(actor, "action.verify")) && (
            <details className="disclose"><summary>Record failure</summary>
              <form action={actionTransition} className="stack">{hidden("fail")}
                <div className="field" style={{ margin: 0 }}><label htmlFor={`${a.id}-fr`}>What failed</label><textarea id={`${a.id}-fr`} name="reason" required /></div>
                <div className="field" style={{ margin: 0 }}><label htmlFor={`${a.id}-frefs`}>Evidence references (optional)</label><input id={`${a.id}-frefs`} name="refs" placeholder="txn:… int:…" /></div>
                <button className="btn danger" type="submit">Record failure</button>
              </form>
            </details>
          )}
          {allowed.includes("reopen") && can(actor, "action.propose") && (
            <form action={actionTransition} className="row" style={{ alignItems: "flex-end" }}>{hidden("reopen")}
              <div style={{ flex: 1 }}><label htmlFor={`${a.id}-ro`}>Reason to reopen</label><input id={`${a.id}-ro`} name="reason" required /></div>
              <button className="btn" type="submit">Reopen</button>
            </form>
          )}
        </div>

        <details className="disclose" style={{ marginTop: ".5rem" }}><summary>Action history ({history.length})</summary>
          <ul style={{ fontSize: ".8rem", margin: 0 }}>{history.map((h) => <li key={h.seq}><When iso={h.ts} tz={tz} /> — {actorName(h.actor)}: <code>{h.action}</code>{h.reason ? ` — ${h.reason}` : ""}</li>)}</ul>
        </details>
      </div>
    </article>
  );
}

function History({ d, tz }: { d: CaseDetail; tz: string }) {
  return (
    <Card title="Reviewer notes and decision history" id="history" flush>
      {d.decisions.length === 0 ? <Empty>No decisions yet.</Empty> : (
        <div className="table-wrap"><table>
          <thead><tr><th>When</th><th>Reviewer</th><th>Decision</th><th>Change</th><th>Reason / note</th><th>Evidence</th></tr></thead>
          <tbody>{d.decisions.map((x) => {
            const from = parseJson<Record<string, unknown> | null>(x.from_value, null), to = parseJson<Record<string, unknown> | null>(x.to_value, null);
            return (
              <tr key={x.id}>
                <td><When iso={x.ts} tz={tz} /></td><td>{actorName(x.actor)}</td>
                <td>{x.kind === "override" ? <Badge tone="warn">Override</Badge> : x.kind === "confirm_impact" ? <Badge tone="bad">Confirm impact</Badge> : x.kind.replace(/_/g, " ")}</td>
                <td style={{ fontSize: ".78rem" }}>{from?.impact ? `${IMPACT_LABELS[from.impact as keyof typeof IMPACT_LABELS] ?? from.impact} → ` : ""}{to?.impact ? IMPACT_LABELS[to.impact as keyof typeof IMPACT_LABELS] : to?.status ? String(to.status).replace(/_/g, " ") : ""}
                  {Array.isArray(to?.criteria_met) && (to!.criteria_met as string[]).length > 0 ? ` (criteria ${(to!.criteria_met as string[]).join(", ")})` : ""}</td>
                <td>{x.reason ?? ""}</td><td className="mono" style={{ fontSize: ".75rem" }}>{x.evidence_refs.join(" ")}</td>
              </tr>
            );
          })}</tbody>
        </table></div>
      )}
    </Card>
  );
}

function ReviewPanel({ d, inc, actor, siblings }: { d: CaseDetail; inc: Incident; actor: Actor; siblings: string[] }) {
  const c = d.case;
  if (!can(actor, "case.review")) return <Card title="Review"><p className="muted">Your current role cannot record review decisions. Switch to a case reviewer or governance lead.</p></Card>;
  if (c.status === "merged") return null;
  const hid = <input type="hidden" name="caseId" value={c.id} />;
  return (
    <Card title="Review" id="review">
      {c.status === "match_rejected" ? (
        <form action={reopenMatchAction} className="stack">{hid}
          <p>This match was rejected.</p>
          <div className="field"><label htmlFor="rm">Reason to reopen</label><textarea id="rm" name="reason" required /></div>
          <button className="btn" type="submit">Reopen match</button>
        </form>
      ) : (
        <>
          <form action={determinationAction} className="stack">{hid}
            <h3>Record determination</h3>
            <p className="hint">Suggested: {EXPOSURE_LABELS[c.exposure]}; {IMPACT_LABELS[c.suggested_impact]}. Any change is an override and needs a reason.</p>
            <div className="field" style={{ margin: 0 }}><label htmlFor="exposure">Exposure</label>
              <select id="exposure" name="exposure" defaultValue={c.exposure}>
                <option value="exposed">{EXPOSURE_LABELS.exposed}</option><option value="not_exposed">{EXPOSURE_LABELS.not_exposed}</option><option value="undetermined">{EXPOSURE_LABELS.undetermined}</option>
              </select></div>
            <div className="field" style={{ margin: 0 }}><label htmlFor="impact">Impact</label>
              <select id="impact" name="impact" defaultValue={c.decided_by ? c.impact : c.suggested_impact === "not_assessed" ? "insufficient_evidence" : c.suggested_impact}>
                {(["possible", "confirmed", "none_found", "insufficient_evidence"] as const).map((k) => <option key={k} value={k}>{IMPACT_LABELS[k]}{k === c.suggested_impact ? " (suggested)" : ""}</option>)}
              </select></div>
            <fieldset><legend>Criteria met (required for confirmed)</legend>
              {inc.impact_criteria.map((k) => <label key={k.id} className="check"><input type="checkbox" name="criteria" value={k.id} defaultChecked={d.criteriaMet.includes(k.id)} /> <span><strong>{k.id}</strong> {k.text}</span></label>)}
            </fieldset>
            <div className="field" style={{ margin: 0 }}><label htmlFor="reason">Reason</label><textarea id="reason" name="reason" placeholder="Required for overrides and confirmations" /></div>
            <div className="field" style={{ margin: 0 }}><label htmlFor="drefs">Evidence references (optional)</label><input id="drefs" name="refs" placeholder="txn:… msg:…#2" /><div className="hint">Must exist and belong to this customer.</div></div>
            <button className="btn primary" type="submit">Save determination</button>
          </form>
          <hr />
          {c.status === "needs_evidence" ? (
            <form action={evidenceReceivedAction} className="stack">{hid}
              <h3>Evidence received</h3>
              <div className="field" style={{ margin: 0 }}><label htmlFor="erefs">Imported evidence references</label><input id="erefs" name="refs" required placeholder="txn:… int:…" /></div>
              <div className="field" style={{ margin: 0 }}><label htmlFor="enote">Note</label><input id="enote" name="reason" /></div>
              <button className="btn" type="submit">Link evidence and resume review</button>
            </form>
          ) : (
            <details className="disclose"><summary>Request more evidence</summary>
              <form action={requestEvidenceAction} className="stack">{hid}
                <div className="field" style={{ margin: 0 }}><label htmlFor="rq">What is needed</label><textarea id="rq" name="reason" required /></div>
                <button className="btn" type="submit">Request evidence</button>
              </form>
            </details>
          )}
          <details className="disclose"><summary>Reject this match</summary>
            <form action={rejectMatchAction} className="stack">{hid}
              <div className="field" style={{ margin: 0 }}><label htmlFor="rj">Why this is not an affected interaction</label><textarea id="rj" name="reason" required /></div>
              <button className="btn danger" type="submit">Reject match</button>
            </form>
          </details>
          <details className="disclose"><summary>Merge duplicate case</summary>
            {siblings.length === 0 ? <p className="hint">No other open cases for this customer.</p> : (
              <form action={mergeAction} className="stack">{hid}
                <div className="field" style={{ margin: 0 }}><label htmlFor="mt">Merge this case into</label><select id="mt" name="target">{siblings.map((s) => <option key={s} value={s}>{s}</option>)}</select></div>
                <div className="field" style={{ margin: 0 }}><label htmlFor="mr">Reason</label><textarea id="mr" name="reason" required /></div>
                <button className="btn" type="submit">Merge</button>
              </form>
            )}
          </details>
          {c.status === "reviewed" && (
            <details className="disclose"><summary>Close case</summary>
              <form action={closeCaseAction} className="stack">{hid}
                <p className="hint">Allowed only when every corrective action is verified complete, rejected, or an approved no-action determination.</p>
                <div className="field" style={{ margin: 0 }}><label htmlFor="cl">Closing note</label><input id="cl" name="reason" /></div>
                <button className="btn" type="submit">Close case</button>
              </form>
            </details>
          )}
        </>
      )}
      <hr />
      <form action={noteAction} className="stack">{hid}
        <h3>Add reviewer note</h3>
        <label htmlFor="note" className="sr-only">Note</label>
        <textarea id="note" name="note" required />
        <div className="field" style={{ margin: 0 }}><label htmlFor="nrefs">Evidence references (optional)</label><input id="nrefs" name="refs" /></div>
        <button className="btn" type="submit">Add note</button>
      </form>
    </Card>
  );
}

function ProposePanel({ d, actor }: { d: CaseDetail; actor: Actor }) {
  const c = d.case;
  if (!can(actor, "action.propose") || !["in_review", "reviewed", "needs_evidence"].includes(c.status)) return null;
  const facts = d.finding?.facts ?? {};
  const impact = c.decided_by ? c.impact : c.suggested_impact;
  const owed = typeof facts.purchase_amount_cents === "number" ? Math.max(0, (facts.purchase_amount_cents as number) - ((facts.later_refund_cents as number) ?? 0)) : null;
  let suggested: ActionType = "clarification";
  let why = "Customer received incorrect policy information; a correction keeps their understanding accurate.";
  if ((impact === "possible" || impact === "confirmed") && facts.eligible_under_applicable === true && owed) { suggested = "refund_review"; why = `Eligible under the policy in force with no completed refund recorded. Purchase ${money(facts.purchase_amount_cents as number)}${(facts.later_refund_cents as number) ? `, already refunded ${money(facts.later_refund_cents as number)}` : ""}.`; }
  else if (impact === "insufficient_evidence") { why = "Evidence is insufficient; consider requesting evidence before proposing a remedy, or escalate."; suggested = "escalation"; }
  else if (impact === "none_found") { why = "No adverse impact found; a clarification or a justified no-action determination may be appropriate."; }
  return (
    <Card title="Propose corrective action" id="propose">
      <div className="alert info"><p><strong>Suggested:</strong> {ACTION_TYPE_LABELS[suggested]}. {why}</p><p className="hint">A suggestion only. A remedy needs a reviewer determination and approval by someone other than its author.</p></div>
      <form action={proposeActionAction} className="stack">
        <input type="hidden" name="caseId" value={c.id} />
        <div className="field" style={{ margin: 0 }}><label htmlFor="type">Type</label>
          <select id="type" name="type" defaultValue={suggested}>{Object.entries(ACTION_TYPE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>
        <div className="field" style={{ margin: 0 }}><label htmlFor="summary">Summary</label><input id="summary" name="summary" required defaultValue={suggested === "refund_review" ? "Review and issue refund under policy in force at the time" : ""} /></div>
        <div className="field" style={{ margin: 0 }}><label htmlFor="justification">Justification</label><textarea id="justification" name="justification" required /><div className="hint">At least 20 characters for a no-action determination.</div></div>
        <div className="field" style={{ margin: 0 }}><label htmlFor="amount">Proposed refund amount (USD, refund review only)</label><input id="amount" name="amount" type="number" step="0.01" min="0" defaultValue={suggested === "refund_review" && owed ? (owed / 100).toFixed(2) : ""} /></div>
        <p className="hint">An editable communication draft is generated automatically. It is never sent.</p>
        <button className="btn primary" type="submit">Create draft</button>
      </form>
    </Card>
  );
}
