import type { DB } from "./db";
import { parseJson } from "./db";
import type { EvidenceRef } from "./types";

// Evidence references are typed pointers into the evidence store:
//   conv:<conversation_id>         msg:<conversation_id>#<seq>
//   txn:<transaction_id>           int:<interaction_id>
//   pol:<policy_id>[#<provision>]  batch:<batch_id>

export type RefKind = "conv" | "msg" | "txn" | "int" | "pol" | "batch";

export interface ResolvedRef {
  ref: EvidenceRef;
  kind: RefKind;
  incidentId: string;
  customerId: string | null;
  label: string;
  excerpt: string;
  ts: string | null;
  flags: string[];
}

const REF_RE = /^(conv|msg|txn|int|pol|batch):([A-Za-z0-9._\-]+)(?:#([A-Za-z0-9\-]+))?$/;

export function parseRef(ref: string): { kind: RefKind; id: string; sub: string | null } | null {
  const m = REF_RE.exec(ref.trim());
  if (!m) return null;
  return { kind: m[1] as RefKind, id: m[2], sub: m[3] ?? null };
}

export function resolveRef(db: DB, ref: string): ResolvedRef | null {
  const p = parseRef(ref);
  if (!p) return null;
  switch (p.kind) {
    case "conv": {
      const c = db.prepare("SELECT * FROM conversations WHERE id = ?").get(p.id) as any;
      if (!c || p.sub) return null;
      return { ref, kind: "conv", incidentId: c.incident_id, customerId: c.customer_id, label: `Conversation ${c.id}`, excerpt: `${c.channel}, version ${c.app_version ?? "not recorded"}`, ts: c.started_at, flags: [] };
    }
    case "msg": {
      if (!p.sub) return null;
      const m = db.prepare("SELECT m.*, c.customer_id, c.incident_id FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE m.id = ?").get(`${p.id}#${p.sub}`) as any;
      if (!m) return null;
      return { ref, kind: "msg", incidentId: m.incident_id, customerId: m.customer_id, label: `${p.id} · message ${m.seq} (${m.role})`, excerpt: m.text, ts: m.ts, flags: parseJson(m.flags, []) };
    }
    case "txn": {
      const t = db.prepare("SELECT * FROM transactions WHERE id = ?").get(p.id) as any;
      if (!t || p.sub) return null;
      return { ref, kind: "txn", incidentId: t.incident_id, customerId: t.customer_id, label: `Transaction ${t.id} (${t.type})`, excerpt: `${t.type} ${(t.amount_cents / 100).toFixed(2)} ${t.currency}, status ${t.status}, order ${t.order_id}`, ts: t.ts, flags: [] };
    }
    case "int": {
      const i = db.prepare("SELECT * FROM interactions WHERE id = ?").get(p.id) as any;
      if (!i || p.sub) return null;
      return { ref, kind: "int", incidentId: i.incident_id, customerId: i.customer_id, label: `Interaction ${i.id} (${i.channel})`, excerpt: `${i.outcome}: ${i.summary}`, ts: i.ts, flags: parseJson(i.flags, []) };
    }
    case "pol": {
      const pol = db.prepare("SELECT * FROM policy_versions WHERE id = ?").get(p.id) as any;
      if (!pol) return null;
      if (p.sub) {
        const prov = parseJson<{ code: string; text: string }[]>(pol.provisions, []).find((x) => x.code === p.sub);
        if (!prov) return null;
        return { ref, kind: "pol", incidentId: pol.incident_id, customerId: null, label: `${pol.id} §${prov.code}`, excerpt: prov.text, ts: pol.effective_from, flags: [] };
      }
      return { ref, kind: "pol", incidentId: pol.incident_id, customerId: null, label: pol.id, excerpt: pol.text.slice(0, 300), ts: pol.effective_from, flags: [] };
    }
    case "batch": {
      const b = db.prepare("SELECT * FROM import_batches WHERE id = ?").get(p.id) as any;
      if (!b || p.sub) return null;
      return { ref, kind: "batch", incidentId: b.incident_id, customerId: null, label: `Import ${b.id}`, excerpt: `${b.filename} (${b.record_count} records, sha256 ${b.sha256.slice(0, 12)}…)`, ts: b.imported_at, flags: [] };
    }
  }
}

export interface RefValidation {
  valid: ResolvedRef[];
  invalid: { ref: string; reason: string }[];
}

/**
 * Validate references against the evidence store. A reference is unsupported if it is
 * malformed, does not exist, belongs to another incident, or (when customerIds is given)
 * points at a different customer's records.
 */
export function validateRefs(
  db: DB,
  refs: string[],
  scope: { incidentId: string; customerIds?: string[]; allowedRefs?: Set<string> },
): RefValidation {
  const out: RefValidation = { valid: [], invalid: [] };
  for (const ref of refs) {
    if (typeof ref !== "string" || !parseRef(ref)) { out.invalid.push({ ref: String(ref), reason: "malformed reference" }); continue; }
    if (scope.allowedRefs && !scope.allowedRefs.has(ref)) { out.invalid.push({ ref, reason: "not among the evidence provided for this analysis" }); continue; }
    const r = resolveRef(db, ref);
    if (!r) { out.invalid.push({ ref, reason: "no such record in the evidence store" }); continue; }
    if (r.incidentId !== scope.incidentId) { out.invalid.push({ ref, reason: "belongs to a different incident" }); continue; }
    if (scope.customerIds && r.customerId && !scope.customerIds.includes(r.customerId)) { out.invalid.push({ ref, reason: "belongs to a different customer" }); continue; }
    out.valid.push(r);
  }
  return out;
}
