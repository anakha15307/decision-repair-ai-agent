import { getDb } from "@/lib/db";
import { listAudit } from "@/lib/audit";
import { toCsv } from "@/lib/csv";
import { currentActor } from "@/lib/session";
import { can } from "@/lib/actors";

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const actor = await currentActor();
  if (!can(actor, "report.export")) return new Response("Forbidden", { status: 403 });
  const rows = listAudit(getDb(), { incidentId: id, limit: 100000 }).reverse();
  const csv = toCsv(["seq", "ts", "actor", "actor_role", "entity_type", "entity_id", "action", "prev_value", "new_value", "evidence_refs", "reason", "prev_hash", "hash"], rows as unknown as Record<string, unknown>[]);
  return new Response(csv, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${id}-audit.csv"` } });
}
