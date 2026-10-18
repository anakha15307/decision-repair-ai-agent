import { z } from "zod";
import type { Exposure, Impact } from "../types";
import type { Incident } from "../incidents";
import type { PolicyVersion } from "../policy";

// Data handed to an analysis provider for one candidate conversation. Everything here is
// investigation input only; hidden evaluation labels never enter this structure.

export interface MessageRec { id: string; conversation_id: string; seq: number; role: string; ts: string; text: string; flags: string[] }
export interface ConversationRec { id: string; customer_id: string; channel: string; started_at: string; app_version: string | null; order_id: string | null }
export interface TransactionRec {
  id: string; customer_id: string; order_id: string; type: string; amount_cents: number; currency: string;
  ts: string; status: string; item_category: string | null; sale_item: number | null; defective: number | null;
}
export interface InteractionRec { id: string; customer_id: string; order_id: string | null; ts: string; channel: string; outcome: string; summary: string; flags: string[] }

export interface CaseContext {
  incident: Incident;
  policies: PolicyVersion[];
  /** Authoritative policy in force when the conversation started (never a later policy). */
  applicable: PolicyVersion | null;
  /** The outdated/incorrect policy the AI relied on, if registered. */
  incorrect: PolicyVersion | null;
  conversation: ConversationRec;
  messages: MessageRec[];
  /** This customer's transactions and later interactions only. */
  transactions: TransactionRec[];
  interactions: InteractionRec[];
  /** Every reference the provider is allowed to cite. */
  allowedRefs: Set<string>;
}

export interface ProvisionFinding {
  code: string;
  incorrect_statement: string;
  applicable_rule: string;
  policy_id: string | null;
}

export interface FindingDraft {
  exposure: Exposure;
  /** Providers may never suggest "confirmed"; that is a human determination. */
  suggested_impact: Exclude<Impact, "confirmed">;
  explanation: string;
  provisions: ProvisionFinding[];
  supporting: { ref: string; note: string }[];
  gaps: string[];
  conflicts: { text: string; refs: string[] }[];
  facts: Record<string, unknown>;
}

export interface AnalysisProvider {
  id: string;
  version: string;
  isLive: boolean;
  model: string | null;
  label: string;
  assess(ctx: CaseContext): Promise<FindingDraft>;
}

export const FindingDraftSchema = z.object({
  exposure: z.enum(["exposed", "not_exposed", "undetermined"]),
  suggested_impact: z.enum(["not_assessed", "possible", "none_found", "insufficient_evidence"]),
  explanation: z.string().min(1).max(4000),
  provisions: z.array(z.object({
    code: z.string().min(1).max(32),
    incorrect_statement: z.string().max(2000),
    applicable_rule: z.string().max(2000),
    policy_id: z.string().nullable(),
  })).max(20),
  supporting: z.array(z.object({ ref: z.string(), note: z.string().max(1000) })).max(50),
  gaps: z.array(z.string().max(1000)).max(30),
  conflicts: z.array(z.object({ text: z.string().max(1000), refs: z.array(z.string()).max(20) })).max(20),
  facts: z.record(z.unknown()).default({}),
});

export interface DraftValidation {
  ok: boolean;
  draft: FindingDraft | null;
  errors: string[];
}

/**
 * Validate a provider's output: schema, no "confirmed" impact, every cited reference must
 * be among the evidence provided, and an exposure finding must cite at least one message.
 */
export function validateDraft(raw: unknown, allowedRefs: Set<string>): DraftValidation {
  const parsed = FindingDraftSchema.safeParse(raw);
  if (!parsed.success) {
    const confirmed = typeof raw === "object" && raw !== null && (raw as { suggested_impact?: unknown }).suggested_impact === "confirmed";
    return {
      ok: false,
      draft: null,
      errors: confirmed
        ? ["Provider suggested 'confirmed' impact; only a human reviewer may confirm impact."]
        : parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
    };
  }
  const d = parsed.data as FindingDraft;
  const errors: string[] = [];
  const cited = [...d.supporting.map((s) => s.ref), ...d.conflicts.flatMap((c) => c.refs)];
  for (const ref of cited) if (!allowedRefs.has(ref)) errors.push(`Unsupported evidence reference: ${ref}`);
  if (d.exposure === "exposed" && !d.supporting.some((s) => s.ref.startsWith("msg:"))) {
    errors.push("An exposure finding must cite at least one conversation message.");
  }
  if (d.supporting.length === 0) errors.push("Finding cites no supporting evidence.");
  return { ok: errors.length === 0, draft: errors.length ? null : d, errors };
}
