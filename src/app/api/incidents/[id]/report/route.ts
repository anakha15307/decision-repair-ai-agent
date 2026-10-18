import { getDb } from "@/lib/db";
import { incidentReportMarkdown } from "@/lib/report";
import { currentActor } from "@/lib/session";
import { can } from "@/lib/actors";
import { audit } from "@/lib/audit";

export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const actor = await currentActor();
  if (!can(actor, "report.export")) return new Response("Forbidden", { status: 403 });
  const db = getDb();
  let md: string;
  try { md = incidentReportMarkdown(db, id, actor.id); } catch { return new Response("Not found", { status: 404 }); }
  audit(db, { actor, incidentId: id, entityType: "incident", entityId: id, action: "report.exported", next: { format: "markdown" } });
  return new Response(md, { headers: { "content-type": "text/markdown; charset=utf-8", "content-disposition": `attachment; filename="${id}-report.md"` } });
}
