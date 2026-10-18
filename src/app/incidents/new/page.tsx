import { ACTORS, ROLE_LABELS, can } from "@/lib/actors";
import { currentActor } from "@/lib/session";
import { IncidentForm } from "./IncidentForm";

export default async function NewIncidentPage() {
  const actor = await currentActor();
  return (
    <div className="stack" style={{ maxWidth: 980 }}>
      <div className="page-head"><div>
        <h1>Register incident</h1>
        <p>Define what went wrong and how affected interactions will be identified. Scope criteria drive matching; impact criteria are what a reviewer must establish before confirming adverse impact.</p>
      </div></div>
      {!can(actor, "incident.manage") && <div className="alert warn"><p>You are acting as {actor.name} ({ROLE_LABELS[actor.role]}). Only an AI governance lead can register incidents; the form will be refused.</p></div>}
      <IncidentForm people={ACTORS.map((a) => ({ id: a.id, name: a.name, role: ROLE_LABELS[a.role] }))} defaultOwner={actor.id} />
    </div>
  );
}
