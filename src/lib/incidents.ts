import { z } from "zod";
import type { DB } from "./db";
import { parseJson } from "./db";
import type { Actor, ImpactCriterion, ScopeCriteria } from "./types";
import { audit } from "./audit";
import { isValidTimeZone, nowIso, zonedToUtc } from "./time";
import { DomainError, requirePermission } from "./actors";

export interface Incident {
  id: string;
  title: string;
  description: string;
  ai_system: string;
  known_versions: string[];
  start_at: string;
  end_at: string;
  timezone: string;
  incorrect_behavior: string;
  scope_criteria: ScopeCriteria;
  exclusions: string[];
  impact_criteria: ImpactCriterion[];
  owner: string;
  reviewers: string[];
  known_gaps: string[];
  status: string;
  created_at: string;
  created_by: string;
}

type IncidentRow = Record<keyof Incident, string>;

function rowToIncident(r: IncidentRow): Incident {
  return {
    ...r,
    known_versions: parseJson(r.known_versions, []),
    scope_criteria: parseJson(r.scope_criteria, {} as ScopeCriteria),
    exclusions: parseJson(r.exclusions, []),
    impact_criteria: parseJson(r.impact_criteria, []),
    reviewers: parseJson(r.reviewers, []),
    known_gaps: parseJson(r.known_gaps, []),
  } as Incident;
}

const lines = z
  .union([z.array(z.string()), z.string()])
  .transform((v) => (Array.isArray(v) ? v : v.split(/\r?\n|,/)).map((s) => s.trim()).filter(Boolean));

export const IncidentInputSchema = z.object({
  title: z.string().trim().min(5, "Title must be at least 5 characters"),
  description: z.string().trim().min(10, "Description must be at least 10 characters"),
  ai_system: z.string().trim().min(2, "Affected AI system is required"),
  known_versions: lines,
  start_local: z.string().min(10, "Start date/time is required"),
  end_local: z.string().min(10, "End date/time is required"),
  timezone: z.string().refine(isValidTimeZone, "Unknown IANA timezone (e.g. America/Chicago)"),
  incorrect_behavior: z.string().trim().min(10, "Describe the incorrect policy or behavior"),
  scope: z.object({
    affected_versions: lines,
    include_unknown_versions: z.coerce.boolean(),
    topic_keywords: lines,
    excluded_customer_prefixes: lines,
    exclude_without_assistant_messages: z.coerce.boolean(),
  }),
  exclusions: lines,
  impact_criteria: lines,
  owner: z.string().min(1, "Incident owner is required"),
  reviewers: lines,
  known_gaps: lines,
});
export type IncidentInput = z.input<typeof IncidentInputSchema>;

export function createIncident(db: DB, actor: Actor, raw: unknown, id?: string): Incident {
  requirePermission(actor, "incident.manage");
  const parsed = IncidentInputSchema.safeParse(raw);
  if (!parsed.success) throw new DomainError(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  const v = parsed.data;
  const start = zonedToUtc(v.start_local, v.timezone);
  const end = zonedToUtc(v.end_local, v.timezone);
  if (Date.parse(end) <= Date.parse(start)) throw new DomainError("Incident end must be after start.");
  if (v.impact_criteria.length === 0) throw new DomainError("At least one reviewer-defined impact criterion is required.");

  const count = (db.prepare("SELECT COUNT(*) n FROM incidents").get() as { n: number }).n;
  const incidentId = id ?? `INC-${new Date().getUTCFullYear()}-${String(count + 1).padStart(3, "0")}`;
  const criteria: ImpactCriterion[] = v.impact_criteria.map((text, i) => ({ id: `C${i + 1}`, text }));
  const scope: ScopeCriteria = v.scope;
  const row = {
    id: incidentId,
    title: v.title,
    description: v.description,
    ai_system: v.ai_system,
    known_versions: JSON.stringify(v.known_versions),
    start_at: start,
    end_at: end,
    timezone: v.timezone,
    incorrect_behavior: v.incorrect_behavior,
    scope_criteria: JSON.stringify(scope),
    exclusions: JSON.stringify(v.exclusions),
    impact_criteria: JSON.stringify(criteria),
    owner: v.owner,
    reviewers: JSON.stringify(v.reviewers),
    known_gaps: JSON.stringify(v.known_gaps),
    status: "open",
    created_at: nowIso(),
    created_by: actor.id,
  };
  db.prepare(
    `INSERT INTO incidents (${Object.keys(row).join(",")}) VALUES (${Object.keys(row).map((k) => "@" + k).join(",")})`,
  ).run(row);
  audit(db, { actor, incidentId, entityType: "incident", entityId: incidentId, action: "incident.created", next: { ...v, start_at: start, end_at: end } });
  return getIncident(db, incidentId)!;
}

export function getIncident(db: DB, id: string): Incident | null {
  const r = db.prepare("SELECT * FROM incidents WHERE id = ?").get(id) as IncidentRow | undefined;
  return r ? rowToIncident(r) : null;
}

export function listIncidents(db: DB): Incident[] {
  return (db.prepare("SELECT * FROM incidents ORDER BY created_at DESC").all() as IncidentRow[]).map(rowToIncident);
}

/** Append a known gap in available records. Gaps are never removed, only added. */
export function addKnownGap(db: DB, actor: Actor, incidentId: string, gap: string): void {
  requirePermission(actor, "incident.manage");
  const inc = getIncident(db, incidentId);
  if (!inc) throw new DomainError("Incident not found.");
  const text = gap.trim();
  if (text.length < 5) throw new DomainError("Describe the gap in at least 5 characters.");
  const next = [...inc.known_gaps, text];
  db.prepare("UPDATE incidents SET known_gaps = ? WHERE id = ?").run(JSON.stringify(next), incidentId);
  audit(db, { actor, incidentId, entityType: "incident", entityId: incidentId, action: "incident.gap_added", prev: inc.known_gaps, next });
}

export function isInIncidentWindow(incident: Pick<Incident, "start_at" | "end_at">, instantIso: string): boolean {
  const t = Date.parse(instantIso);
  return t >= Date.parse(incident.start_at) && t < Date.parse(incident.end_at);
}
