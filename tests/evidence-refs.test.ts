import { describe, expect, it } from "vitest";
import { validateRefs, resolveRef } from "@/lib/evidence";
import { validateDraft, type AnalysisProvider, type FindingDraft } from "@/lib/analysis/provider";
import { runAnalysis } from "@/lib/analysis/engine";
import { buildPrompt } from "@/lib/analysis/anthropicProvider";
import { demoAssess, demoProvider } from "@/lib/analysis/demoAnalyzer";
import { recordDetermination, addNote, getCaseRow } from "@/lib/cases";
import { addCase, caseIdFor, freshIncident, INC, marcus, priya } from "./helpers";

describe("evidence reference validation", () => {
  it("accepts existing references and rejects malformed, missing, or other-customer references", () => {
    const db = freshIncident();
    const a = addCase(db, { start: "2026-06-20T10:00:00-05:00" });
    const b = addCase(db, { start: "2026-06-21T10:00:00-05:00" });
    const v = validateRefs(db, [`msg:${a.id}#1`, `txn:TXN-P-${a.id}`, "pol:POL-REFUND-3.0#RW", "msg:NOPE#1", "not a ref", `txn:TXN-P-${b.id}`, `msg:${a.id}#99`], { incidentId: INC, customerIds: [a.customer] });
    expect(v.valid.map((r) => r.ref)).toEqual([`msg:${a.id}#1`, `txn:TXN-P-${a.id}`, "pol:POL-REFUND-3.0#RW"]);
    expect(v.invalid.map((i) => i.reason)).toEqual(["no such record in the evidence store", "malformed reference", "belongs to a different customer", "no such record in the evidence store"]);
    expect(resolveRef(db, "pol:POL-REFUND-3.1#DEF")?.excerpt).toMatch(/60 days/);
  });

  it("rejects provider output that cites unsupported references, suggests 'confirmed', or omits message evidence", () => {
    const allowed = new Set(["msg:C1#1", "txn:T1"]);
    const base: FindingDraft = { exposure: "exposed", suggested_impact: "possible", explanation: "x", provisions: [], supporting: [{ ref: "msg:C1#1", note: "said 14 days" }], gaps: [], conflicts: [], facts: {} };
    expect(validateDraft(base, allowed).ok).toBe(true);
    expect(validateDraft({ ...base, supporting: [...base.supporting, { ref: "txn:INVENTED", note: "" }] }, allowed).errors).toContain("Unsupported evidence reference: txn:INVENTED");
    expect(validateDraft({ ...base, conflicts: [{ text: "x", refs: ["int:GHOST"] }] }, allowed).ok).toBe(false);
    expect(validateDraft({ ...base, suggested_impact: "confirmed" }, allowed).errors[0]).toMatch(/only a human reviewer/);
    expect(validateDraft({ ...base, supporting: [{ ref: "txn:T1", note: "" }] }, allowed).errors).toContain("An exposure finding must cite at least one conversation message.");
    expect(validateDraft({ exposure: "exposed" }, allowed).ok).toBe(false);
  });

  it("stores a rejected finding (not the provider's claim) when a provider cites invented evidence", async () => {
    const db = freshIncident();
    const a = addCase(db, { start: "2026-06-20T10:00:00-05:00" });
    const lying: AnalysisProvider = {
      id: "fake-live", version: "t-1", isLive: true, model: "fake-model", label: "Fake live model",
      async assess(ctx) { return { ...demoAssess(ctx), supporting: [{ ref: `msg:${a.id}#2`, note: "ok" }, { ref: "txn:TXN-FABRICATED", note: "refund was denied in writing" }] }; },
    };
    const s = await runAnalysis(db, priya, INC, lying);
    expect(s.rejectedOutputs).toBe(1);
    const f = db.prepare("SELECT exposure, suggested_impact, flags, explanation FROM findings WHERE conversation_id = ?").get(a.id) as Record<string, string>;
    expect(f.exposure).toBe("undetermined");
    expect(f.suggested_impact).toBe("insufficient_evidence");
    expect(JSON.parse(f.flags)).toContain("analysis_output_rejected");
    expect(f.explanation).toContain("TXN-FABRICATED");
    const run = db.prepare("SELECT analyzer_id, analyzer_version, is_live, model FROM analysis_runs").get();
    expect(run).toEqual({ analyzer_id: "fake-live", analyzer_version: "t-1", is_live: 1, model: "fake-model" });
  });

  it("refuses reviewer decisions and notes that cite another customer's evidence", async () => {
    const db = freshIncident();
    const a = addCase(db, { start: "2026-06-20T10:00:00-05:00" });
    const b = addCase(db, { start: "2026-06-21T10:00:00-05:00" });
    await runAnalysis(db, priya, INC, demoProvider);
    const ca = caseIdFor(db, a.id);
    expect(() => addNote(db, marcus, ca, "see their record", [`txn:TXN-P-${b.id}`])).toThrow(/different customer/);
    expect(() => recordDetermination(db, marcus, ca, { exposure: "exposed", impact: "possible", evidenceRefs: ["txn:NOPE"] })).toThrow(/Unsupported evidence/);
    expect(getCaseRow(db, ca)!.decided_by).toBeNull();
  });

  it("minimizes data in a live-model prompt: no customer ID, identifiers redacted, untrusted content delimited", async () => {
    const db = freshIncident();
    const a = addCase(db, { start: "2026-06-20T10:00:00-05:00", customer: "SYN-PRIVATE-42", customerText: "Refund please, email me at jo@example.com or +1 312 555 0199." });
    let prompt = "";
    const capture: AnalysisProvider = { id: "capture", version: "t", isLive: true, model: "m", label: "capture", async assess(ctx) { prompt = buildPrompt(ctx); return demoAssess(ctx); } };
    await runAnalysis(db, priya, INC, capture);
    expect(prompt).not.toContain("SYN-PRIVATE-42");
    expect(prompt).not.toContain("jo@example.com");
    expect(prompt).not.toContain("555 0199");
    expect(prompt).toContain("<untrusted source=\"customer\">");
    expect(prompt).toContain(`ref msg:${a.id}#1`);
    expect(prompt).not.toMatch(/Refund Policy — version 4\.0/); // later policy not sent as applicable
  });
});
