import type { Actor, Role } from "./types";

// Demo stand-in for authentication. A production system must use real identity,
// and must enforce these permissions server-side (as this prototype also does).
export const ACTORS: Actor[] = [
  { id: "priya.raman", name: "Priya Raman", role: "governance_lead" },
  { id: "marcus.lee", name: "Marcus Lee", role: "case_reviewer" },
  { id: "dana.ortiz", name: "Dana Ortiz", role: "case_reviewer" },
  { id: "sam.whitfield", name: "Sam Whitfield", role: "ops_lead" },
  { id: "ellen.park", name: "Ellen Park", role: "auditor" },
];

export const SYSTEM_ACTOR: Actor = { id: "system", name: "System (automated step)", role: "governance_lead" };

export const ROLE_LABELS: Record<Role, string> = {
  governance_lead: "AI governance lead",
  case_reviewer: "Case reviewer",
  ops_lead: "Customer operations lead",
  auditor: "Auditor (read-only)",
};

export type Permission =
  | "incident.manage"
  | "evidence.import"
  | "analysis.run"
  | "case.review"
  | "action.propose"
  | "action.approve"
  | "action.execute"
  | "action.verify"
  | "report.export";

const PERMISSIONS: Record<Role, Permission[]> = {
  governance_lead: [
    "incident.manage",
    "evidence.import",
    "analysis.run",
    "case.review",
    "action.propose",
    "action.approve",
    "action.verify",
    "report.export",
  ],
  case_reviewer: ["case.review", "action.propose", "action.approve", "action.verify", "report.export"],
  ops_lead: ["evidence.import", "action.propose", "action.execute", "action.verify", "report.export"],
  auditor: ["report.export"],
};

export function getActor(id: string | undefined | null): Actor {
  return ACTORS.find((a) => a.id === id) ?? ACTORS[0];
}

export function actorName(id: string | null | undefined): string {
  if (!id) return "—";
  if (id === SYSTEM_ACTOR.id) return SYSTEM_ACTOR.name;
  return ACTORS.find((a) => a.id === id)?.name ?? id;
}

export function can(actor: Actor, p: Permission): boolean {
  return actor.id === SYSTEM_ACTOR.id || PERMISSIONS[actor.role].includes(p);
}

export class PermissionError extends Error {}
export class DomainError extends Error {}

export function requirePermission(actor: Actor, p: Permission): void {
  if (!can(actor, p)) {
    throw new PermissionError(`${actor.name} (${ROLE_LABELS[actor.role]}) is not permitted to ${p.replace(".", ": ")}.`);
  }
}
