import { beforeAll, describe, expect, it } from "vitest";
import { openDb, type DB } from "@/lib/db";
import { computeDashboard } from "@/lib/metrics";
import { seed, DEMO_INCIDENT_ID } from "../scripts/seed";

let db: DB;
const n = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
const metric = (key: string) => computeDashboard(db, DEMO_INCIDENT_ID).metrics.find((m) => m.key === key)!;

beforeAll(async () => {
  db = openDb(":memory:");
  await seed(db);
});

describe("dashboard counting on the seeded demo incident", () => {
  it("counts candidate interactions from the latest run only (two runs exist)", () => {
    expect(n("SELECT COUNT(*) n FROM analysis_runs")).toBe(2);
    const latest = n("SELECT COUNT(*) n FROM findings WHERE is_candidate = 1 AND run_id = (SELECT id FROM analysis_runs ORDER BY started_at DESC LIMIT 1)");
    expect(metric("candidates").value).toBe(latest);
    expect(n("SELECT COUNT(*) n FROM findings WHERE is_candidate = 1")).toBeGreaterThan(latest); // findings across runs are not summed
  });

  it("counts unique customers once, excluding merged duplicates and rejected matches", () => {
    const distinct = n("SELECT COUNT(DISTINCT customer_id) n FROM cases WHERE status NOT IN ('merged','match_rejected') AND exposure IN ('exposed','undetermined')");
    const rows = n("SELECT COUNT(*) n FROM cases WHERE status NOT IN ('merged','match_rejected') AND exposure IN ('exposed','undetermined')");
    expect(metric("customers").value).toBe(distinct);
    expect(rows).toBeGreaterThan(distinct); // a customer with two unmerged duplicate cases exists
    expect(n("SELECT COUNT(*) n FROM cases WHERE status = 'merged'")).toBe(1);
  });

  it("counts confirmed impact only from reviewer determinations", () => {
    expect(metric("confirmed").value).toBe(n("SELECT COUNT(*) n FROM cases WHERE impact = 'confirmed' AND status NOT IN ('merged','match_rejected')"));
    expect(n("SELECT COUNT(*) n FROM cases WHERE suggested_impact = 'confirmed'")).toBe(0);
  });

  it("separates approved, executed and verified, and excludes simulated from verified", () => {
    expect(metric("approved").value).toBe(5);
    expect(metric("approved").detail).toMatch(/^1 approved but not yet executed/);
    expect(metric("executed").value).toBe(4);
    expect(metric("executed").detail).toBe("includes 1 simulated");
    expect(metric("verified").value).toBe(3);
    expect(metric("verified").detail).toMatch(/^1 simulated verification\(s\) not counted · 1 failed or reopened/);
  });

  it("reports proposed, approved and verified refund amounts separately", () => {
    const d = computeDashboard(db, DEMO_INCIDENT_ID);
    const verified = n("SELECT COALESCE(SUM(verified_amount_cents),0) n FROM corrective_actions WHERE status='verified_complete' AND execution_mode='recorded'");
    expect(d.money.verifiedCents).toBe(verified);
    expect(d.money.verifiedCents).toBeGreaterThan(0);
    expect(d.money.proposedCents).toBeGreaterThan(d.money.approvedCents);
    expect(d.money.approvedCents).toBeGreaterThan(d.money.verifiedCents);
    expect(d.money.simulatedCents).toBe(0); // simulated action in seed is a reopen request, not a refund
  });

  it("measures time to resolution only for closed cases with real verification", () => {
    expect(metric("ttr").detail).toBe("n = 2 closed case(s)");
  });
});
