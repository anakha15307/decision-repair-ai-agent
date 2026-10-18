import fs from "node:fs";
import path from "node:path";
import type { DB } from "./db";
import { latestRun } from "./analysis/engine";

// Evaluation against hidden ground-truth labels. Labels live in data/eval/labels.json, are
// produced by the synthetic-data generator, and are read ONLY here — never by the importers or
// analysis code — so they cannot leak into investigation inputs. Use the results to judge the
// analyzer, not individual customers.

export interface EvalLabel {
  conversation_id: string;
  scenario: string;
  should_be_candidate: boolean;
  exposed: boolean;
  true_impact: "adverse" | "none" | "indeterminate" | "n/a";
}

export function labelsPath(): string {
  return process.env.DR_EVAL_LABELS ?? path.join(process.cwd(), "data", "eval", "labels.json");
}

export function loadLabels(file = labelsPath()): EvalLabel[] | null {
  try {
    return (JSON.parse(fs.readFileSync(file, "utf8")) as { labels: EvalLabel[] }).labels;
  } catch {
    return null;
  }
}

export interface EvalResult {
  runId: string;
  analyzer: string;
  labelled: number;
  matching: { tp: number; fp: number; fn: number; tn: number; precision: number | null; recall: number | null };
  exposure: { tp: number; fp: number; fn: number; precision: number | null; recall: number | null };
  impact: { agree: number; total: number; confusion: Record<string, Record<string, number>> };
  reviewer: { agree: number; total: number };
  misses: { conversation_id: string; scenario: string; problem: string }[];
}

const ratio = (a: number, b: number) => (b === 0 ? null : a / b);
const MAP: Record<string, EvalLabel["true_impact"]> = { possible: "adverse", confirmed: "adverse", none_found: "none", insufficient_evidence: "indeterminate", not_assessed: "n/a" };

export function evaluate(db: DB, incidentId: string, labels: EvalLabel[]): EvalResult | null {
  const run = latestRun(db, incidentId);
  if (!run) return null;
  const findings = new Map((db.prepare("SELECT conversation_id, is_candidate, exposure, suggested_impact FROM findings WHERE run_id = ?").all(run.id) as { conversation_id: string; is_candidate: number; exposure: string; suggested_impact: string }[]).map((f) => [f.conversation_id, f]));
  const caseImpact = new Map((db.prepare("SELECT cc.conversation_id, c.impact, c.status, c.decided_by FROM case_conversations cc JOIN cases c ON c.id = cc.case_id").all() as { conversation_id: string; impact: string; status: string; decided_by: string | null }[]).map((r) => [r.conversation_id, r]));

  const m = { tp: 0, fp: 0, fn: 0, tn: 0 };
  const e = { tp: 0, fp: 0, fn: 0 };
  const confusion: Record<string, Record<string, number>> = {};
  let agree = 0, total = 0, rAgree = 0, rTotal = 0;
  const misses: EvalResult["misses"] = [];

  for (const l of labels) {
    const f = findings.get(l.conversation_id);
    if (!f) { misses.push({ conversation_id: l.conversation_id, scenario: l.scenario, problem: "not analyzed (not imported?)" }); continue; }
    const pc = f.is_candidate === 1;
    if (pc && l.should_be_candidate) m.tp++;
    else if (pc && !l.should_be_candidate) { m.fp++; misses.push({ conversation_id: l.conversation_id, scenario: l.scenario, problem: "matched but should be out of scope" }); }
    else if (!pc && l.should_be_candidate) { m.fn++; misses.push({ conversation_id: l.conversation_id, scenario: l.scenario, problem: "missed candidate" }); }
    else m.tn++;
    if (!l.should_be_candidate) continue;
    const pe = f.exposure === "exposed";
    if (pe && l.exposed) e.tp++;
    else if (pe && !l.exposed) { e.fp++; misses.push({ conversation_id: l.conversation_id, scenario: l.scenario, problem: "exposure flagged but advice was correct" }); }
    else if (!pe && l.exposed) { e.fn++; misses.push({ conversation_id: l.conversation_id, scenario: l.scenario, problem: "exposure missed" }); }
    if (l.exposed) {
      const pred = MAP[f.suggested_impact] ?? "n/a";
      confusion[l.true_impact] ??= {};
      confusion[l.true_impact][pred] = (confusion[l.true_impact][pred] ?? 0) + 1;
      total++;
      if (pred === l.true_impact) agree++;
      else misses.push({ conversation_id: l.conversation_id, scenario: l.scenario, problem: `suggested ${f.suggested_impact}, label ${l.true_impact}` });
      const ci = caseImpact.get(l.conversation_id);
      if (ci?.decided_by) { rTotal++; if ((MAP[ci.impact] ?? "n/a") === l.true_impact) rAgree++; }
    }
  }
  return {
    runId: run.id,
    analyzer: `${run.analyzer_id}@${run.analyzer_version}`,
    labelled: labels.length,
    matching: { ...m, precision: ratio(m.tp, m.tp + m.fp), recall: ratio(m.tp, m.tp + m.fn) },
    exposure: { ...e, precision: ratio(e.tp, e.tp + e.fp), recall: ratio(e.tp, e.tp + e.fn) },
    impact: { agree, total, confusion },
    reviewer: { agree: rAgree, total: rTotal },
    misses,
  };
}
