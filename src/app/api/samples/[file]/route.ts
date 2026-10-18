import fs from "node:fs";
import path from "node:path";

const ALLOWED = /^[a-z0-9.\-]+\.(csv|json|txt)$/;

export async function GET(_: Request, { params }: { params: Promise<{ file: string }> }) {
  const { file } = await params;
  if (!ALLOWED.test(file)) return new Response("Not found", { status: 404 });
  const full = path.join(process.cwd(), "data", "samples", file);
  if (!fs.existsSync(full)) return new Response("Not found. Run npm run generate:data.", { status: 404 });
  const type = file.endsWith(".csv") ? "text/csv" : file.endsWith(".json") ? "application/json" : "text/plain";
  return new Response(fs.readFileSync(full), { headers: { "content-type": `${type}; charset=utf-8`, "content-disposition": `attachment; filename="${file}"` } });
}
