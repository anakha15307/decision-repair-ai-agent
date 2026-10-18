import { describe, expect, it } from "vitest";
import { zonedToUtc } from "@/lib/time";
import { getIncident, isInIncidentWindow } from "@/lib/incidents";
import { addPolicyVersion, applicablePolicyAt, listPolicies } from "@/lib/policy";
import { runAnalysis } from "@/lib/analysis/engine";
import { demoProvider } from "@/lib/analysis/demoAnalyzer";
import { addCase, caseIdFor, freshIncident, INC, priya } from "./helpers";

describe("incident scope and timezone", () => {
  it("converts local incident times to UTC using the incident timezone (CDT = UTC-5)", () => {
    expect(zonedToUtc("2026-06-10T09:00", "America/Chicago")).toBe("2026-06-10T14:00:00.000Z");
    expect(zonedToUtc("2026-01-10T09:00", "America/Chicago")).toBe("2026-01-10T15:00:00.000Z"); // CST
  });

  it("treats the start as inclusive and the end as exclusive", () => {
    const db = freshIncident();
    const inc = getIncident(db, INC)!;
    expect(isInIncidentWindow(inc, "2026-06-10T13:59:59Z")).toBe(false);
    expect(isInIncidentWindow(inc, "2026-06-10T14:00:00Z")).toBe(true);
    expect(isInIncidentWindow(inc, "2026-07-22T18:59:59Z")).toBe(true);
    expect(isInIncidentWindow(inc, "2026-07-22T19:00:00Z")).toBe(false);
  });

  it("screens conversations by date, version, exclusions and topic", async () => {
    const db = freshIncident();
    const before = addCase(db, { start: "2026-06-10T08:59:00-05:00" });
    const atStart = addCase(db, { start: "2026-06-10T09:00:00-05:00" });
    const wrongVersion = addCase(db, { start: "2026-06-20T10:00:00-05:00", version: "v2-fixed" });
    const noVersion = addCase(db, { start: "2026-06-20T10:00:00-05:00", version: null });
    const testAcct = addCase(db, { start: "2026-06-20T10:00:00-05:00", customer: "TEST-1" });
    const offTopic = addCase(db, { start: "2026-06-20T10:00:00-05:00", customerText: "Where is my parcel?" });
    const humanOnly = addCase(db, { start: "2026-06-20T10:00:00-05:00", assistantText: null });
    await runAnalysis(db, priya, INC, demoProvider);
    const f = (id: string) => db.prepare("SELECT in_scope, is_candidate, scope_reasons FROM findings WHERE conversation_id = ?").get(id) as { in_scope: number; is_candidate: number; scope_reasons: string };
    expect(f(before.id).is_candidate).toBe(0);
    expect(f(atStart.id).is_candidate).toBe(1);
    expect(f(wrongVersion.id).is_candidate).toBe(0);
    expect(f(noVersion.id).is_candidate).toBe(1);
    expect(f(noVersion.id).scope_reasons).toContain("No model/application version recorded");
    expect(f(testAcct.id).is_candidate).toBe(0);
    expect(f(offTopic.id).in_scope).toBe(1);
    expect(f(offTopic.id).is_candidate).toBe(0);
    expect(f(humanOnly.id).is_candidate).toBe(0);
  });
});

describe("policy effective dates", () => {
  it("selects the authoritative policy in force at the moment of the conversation", () => {
    const db = freshIncident();
    const ps = listPolicies(db, INC);
    expect(applicablePolicyAt(ps, "2026-06-30T23:00:00-05:00")?.version).toBe("3.0");
    expect(applicablePolicyAt(ps, "2026-07-01T00:00:00-05:00")?.version).toBe("3.1");
  });

  it("never applies a policy introduced after the incident, even for later dates", () => {
    const db = freshIncident();
    const ps = listPolicies(db, INC);
    const atLater = applicablePolicyAt(ps, "2026-10-01T12:00:00Z");
    expect(atLater).toBeNull(); // 3.1 ended 15 Sep; 4.0 is introduced_after and excluded
    expect(ps.find((p) => p.version === "4.0")?.role).toBe("introduced_after");
  });

  it("refuses an 'introduced after' policy that starts inside the incident period", () => {
    const db = freshIncident();
    expect(() => addPolicyVersion(db, priya, INC, { version: "9.9", role: "introduced_after", effective_from: "2026-07-10", timezone: "America/Chicago", text: "[RW] Refund window: 90 days from purchase.", params: { window_days: 90, sale_refundable: true, proof: "receipt_or_order", defective_window_days: null } }))
      .toThrow(/after the incident period ends/);
  });

  it("refuses overlapping authoritative versions", () => {
    const db = freshIncident();
    expect(() => addPolicyVersion(db, priya, INC, { version: "3.0b", role: "authoritative", effective_from: "2026-06-15", effective_to: "2026-06-20", timezone: "America/Chicago", text: "[RW] Refund window: 30 days from purchase.", params: { window_days: 30, sale_refundable: true, proof: "receipt_or_order", defective_window_days: null } }))
      .toThrow(/overlapping/);
  });

  it("assesses a defective item against the policy change mid-period (60-day window only from 1 July)", async () => {
    const db = freshIncident();
    const beforeChange = addCase(db, { start: "2026-06-25T10:00:00-05:00", daysSincePurchase: 40, defective: true });
    const afterChange = addCase(db, { start: "2026-07-10T10:00:00-05:00", daysSincePurchase: 40, defective: true });
    await runAnalysis(db, priya, INC, demoProvider);
    const c = (id: string) => db.prepare("SELECT suggested_impact FROM cases WHERE id = ?").get(caseIdFor(db, id)) as { suggested_impact: string };
    expect(c(beforeChange.id).suggested_impact).toBe("none_found"); // v3.0: 30 days only
    expect(c(afterChange.id).suggested_impact).toBe("possible"); // v3.1: defective 60 days
    const f = db.prepare("SELECT applicable_policy_id FROM findings WHERE conversation_id = ?").get(afterChange.id) as { applicable_policy_id: string };
    expect(f.applicable_policy_id).toBe("POL-REFUND-3.1");
  });
});
