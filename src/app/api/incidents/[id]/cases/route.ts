import { getDb } from "@/lib/db";
import { caseListCsv } from "@/lib/report";
import { currentActor } from "@/lib/session";
import { can } from "@/lib/actors";
import { audit } from "@/lib/audit";

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const actor = await currentActor();
  if (!can(actor, "report.export")) return new Response("Forbidden", { status: 403 });
  const db = getDb();
  const csv = caseListCsv(db, id);
  audit(db, { actor, incidentId: id, entityType: "incident", entityId: id, action: "report.exported", next: { format: "cases.csv" } });
  return new Response(csv, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${id}-cases.csv"` } });
}
