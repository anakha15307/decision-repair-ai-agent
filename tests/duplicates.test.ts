import { describe, expect, it } from "vitest";
import { importEvidence } from "@/lib/importers";
import { runAnalysis } from "@/lib/analysis/engine";
import { demoProvider } from "@/lib/analysis/demoAnalyzer";
import { mergeCases, getCaseRow, getCaseDetail } from "@/lib/cases";
import { computeDashboard } from "@/lib/metrics";
import { proposeAction } from "@/lib/remediation";
import { addCase, caseIdFor, freshIncident, INC, marcus, priya } from "./helpers";

const conv = (id: string) => ({ conversation_id: id, customer_id: "SYN-X", messages: [{ seq: 1, role: "customer", timestamp: "2026-06-20T10:00:00-05:00", text: "refund please" }] });

describe("duplicate handling", () => {
  it("refuses re-importing an identical file", () => {
    const db = freshIncident();
    const content = JSON.stringify([conv("CONV-D1")]);
    expect(importEvidence(db, priya, INC, { kind: "conversations", format: "json", filename: "a.json", content }).ok).toBe(true);
    const again = importEvidence(db, priya, INC, { kind: "conversations", format: "json", filename: "a-copy.json", content });
    expect(again.ok).toBe(false);
    expect(again.issues[0].message).toMatch(/already imported/);
  });

  it("refuses duplicate record IDs within a file and against stored evidence, importing nothing", () => {
    const db = freshIncident();
    const dupInFile = importEvidence(db, priya, INC, { kind: "conversations", format: "json", filename: "b.json", content: JSON.stringify([conv("CONV-D2"), conv("CONV-D2")]) });
    expect(dupInFile.ok).toBe(false);
    expect(dupInFile.issues.some((i) => /Duplicate conversation_id/.test(i.message))).toBe(true);
    expect(db.prepare("SELECT COUNT(*) n FROM conversations WHERE id = 'CONV-D2'").get()).toEqual({ n: 0 });

    importEvidence(db, priya, INC, { kind: "conversations", format: "json", filename: "c.json", content: JSON.stringify([conv("CONV-D3")]) });
    const exists = importEvidence(db, priya, INC, { kind: "conversations", format: "json", filename: "d.json", content: JSON.stringify([{ ...conv("CONV-D3"), channel: "email" }]) });
    expect(exists.ok).toBe(false);
    expect(exists.issues[0].message).toMatch(/already exists/);
  });

  it("flags duplicate cases for the same customer and order without merging automatically", async () => {
    const db = freshIncident();
    const a = addCase(db, { start: "2026-06-20T10:00:00-05:00", customer: "SYN-DUP", order: "ORD-DUP" });
    const b = addCase(db, { start: "2026-06-22T10:00:00-05:00", customer: "SYN-DUP", order: "ORD-DUP" });
    await runAnalysis(db, priya, INC, demoProvider);
    const ca = caseIdFor(db, a.id), cb = caseIdFor(db, b.id);
    expect(ca).not.toBe(cb);
    expect(getCaseRow(db, cb)!.possible_duplicate_of).toBe(ca);
    expect(getCaseRow(db, cb)!.status).toBe("unreviewed");
  });

  it("merges a duplicate into its target and counts the customer once", async () => {
    const db = freshIncident();
    const a = addCase(db, { start: "2026-06-20T10:00:00-05:00", customer: "SYN-DUP", order: "ORD-DUP" });
    const b = addCase(db, { start: "2026-06-22T10:00:00-05:00", customer: "SYN-DUP", order: "ORD-DUP" });
    addCase(db, { start: "2026-06-23T10:00:00-05:00" });
    await runAnalysis(db, priya, INC, demoProvider);
    const ca = caseIdFor(db, a.id), cb = caseIdFor(db, b.id);

    const before = computeDashboard(db, INC);
    expect(before.metrics.find((m) => m.key === "customers")!.value).toBe(2); // distinct customers even before merge

    mergeCases(db, marcus, cb, ca, "Same customer and order; retry two days later.");
    expect(getCaseRow(db, cb)!.status).toBe("merged");
    expect(getCaseRow(db, cb)!.merged_into).toBe(ca);
    expect(getCaseDetail(db, ca)!.conversations.map((c) => c.id).sort()).toEqual([a.id, b.id].sort());
    expect(getCaseDetail(db, ca)!.mergedFrom).toEqual([cb]);

    const after = computeDashboard(db, INC);
    expect(after.metrics.find((m) => m.key === "customers")!.value).toBe(2);
    expect(after.metrics.find((m) => m.key === "reviewed")!.value).toBe("0 / 2"); // merged case excluded from totals
    // Re-running analysis keeps the merge: the moved conversation updates the target, not a new case.
    const s = await runAnalysis(db, priya, INC, demoProvider);
    expect(s.casesCreated).toBe(0);
  });

  it("refuses merging cases of different customers, and merging a case with active actions", async () => {
    const db = freshIncident();
    const a = addCase(db, { start: "2026-06-20T10:00:00-05:00" });
    const b = addCase(db, { start: "2026-06-21T10:00:00-05:00" });
    const c = addCase(db, { start: "2026-06-21T11:00:00-05:00", customer: "SYN-SAME", order: "ORD-S1" });
    const d = addCase(db, { start: "2026-06-21T12:00:00-05:00", customer: "SYN-SAME", order: "ORD-S2" });
    await runAnalysis(db, priya, INC, demoProvider);
    expect(() => mergeCases(db, marcus, caseIdFor(db, a.id), caseIdFor(db, b.id), "Trying to merge two people.")).toThrow(/same customer/);
    const cd = caseIdFor(db, d.id);
    db.prepare("UPDATE cases SET status = 'in_review' WHERE id = ?").run(cd);
    proposeAction(db, marcus, cd, { type: "clarification", summary: "Correct the record", justification: "Customer heard wrong terms." });
    expect(() => mergeCases(db, marcus, cd, caseIdFor(db, c.id), "Merge with active action present.")).toThrow(/corrective actions/);
  });
});
