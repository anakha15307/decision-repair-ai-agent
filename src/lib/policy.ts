import crypto from "node:crypto";
import { z } from "zod";
import type { DB } from "./db";
import { parseJson } from "./db";
import type { Actor, PolicyParams, PolicyRole } from "./types";
import { audit } from "./audit";
import { zonedToUtc } from "./time";
import { DomainError, requirePermission } from "./actors";

export interface PolicyProvision {
  code: string;
  text: string;
}

export interface PolicyVersion {
  id: string;
  incident_id: string;
  policy_key: string;
  version: string;
  role: PolicyRole;
  effective_from: string;
  effective_to: string | null;
  text: string;
  params: PolicyParams;
  provisions: PolicyProvision[];
  sha256: string;
}

interface PolicyRow extends Omit<PolicyVersion, "params" | "provisions"> {
  params: string;
  provisions: string;
}

const rowToPolicy = (r: PolicyRow): PolicyVersion => ({
  ...r,
  params: parseJson<PolicyParams>(r.params, { window_days: 0, sale_refundable: false, proof: "receipt", defective_window_days: null }),
  provisions: parseJson<PolicyProvision[]>(r.provisions, []),
});

export function listPolicies(db: DB, incidentId: string): PolicyVersion[] {
  return (db.prepare("SELECT * FROM policy_versions WHERE incident_id = ? ORDER BY effective_from").all(incidentId) as PolicyRow[]).map(rowToPolicy);
}

export function getPolicy(db: DB, id: string): PolicyVersion | null {
  const r = db.prepare("SELECT * FROM policy_versions WHERE id = ?").get(id) as PolicyRow | undefined;
  return r ? rowToPolicy(r) : null;
}

/**
 * The authoritative policy in force at a given instant. Policies with role
 * "introduced_after" are never returned, even if their dates would match:
 * remedies are assessed against the policy that applied at the time.
 */
export function applicablePolicyAt(policies: PolicyVersion[], instantIso: string, policyKey = "refund"): PolicyVersion | null {
  const t = Date.parse(instantIso);
  const matches = policies.filter(
    (p) =>
      p.role === "authoritative" &&
      p.policy_key === policyKey &&
      Date.parse(p.effective_from) <= t &&
      (p.effective_to == null || t < Date.parse(p.effective_to)),
  );
  if (matches.length > 1) {
    // Overlapping authoritative versions are a data problem; prefer the most recent start but callers see the conflict.
    matches.sort((a, b) => Date.parse(b.effective_from) - Date.parse(a.effective_from));
  }
  return matches[0] ?? null;
}

export function overlappingAuthoritative(policies: PolicyVersion[], policyKey = "refund"): string[] {
  const auth = policies.filter((p) => p.role === "authoritative" && p.policy_key === policyKey);
  const issues: string[] = [];
  for (let i = 0; i < auth.length; i++)
    for (let j = i + 1; j < auth.length; j++) {
      const a = auth[i], b = auth[j];
      const aEnd = a.effective_to ? Date.parse(a.effective_to) : Infinity;
      const bEnd = b.effective_to ? Date.parse(b.effective_to) : Infinity;
      if (Date.parse(a.effective_from) < bEnd && Date.parse(b.effective_from) < aEnd)
        issues.push(`${a.id} and ${b.id} have overlapping effective dates.`);
    }
  return issues;
}

/** Parse provisions from pasted text. Lines like "[RW] Refund window: ..." become provisions. */
export function parseProvisions(text: string): PolicyProvision[] {
  const out: PolicyProvision[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*\[([A-Z][A-Z0-9-]{0,15})\]\s*(.+)$/.exec(line);
    if (m) out.push({ code: m[1], text: m[2].trim() });
  }
  return out;
}

export const PolicyInputSchema = z.object({
  policy_key: z.string().min(1).default("refund"),
  version: z.string().min(1, "Version label is required"),
  role: z.enum(["authoritative", "incorrect_used", "introduced_after"]),
  effective_from: z.string().min(1, "Effective-from date is required"),
  effective_to: z.string().optional().nullable(),
  timezone: z.string().min(1),
  text: z.string().min(20, "Policy text must be at least 20 characters"),
  params: z.object({
    window_days: z.coerce.number().int().min(0).max(3650),
    sale_refundable: z.coerce.boolean(),
    proof: z.enum(["receipt", "receipt_or_order"]),
    defective_window_days: z.coerce.number().int().min(0).max(3650).nullable(),
  }),
});
export type PolicyInput = z.infer<typeof PolicyInputSchema>;

export function addPolicyVersion(db: DB, actor: Actor, incidentId: string, raw: unknown, batchId: string | null = null): PolicyVersion {
  requirePermission(actor, "evidence.import");
  const parsed = PolicyInputSchema.safeParse(raw);
  if (!parsed.success) throw new DomainError(parsed.error.issues.map((i) => `${i.path.join(".") || "policy"}: ${i.message}`).join("; "));
  const p = parsed.data;
  const from = /T/.test(p.effective_from) && /Z|[+-]\d\d:\d\d$/.test(p.effective_from) ? new Date(p.effective_from).toISOString() : zonedToUtc(p.effective_from, p.timezone);
  const to = p.effective_to ? (/T/.test(p.effective_to) && /Z|[+-]\d\d:\d\d$/.test(p.effective_to) ? new Date(p.effective_to).toISOString() : zonedToUtc(p.effective_to, p.timezone)) : null;
  if (to && Date.parse(to) <= Date.parse(from)) throw new DomainError("Effective-to must be after effective-from.");

  const incident = db.prepare("SELECT end_at FROM incidents WHERE id = ?").get(incidentId) as { end_at: string } | undefined;
  if (!incident) throw new DomainError("Incident not found.");
  if (p.role === "introduced_after" && Date.parse(from) < Date.parse(incident.end_at)) {
    throw new DomainError("A policy marked 'introduced after' must take effect after the incident period ends.");
  }

  const id = `POL-${p.policy_key.toUpperCase()}-${p.version}`.replace(/[^A-Z0-9.\-]/gi, "_");
  if (db.prepare("SELECT 1 FROM policy_versions WHERE id = ?").get(id)) throw new DomainError(`Policy version ${id} already exists.`);
  const sha256 = crypto.createHash("sha256").update(p.text).digest("hex");
  const provisions = parseProvisions(p.text);

  if (p.role === "authoritative") {
    const existing = listPolicies(db, incidentId);
    const candidate: PolicyVersion = { id, incident_id: incidentId, policy_key: p.policy_key, version: p.version, role: p.role, effective_from: from, effective_to: to, text: p.text, params: p.params, provisions, sha256 };
    const overlaps = overlappingAuthoritative([...existing, candidate], p.policy_key).filter((s) => s.includes(id));
    if (overlaps.length) throw new DomainError(overlaps.join(" "));
  }

  db.prepare(
    `INSERT INTO policy_versions (id, incident_id, policy_key, version, role, effective_from, effective_to, text, params, provisions, batch_id, sha256)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, incidentId, p.policy_key, p.version, p.role, from, to, p.text, JSON.stringify(p.params), JSON.stringify(provisions), batchId, sha256);
  audit(db, { actor, incidentId, entityType: "policy_version", entityId: id, action: "policy.added", next: { version: p.version, role: p.role, effective_from: from, effective_to: to, sha256 }, evidenceRefs: [`pol:${id}`] });
  return getPolicy(db, id)!;
}
