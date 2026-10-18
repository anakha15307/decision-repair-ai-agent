import crypto from "node:crypto";
import { z } from "zod";
import type { DB } from "./db";
import type { Actor } from "./types";
import { parseCsv } from "./csv";
import { audit } from "./audit";
import { isIsoInstant, nowIso, toUtcIso } from "./time";
import { DomainError, requirePermission } from "./actors";
import { detectInstructionLikeText, UNTRUSTED_FLAG } from "./analysis/untrusted";

export type ImportKind = "conversations" | "transactions" | "interactions";

export interface ValidationIssue {
  row: number | null; // 1-based data row (CSV) or array index + 1 (JSON); null = file level
  field: string | null;
  message: string;
}

export interface ImportResult {
  ok: boolean;
  batchId?: string;
  recordCount: number;
  flagged: { ref: string; patterns: string[] }[];
  issues: ValidationIssue[];
}

// Columns that would leak evaluation answers into investigation inputs.
const FORBIDDEN_FIELD = /^(label|labels|ground_truth|truth|expected_.*|eval_.*|is_affected|true_impact)$/i;

const iso = z.string().refine(isIsoInstant, "must be an ISO-8601 timestamp with timezone offset, e.g. 2026-06-14T15:04:00Z");
const nonEmpty = (what: string) => z.string().trim().min(1, `${what} is required`);
const optionalText = z.preprocess((v) => (v === "" || v === undefined ? null : v), z.string().trim().nullable());
const boolish = z.preprocess(
  (v) => (v === "" || v == null ? null : typeof v === "boolean" ? v : /^(true|1|yes|y)$/i.test(String(v)) ? true : /^(false|0|no|n)$/i.test(String(v)) ? false : v),
  z.boolean().nullable(),
);

const MessageSchema = z.object({
  seq: z.coerce.number().int().min(1, "seq must be ≥ 1"),
  role: z.enum(["customer", "assistant", "agent", "system"], { errorMap: () => ({ message: "role must be customer, assistant, agent or system" }) }),
  timestamp: iso,
  text: z.string().min(1, "text is required").max(20000, "text exceeds 20,000 characters"),
});

const ConversationSchema = z.object({
  conversation_id: nonEmpty("conversation_id"),
  customer_id: nonEmpty("customer_id"),
  channel: z.string().trim().min(1).default("chat"),
  started_at: iso.optional(),
  app_version: optionalText,
  order_id: optionalText,
  messages: z.array(MessageSchema).min(1, "conversation has no messages"),
});

const TransactionSchema = z.object({
  transaction_id: nonEmpty("transaction_id"),
  customer_id: nonEmpty("customer_id"),
  order_id: nonEmpty("order_id"),
  type: z.enum(["purchase", "refund_request", "refund", "refund_failed", "refund_reversal"], {
    errorMap: () => ({ message: "type must be purchase, refund_request, refund, refund_failed or refund_reversal" }),
  }),
  amount: z.coerce.number({ invalid_type_error: "amount must be a number" }).min(0, "amount must be ≥ 0").max(1_000_000),
  currency: z.string().trim().regex(/^[A-Z]{3}$/, "currency must be a 3-letter ISO code"),
  timestamp: iso,
  status: nonEmpty("status"),
  item_category: optionalText,
  sale_item: boolish,
  defective: boolish,
});

const InteractionSchema = z.object({
  interaction_id: nonEmpty("interaction_id"),
  customer_id: nonEmpty("customer_id"),
  order_id: optionalText,
  timestamp: iso,
  channel: nonEmpty("channel"),
  outcome: nonEmpty("outcome"),
  summary: z.string().min(1, "summary is required").max(20000),
});

function zodIssues(err: z.ZodError, row: number): ValidationIssue[] {
  return err.issues.map((i) => ({ row, field: i.path.join(".") || null, message: i.message }));
}

function parseRecords(content: string, format: "csv" | "json"): { records: Record<string, unknown>[]; issues: ValidationIssue[] } {
  if (format === "json") {
    let data: unknown;
    try {
      data = JSON.parse(content);
    } catch (e) {
      return { records: [], issues: [{ row: null, field: null, message: `Invalid JSON: ${(e as Error).message}` }] };
    }
    const arr = Array.isArray(data) ? data : data && typeof data === "object" ? Object.values(data as object).find(Array.isArray) : null;
    if (!Array.isArray(arr)) return { records: [], issues: [{ row: null, field: null, message: "JSON must be an array of records or an object containing one array." }] };
    return { records: arr as Record<string, unknown>[], issues: [] };
  }
  const parsed = parseCsv(content);
  if (parsed.error) return { records: [], issues: [{ row: null, field: null, message: parsed.error }] };
  return { records: parsed.rows, issues: [] };
}

/** Group message-per-row conversation CSV into conversation records. */
function groupConversationRows(rows: Record<string, unknown>[], issues: ValidationIssue[]): Record<string, unknown>[] {
  const required = ["conversation_id", "customer_id", "message_seq", "role", "timestamp", "text"];
  if (rows.length && required.some((c) => !(c in rows[0]))) {
    issues.push({ row: null, field: null, message: `CSV must include columns: ${required.join(", ")} (optional: channel, app_version, order_id).` });
    return [];
  }
  const map = new Map<string, Record<string, unknown> & { messages: unknown[]; _rows: number[] }>();
  rows.forEach((r, idx) => {
    const id = String(r.conversation_id ?? "").trim();
    if (!id) { issues.push({ row: idx + 1, field: "conversation_id", message: "conversation_id is required" }); return; }
    let conv = map.get(id);
    if (!conv) {
      conv = { conversation_id: id, customer_id: r.customer_id, channel: r.channel || "chat", app_version: r.app_version, order_id: r.order_id, messages: [], _rows: [] };
      map.set(id, conv);
    } else {
      for (const f of ["customer_id", "app_version", "order_id"]) {
        if ((r[f] ?? "") !== (conv[f] ?? "")) issues.push({ row: idx + 1, field: f, message: `${f} differs from earlier rows of ${id}` });
      }
    }
    conv._rows.push(idx + 1);
    conv.messages.push({ seq: r.message_seq, role: r.role, timestamp: r.timestamp, text: r.text });
  });
  return [...map.values()];
}

export function importEvidence(
  db: DB,
  actor: Actor,
  incidentId: string,
  input: { kind: ImportKind; format: "csv" | "json"; filename: string; content: string },
): ImportResult {
  requirePermission(actor, "evidence.import");
  if (!db.prepare("SELECT 1 FROM incidents WHERE id = ?").get(incidentId)) throw new DomainError("Incident not found.");
  const sha256 = crypto.createHash("sha256").update(input.content).digest("hex");
  const issues: ValidationIssue[] = [];
  const flagged: ImportResult["flagged"] = [];

  if (input.content.length > 10_000_000) return { ok: false, recordCount: 0, flagged, issues: [{ row: null, field: null, message: "File exceeds 10 MB prototype limit." }] };
  const dup = db.prepare("SELECT id, filename FROM import_batches WHERE incident_id = ? AND sha256 = ?").get(incidentId, sha256) as { id: string; filename: string } | undefined;
  if (dup) return { ok: false, recordCount: 0, flagged, issues: [{ row: null, field: null, message: `This exact file was already imported as ${dup.id} (${dup.filename}).` }] };

  const { records: raw, issues: parseIssues } = parseRecords(input.content, input.format);
  issues.push(...parseIssues);
  if (issues.length) return { ok: false, recordCount: 0, flagged, issues };
  if (raw.length === 0) return { ok: false, recordCount: 0, flagged, issues: [{ row: null, field: null, message: "No records found." }] };

  const fieldNames = new Set<string>();
  raw.forEach((r) => r && typeof r === "object" && Object.keys(r).forEach((k) => fieldNames.add(k)));
  const forbidden = [...fieldNames].filter((f) => FORBIDDEN_FIELD.test(f));
  if (forbidden.length) {
    return { ok: false, recordCount: 0, flagged, issues: [{ row: null, field: forbidden.join(", "), message: "Evaluation/ground-truth fields must not be imported as investigation evidence. Remove these columns." }] };
  }

  const records = input.kind === "conversations" && input.format === "csv" ? groupConversationRows(raw, issues) : raw;
  const batchId = `BATCH-${sha256.slice(0, 10).toUpperCase()}`;
  const now = nowIso();
  const seen = new Set<string>();

  type Insert = () => void;
  const inserts: Insert[] = [];

  records.forEach((rec, idx) => {
    const rowNo = idx + 1;
    const recSha = crypto.createHash("sha256").update(JSON.stringify(rec)).digest("hex");
    if (input.kind === "conversations") {
      const r = ConversationSchema.safeParse(rec);
      if (!r.success) { issues.push(...zodIssues(r.error, rowNo)); return; }
      const c = r.data;
      if (seen.has(c.conversation_id)) { issues.push({ row: rowNo, field: "conversation_id", message: `Duplicate conversation_id ${c.conversation_id} in file` }); return; }
      seen.add(c.conversation_id);
      if (db.prepare("SELECT 1 FROM conversations WHERE id = ?").get(c.conversation_id)) { issues.push({ row: rowNo, field: "conversation_id", message: `${c.conversation_id} already exists in evidence store` }); return; }
      const seqs = new Set<number>();
      for (const m of c.messages) {
        if (seqs.has(m.seq)) issues.push({ row: rowNo, field: "messages.seq", message: `Duplicate message seq ${m.seq} in ${c.conversation_id}` });
        seqs.add(m.seq);
      }
      const msgs = [...c.messages].sort((a, b) => a.seq - b.seq);
      const startedAt = toUtcIso(c.started_at ?? msgs[0].timestamp);
      inserts.push(() => {
        db.prepare("INSERT INTO conversations (id, incident_id, customer_id, channel, started_at, app_version, order_id, batch_id, sha256) VALUES (?,?,?,?,?,?,?,?,?)")
          .run(c.conversation_id, incidentId, c.customer_id, c.channel, startedAt, c.app_version, c.order_id, batchId, recSha);
        for (const m of msgs) {
          const patterns = detectInstructionLikeText(m.text);
          const flags = patterns.length ? [UNTRUSTED_FLAG] : [];
          if (patterns.length) flagged.push({ ref: `msg:${c.conversation_id}#${m.seq}`, patterns });
          db.prepare("INSERT INTO messages (id, conversation_id, seq, role, ts, text, flags) VALUES (?,?,?,?,?,?,?)")
            .run(`${c.conversation_id}#${m.seq}`, c.conversation_id, m.seq, m.role, toUtcIso(m.timestamp), m.text, JSON.stringify(flags));
        }
      });
    } else if (input.kind === "transactions") {
      const r = TransactionSchema.safeParse(rec);
      if (!r.success) { issues.push(...zodIssues(r.error, rowNo)); return; }
      const t = r.data;
      if (seen.has(t.transaction_id)) { issues.push({ row: rowNo, field: "transaction_id", message: `Duplicate transaction_id ${t.transaction_id} in file` }); return; }
      seen.add(t.transaction_id);
      if (db.prepare("SELECT 1 FROM transactions WHERE id = ?").get(t.transaction_id)) { issues.push({ row: rowNo, field: "transaction_id", message: `${t.transaction_id} already exists in evidence store` }); return; }
      inserts.push(() =>
        db.prepare("INSERT INTO transactions (id, incident_id, customer_id, order_id, type, amount_cents, currency, ts, status, item_category, sale_item, defective, batch_id, sha256) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
          .run(t.transaction_id, incidentId, t.customer_id, t.order_id, t.type, Math.round(t.amount * 100), t.currency, toUtcIso(t.timestamp), t.status, t.item_category,
            t.sale_item == null ? null : t.sale_item ? 1 : 0, t.defective == null ? null : t.defective ? 1 : 0, batchId, recSha),
      );
    } else {
      const r = InteractionSchema.safeParse(rec);
      if (!r.success) { issues.push(...zodIssues(r.error, rowNo)); return; }
      const t = r.data;
      if (seen.has(t.interaction_id)) { issues.push({ row: rowNo, field: "interaction_id", message: `Duplicate interaction_id ${t.interaction_id} in file` }); return; }
      seen.add(t.interaction_id);
      if (db.prepare("SELECT 1 FROM interactions WHERE id = ?").get(t.interaction_id)) { issues.push({ row: rowNo, field: "interaction_id", message: `${t.interaction_id} already exists in evidence store` }); return; }
      const patterns = detectInstructionLikeText(t.summary);
      if (patterns.length) flagged.push({ ref: `int:${t.interaction_id}`, patterns });
      inserts.push(() =>
        db.prepare("INSERT INTO interactions (id, incident_id, customer_id, order_id, ts, channel, outcome, summary, flags, batch_id, sha256) VALUES (?,?,?,?,?,?,?,?,?,?,?)")
          .run(t.interaction_id, incidentId, t.customer_id, t.order_id, toUtcIso(t.timestamp), t.channel, t.outcome, t.summary, JSON.stringify(patterns.length ? [UNTRUSTED_FLAG] : []), batchId, recSha),
      );
    }
  });

  if (issues.length) return { ok: false, recordCount: 0, flagged: [], issues: issues.slice(0, 200) };

  // All-or-nothing: either every record lands or none do.
  db.transaction(() => {
    db.prepare("INSERT INTO import_batches (id, incident_id, kind, filename, format, sha256, record_count, flagged_count, imported_by, imported_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
      .run(batchId, incidentId, input.kind, input.filename, input.format, sha256, inserts.length, flagged.length, actor.id, now);
    inserts.forEach((f) => f());
    audit(db, {
      actor, incidentId, entityType: "import_batch", entityId: batchId, action: "evidence.imported",
      next: { kind: input.kind, filename: input.filename, format: input.format, sha256, records: inserts.length, flagged: flagged.map((f) => f.ref) },
      evidenceRefs: [`batch:${batchId}`],
    });
  })();

  return { ok: true, batchId, recordCount: inserts.length, flagged, issues: [] };
}

export interface BatchRow {
  id: string; kind: string; filename: string; format: string; sha256: string;
  record_count: number; flagged_count: number; imported_by: string; imported_at: string;
}

export function listBatches(db: DB, incidentId: string): BatchRow[] {
  return db.prepare("SELECT * FROM import_batches WHERE incident_id = ? ORDER BY imported_at").all(incidentId) as BatchRow[];
}
