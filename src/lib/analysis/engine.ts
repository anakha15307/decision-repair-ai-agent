import crypto from "node:crypto";
import type { DB } from "../db";
import { parseJson } from "../db";
import type { Actor } from "../types";
import { getIncident, isInIncidentWindow, type Incident } from "../incidents";
import { applicablePolicyAt, listPolicies } from "../policy";
import { audit } from "../audit";
import { nowIso } from "../time";
import { DomainError, requirePermission } from "../actors";
import { demoAssess, demoProvider } from "./demoAnalyzer";
import type { AnalysisProvider, CaseContext, ConversationRec, FindingDraft, InteractionRec, MessageRec, TransactionRec } from "./provider";
import { validateDraft } from "./provider";
import { createAnthropicProvider, liveProviderConfigured } from "./anthropicProvider";

export interface ScopeReason { kind: "match" | "exclude" | "gap"; text: string }

export function selectProvider(): AnalysisProvider {
  return liveProviderConfigured() ? createAnthropicProvider() : demoProvider;
}

/** Deterministic scope screen. Always rule-based, regardless of provider. */
export function screenScope(incident: Incident, conv: ConversationRec, messages: MessageRec[]): { inScope: boolean; isCandidate: boolean; reasons: ScopeReason[] } {
  const reasons: ScopeReason[] = [];
  const sc = incident.scope_criteria;
  let inScope = true;

  if (isInIncidentWindow(incident, conv.started_at)) reasons.push({ kind: "match", text: `Started within the incident window (${incident.timezone}).` });
  else { inScope = false; reasons.push({ kind: "exclude", text: "Started outside the incident window." }); }

  if (conv.app_version == null) {
    if (sc.include_unknown_versions) reasons.push({ kind: "gap", text: "No model/application version recorded; included by date under scope rules." });
    else { inScope = false; reasons.push({ kind: "exclude", text: "No version recorded and unknown versions are excluded." }); }
  } else if (sc.affected_versions.includes(conv.app_version)) {
    reasons.push({ kind: "match", text: `Version ${conv.app_version} is a known affected version.` });
  } else {
    inScope = false;
    reasons.push({ kind: "exclude", text: `Version ${conv.app_version} is not among affected versions.` });
  }

  const prefix = sc.excluded_customer_prefixes.find((p) => conv.customer_id.startsWith(p));
  if (prefix) { inScope = false; reasons.push({ kind: "exclude", text: `Customer ID prefix "${prefix}" is excluded (e.g. internal test account).` }); }

  if (sc.exclude_without_assistant_messages && !messages.some((m) => m.role === "assistant")) {
    inScope = false;
    reasons.push({ kind: "exclude", text: "No AI assistant messages (handled by human agents only)." });
  }

  const customerText = messages.filter((m) => m.role === "customer").map((m) => m.text.toLowerCase()).join(" ");
  const kw = sc.topic_keywords.find((k) => customerText.includes(k.toLowerCase()));
  const topical = Boolean(kw);
  if (topical) reasons.push({ kind: "match", text: `Customer raised the topic ("${kw}").` });
  else reasons.push({ kind: "exclude", text: "Customer messages do not mention the incident topic." });

  return { inScope, isCandidate: inScope && topical, reasons };
}

function loadContext(db: DB, incident: Incident, conv: ConversationRec, messages: MessageRec[]): CaseContext {
  const policies = listPolicies(db, incident.id);
  const transactions = db.prepare("SELECT * FROM transactions WHERE incident_id = ? AND customer_id = ? ORDER BY ts").all(incident.id, conv.customer_id) as TransactionRec[];
  const interactions = (db.prepare("SELECT * FROM interactions WHERE incident_id = ? AND customer_id = ? ORDER BY ts").all(incident.id, conv.customer_id) as (InteractionRec & { flags: string })[])
    .map((i) => ({ ...i, flags: parseJson<string[]>(i.flags as unknown as string, []) }));
  const applicable = applicablePolicyAt(policies, conv.started_at);
  const incorrect = policies.find((p) => p.role === "incorrect_used") ?? null;
  const allowedRefs = new Set<string>([
    `conv:${conv.id}`,
    ...messages.map((m) => `msg:${m.id}`),
    ...transactions.map((t) => `txn:${t.id}`),
    ...interactions.map((i) => `int:${i.id}`),
    ...policies.map((p) => `pol:${p.id}`),
  ]);
  return { incident, policies, applicable, incorrect, conversation: conv, messages, transactions, interactions, allowedRefs };
}

export interface RunSummary {
  runId: string;
  analyzer: string;
  isLive: boolean;
  conversations: number;
  inScope: number;
  candidates: number;
  exposed: number;
  casesCreated: number;
  casesUpdated: number;
  rejectedOutputs: number;
  flaggedUntrusted: number;
}

export async function runAnalysis(db: DB, actor: Actor, incidentId: string, provider: AnalysisProvider = selectProvider()): Promise<RunSummary> {
  requirePermission(actor, "analysis.run");
  const incident = getIncident(db, incidentId);
  if (!incident) throw new DomainError("Incident not found.");
  if (!listPolicies(db, incidentId).some((p) => p.role === "authoritative")) throw new DomainError("Register at least one authoritative policy version before running analysis.");

  const runId = `RUN-${nowIso().replace(/[-:.TZ]/g, "").slice(0, 14)}-${crypto.randomBytes(2).toString("hex")}`;
  db.prepare("INSERT INTO analysis_runs (id, incident_id, analyzer_id, analyzer_version, is_live, model, started_at, started_by) VALUES (?,?,?,?,?,?,?,?)")
    .run(runId, incidentId, provider.id, provider.version, provider.isLive ? 1 : 0, provider.model, nowIso(), actor.id);

  const convs = db.prepare("SELECT * FROM conversations WHERE incident_id = ? ORDER BY started_at, id").all(incidentId) as ConversationRec[];
  const msgStmt = db.prepare("SELECT * FROM messages WHERE conversation_id = ? ORDER BY seq");
  const summary: RunSummary = { runId, analyzer: provider.label, isLive: provider.isLive, conversations: convs.length, inScope: 0, candidates: 0, exposed: 0, casesCreated: 0, casesUpdated: 0, rejectedOutputs: 0, flaggedUntrusted: 0 };

  const results: { conv: ConversationRec; scope: ReturnType<typeof screenScope>; draft: FindingDraft | null; errors: string[]; flags: string[]; applicableId: string | null }[] = [];
  for (const conv of convs) {
    const messages = (msgStmt.all(conv.id) as (MessageRec & { flags: string })[]).map((m) => ({ ...m, flags: parseJson<string[]>(m.flags as unknown as string, []) }));
    const scope = screenScope(incident, conv, messages);
    const flags = messages.some((m) => m.flags.length) ? ["instruction_like_text"] : [];
    if (flags.length) summary.flaggedUntrusted++;
    if (scope.inScope) summary.inScope++;
    if (!scope.isCandidate) { results.push({ conv, scope, draft: null, errors: [], flags, applicableId: null }); continue; }
    summary.candidates++;
    const ctx = loadContext(db, incident, conv, messages);
    if (!flags.length && ctx.interactions.some((i) => i.flags.length)) { flags.push("instruction_like_text"); summary.flaggedUntrusted++; }
    let draft: FindingDraft | null = null;
    let errors: string[] = [];
    try {
      const raw = await provider.assess(ctx);
      const v = validateDraft(raw, ctx.allowedRefs);
      draft = v.draft;
      errors = v.errors;
      // Derived facts (days since purchase, amounts) are computed deterministically, never taken from a model.
      if (draft) draft.facts = { ...demoAssess(ctx).facts, ...(provider.isLive ? { served_by_model: (raw.facts as Record<string, unknown>)?.served_by_model ?? provider.model } : {}) };
    } catch (e) {
      errors = [`Provider error: ${(e as Error).message}`];
    }
    if (!draft) summary.rejectedOutputs++;
    results.push({ conv, scope, draft, errors, flags, applicableId: ctx.applicable?.id ?? null });
  }

  const insertFinding = db.prepare(`INSERT INTO findings (id, run_id, incident_id, conversation_id, in_scope, is_candidate, scope_reasons, exposure, suggested_impact, explanation, provisions, applicable_policy_id, supporting, gaps, conflicts, flags, facts)
    VALUES (@id,@run_id,@incident_id,@conversation_id,@in_scope,@is_candidate,@scope_reasons,@exposure,@suggested_impact,@explanation,@provisions,@applicable_policy_id,@supporting,@gaps,@conflicts,@flags,@facts)`);

  db.transaction(() => {
    let caseSeq = (db.prepare("SELECT COUNT(*) n FROM cases").get() as { n: number }).n;
    for (const r of results) {
      const findingId = `F-${runId.slice(4)}-${r.conv.id}`;
      const d = r.draft;
      const rejected = r.scope.isCandidate && !d;
      insertFinding.run({
        id: findingId, run_id: runId, incident_id: incidentId, conversation_id: r.conv.id,
        in_scope: r.scope.inScope ? 1 : 0, is_candidate: r.scope.isCandidate ? 1 : 0,
        scope_reasons: JSON.stringify(r.scope.reasons),
        exposure: d?.exposure ?? "undetermined",
        suggested_impact: d?.suggested_impact ?? (rejected ? "insufficient_evidence" : "not_assessed"),
        explanation: d?.explanation ?? (rejected ? `Analysis output rejected: ${r.errors.join(" ")}` : "Not a candidate interaction under the incident scope criteria."),
        provisions: JSON.stringify(d?.provisions ?? []), applicable_policy_id: r.applicableId,
        supporting: JSON.stringify(d?.supporting ?? [{ ref: `conv:${r.conv.id}`, note: "Scope screen only." }]),
        gaps: JSON.stringify(d?.gaps ?? []), conflicts: JSON.stringify(d?.conflicts ?? []),
        flags: JSON.stringify([...r.flags, ...(rejected ? ["analysis_output_rejected"] : [])]),
        facts: JSON.stringify(d?.facts ?? {}),
      });
      if (!r.scope.isCandidate) continue;
      const exposure = d?.exposure ?? "undetermined";
      if (exposure === "exposed") summary.exposed++;
      if (exposure === "not_exposed") continue; // finding kept for audit, no case opened

      const existing = db.prepare("SELECT c.* FROM cases c JOIN case_conversations cc ON cc.case_id = c.id WHERE cc.conversation_id = ?").get(r.conv.id) as { id: string; suggested_impact: string; exposure: string; decided_by: string | null } | undefined;
      const orderId = (d?.facts?.order_id as string | null) ?? r.conv.order_id;
      if (existing) {
        const next = { suggested_impact: d?.suggested_impact ?? "insufficient_evidence", exposure: existing.decided_by ? existing.exposure : exposure };
        db.prepare("UPDATE cases SET suggested_impact = ?, exposure = ?, primary_finding_id = ?, updated_at = ? WHERE id = ?").run(next.suggested_impact, next.exposure, findingId, nowIso(), existing.id);
        audit(db, { actor, incidentId, entityType: "case", entityId: existing.id, action: "case.reanalyzed", prev: { suggested_impact: existing.suggested_impact }, next: { ...next, finding: findingId }, evidenceRefs: [`conv:${r.conv.id}`] });
        summary.casesUpdated++;
        continue;
      }
      caseSeq++;
      const caseId = `CASE-${String(caseSeq).padStart(4, "0")}`;
      const now = nowIso();
      db.prepare(`INSERT INTO cases (id, incident_id, customer_id, order_id, status, exposure, suggested_impact, impact, primary_finding_id, created_at, updated_at)
        VALUES (?,?,?,?, 'unreviewed', ?, ?, 'not_assessed', ?, ?, ?)`)
        .run(caseId, incidentId, r.conv.customer_id, orderId, exposure, d?.suggested_impact ?? "insufficient_evidence", findingId, now, now);
      db.prepare("INSERT INTO case_conversations (case_id, conversation_id) VALUES (?, ?)").run(caseId, r.conv.id);
      audit(db, { actor, incidentId, entityType: "case", entityId: caseId, action: "case.opened", next: { exposure, suggested_impact: d?.suggested_impact ?? "insufficient_evidence", finding: findingId, analyzer: provider.id, analyzer_version: provider.version }, evidenceRefs: (d?.supporting ?? []).map((s) => s.ref) });
      summary.casesCreated++;
    }
    flagPossibleDuplicates(db, incidentId);
    db.prepare("UPDATE analysis_runs SET completed_at = ?, stats = ? WHERE id = ?").run(nowIso(), JSON.stringify(summary), runId);
    audit(db, { actor, incidentId, entityType: "analysis_run", entityId: runId, action: "analysis.completed", next: { ...summary, analyzer_id: provider.id, analyzer_version: provider.version, is_live: provider.isLive, model: provider.model } });
  })();

  return summary;
}

/** Flag (never auto-merge) cases for the same customer and order. Merging is a reviewer decision. */
export function flagPossibleDuplicates(db: DB, incidentId: string): void {
  const rows = db.prepare("SELECT id, customer_id, order_id, possible_duplicate_of FROM cases WHERE incident_id = ? AND status NOT IN ('merged','match_rejected') ORDER BY id").all(incidentId) as { id: string; customer_id: string; order_id: string | null; possible_duplicate_of: string | null }[];
  const firstByKey = new Map<string, string>();
  for (const r of rows) {
    const key = `${r.customer_id}|${r.order_id ?? "?"}`;
    const first = firstByKey.get(key);
    if (!first) { firstByKey.set(key, r.id); continue; }
    if (r.possible_duplicate_of !== first) db.prepare("UPDATE cases SET possible_duplicate_of = ? WHERE id = ?").run(first, r.id);
  }
}

export interface RunRow { id: string; analyzer_id: string; analyzer_version: string; is_live: number; model: string | null; started_at: string; completed_at: string | null; started_by: string; stats: string }

export function latestRun(db: DB, incidentId: string): RunRow | null {
  return (db.prepare("SELECT * FROM analysis_runs WHERE incident_id = ? AND completed_at IS NOT NULL ORDER BY started_at DESC, rowid DESC LIMIT 1").get(incidentId) as RunRow | undefined) ?? null;
}

export function listRuns(db: DB, incidentId: string): RunRow[] {
  return db.prepare("SELECT * FROM analysis_runs WHERE incident_id = ? ORDER BY started_at DESC, rowid DESC").all(incidentId) as RunRow[];
}
