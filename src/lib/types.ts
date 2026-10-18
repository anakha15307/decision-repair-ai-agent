// Core domain vocabulary for Decision Repair.
// Exposure, impact assessment, case workflow status and corrective-action status are
// deliberately separate dimensions: one never implies another.

export type Role = "governance_lead" | "case_reviewer" | "ops_lead" | "auditor";

export interface Actor {
  id: string;
  name: string;
  role: Role;
}

/** Was the person shown the incorrect information? */
export type Exposure = "exposed" | "not_exposed" | "undetermined";

/**
 * Assessment of adverse impact. Only a human reviewer may set "confirmed",
 * and only against the incident's reviewer-defined criteria.
 */
export type Impact =
  | "not_assessed"
  | "possible"
  | "confirmed"
  | "none_found"
  | "insufficient_evidence";

export const IMPACT_LABELS: Record<Impact, string> = {
  not_assessed: "Not assessed",
  possible: "Possible adverse impact",
  confirmed: "Confirmed adverse impact",
  none_found: "No adverse impact found",
  insufficient_evidence: "Insufficient evidence",
};

export const EXPOSURE_LABELS: Record<Exposure, string> = {
  exposed: "Exposed to incorrect information",
  not_exposed: "Not exposed",
  undetermined: "Exposure undetermined",
};

/** Case workflow status. Independent of classification. */
export type CaseStatus =
  | "unreviewed"
  | "in_review"
  | "needs_evidence"
  | "reviewed"
  | "match_rejected"
  | "merged"
  | "closed";

export const CASE_STATUS_LABELS: Record<CaseStatus, string> = {
  unreviewed: "Unreviewed",
  in_review: "In review",
  needs_evidence: "Needs evidence",
  reviewed: "Reviewed",
  match_rejected: "Match rejected",
  merged: "Merged",
  closed: "Closed",
};

export type ActionType =
  | "clarification"
  | "reopen_request"
  | "refund_review"
  | "escalation"
  | "no_action";

export const ACTION_TYPE_LABELS: Record<ActionType, string> = {
  clarification: "Clarification or correction",
  reopen_request: "Reopen the original request",
  refund_review: "Refund review",
  escalation: "Escalate to qualified specialist",
  no_action: "No action (justified)",
};

export type ActionStatus =
  | "draft"
  | "under_review"
  | "approved"
  | "execution_recorded"
  | "verified_complete"
  | "needs_evidence"
  | "rejected"
  | "failed"
  | "reopened";

export const ACTION_STATUS_LABELS: Record<ActionStatus, string> = {
  draft: "Draft",
  under_review: "Under review",
  approved: "Approved",
  execution_recorded: "Execution recorded",
  verified_complete: "Verified complete",
  needs_evidence: "Needs evidence",
  rejected: "Rejected",
  failed: "Failed",
  reopened: "Reopened",
};

/** A typed pointer into imported evidence, e.g. "msg:CONV-1042#3". */
export type EvidenceRef = string;

export interface PolicyParams {
  /** Standard refund window in days from purchase. */
  window_days: number;
  /** Are discounted / sale items refundable? */
  sale_refundable: boolean;
  /** What proof of purchase is required. */
  proof: "receipt" | "receipt_or_order";
  /** Extended window for defective items, if the version has one. */
  defective_window_days: number | null;
}

export type PolicyRole =
  | "authoritative" // the policy the organization actually had in force
  | "incorrect_used" // the outdated/incorrect policy the AI relied on
  | "introduced_after"; // later policy; must not be used for determinations

export interface ScopeCriteria {
  affected_versions: string[];
  /** Include conversations with no recorded version if inside the date window. */
  include_unknown_versions: boolean;
  topic_keywords: string[];
  excluded_customer_prefixes: string[];
  exclude_without_assistant_messages: boolean;
}

export interface ImpactCriterion {
  id: string;
  text: string;
}
