"use client";

import { useActionState } from "react";
import { createIncidentAction } from "@/app/server-actions";

interface Person { id: string; name: string; role: string }

export function IncidentForm({ people, defaultOwner }: { people: Person[]; defaultOwner: string }) {
  const [state, action, pending] = useActionState(createIncidentAction, { error: null as string | null });
  return (
    <form action={action} className="stack" aria-describedby={state.error ? "form-error" : undefined}>
      {state.error && <div className="alert err" role="alert" id="form-error"><p><strong>Not saved: </strong>{state.error}</p></div>}
      <section className="card"><div className="card-h"><h2>What happened</h2></div><div className="card-b">
        <div className="field"><label htmlFor="title">Incident title</label><input id="title" name="title" required minLength={5} /></div>
        <div className="field"><label htmlFor="description">Description</label><textarea id="description" name="description" required /></div>
        <div className="grid cols-2">
          <div className="field"><label htmlFor="ai_system">Affected AI system</label><input id="ai_system" name="ai_system" required /></div>
          <div className="field"><label htmlFor="known_versions">Known versions</label><input id="known_versions" name="known_versions" placeholder="assist-2026.06.1, assist-2026.06.3" /><div className="hint">Comma or line separated. Include fixed versions for reference.</div></div>
        </div>
        <div className="field"><label htmlFor="incorrect_behavior">Incorrect policy or behavior</label><textarea id="incorrect_behavior" name="incorrect_behavior" required /></div>
      </div></section>

      <section className="card"><div className="card-h"><h2>Period</h2></div><div className="card-b">
        <div className="grid cols-3">
          <div className="field"><label htmlFor="start_local">Start (local time)</label><input id="start_local" name="start_local" type="datetime-local" required /></div>
          <div className="field"><label htmlFor="end_local">End (local time, exclusive)</label><input id="end_local" name="end_local" type="datetime-local" required /></div>
          <div className="field"><label htmlFor="timezone">Timezone (IANA)</label><input id="timezone" name="timezone" defaultValue="America/Chicago" required /><div className="hint">Times are stored in UTC and displayed in this zone.</div></div>
        </div>
        <p className="hint">Add the authoritative policy versions and their effective dates on the next screen. Policies introduced after the incident are recorded separately and never used for determinations.</p>
      </div></section>

      <section className="card"><div className="card-h"><h2>Scope</h2></div><div className="card-b">
        <div className="grid cols-2">
          <div className="field"><label htmlFor="affected_versions">Affected versions (matching)</label><input id="affected_versions" name="affected_versions" required /></div>
          <div className="field"><label htmlFor="topic_keywords">Topic keywords</label><input id="topic_keywords" name="topic_keywords" defaultValue="refund, return, money back" required /><div className="hint">A conversation is a candidate only if a customer message contains one of these.</div></div>
          <div className="field"><label htmlFor="excluded_customer_prefixes">Excluded customer ID prefixes</label><input id="excluded_customer_prefixes" name="excluded_customer_prefixes" defaultValue="TEST-" /></div>
          <div className="field"><label htmlFor="exclusions">Exclusions (described)</label><textarea id="exclusions" name="exclusions" placeholder="One per line" /></div>
        </div>
        <label className="check"><input type="checkbox" name="include_unknown_versions" defaultChecked /> Include conversations with no recorded version if inside the date window (recorded as a gap)</label>
        <label className="check"><input type="checkbox" name="exclude_without_assistant_messages" defaultChecked /> Exclude conversations with no AI assistant messages</label>
      </div></section>

      <section className="card"><div className="card-h"><h2>Review</h2></div><div className="card-b">
        <div className="field"><label htmlFor="impact_criteria">Criteria for confirmed adverse impact</label><textarea id="impact_criteria" name="impact_criteria" required placeholder="One criterion per line. A reviewer must record every criterion as met to confirm impact." /></div>
        <div className="grid cols-2">
          <div className="field"><label htmlFor="owner">Incident owner</label>
            <select id="owner" name="owner" defaultValue={defaultOwner}>{people.map((p) => <option key={p.id} value={p.id}>{p.name} — {p.role}</option>)}</select></div>
          <fieldset><legend>Reviewers</legend>
            {people.filter((p) => p.role !== "Auditor (read-only)").map((p) => <label key={p.id} className="check"><input type="checkbox" name="reviewers" value={p.id} /> {p.name}</label>)}
          </fieldset>
        </div>
        <div className="field"><label htmlFor="known_gaps">Known gaps in available records</label><textarea id="known_gaps" name="known_gaps" placeholder="One per line, e.g. log outage windows, missing version fields" /></div>
      </div></section>
      <div><button className="btn primary" type="submit" disabled={pending}>{pending ? "Registering…" : "Register incident"}</button></div>
    </form>
  );
}
