import type { ReactNode } from "react";
import {
  ACTION_STATUS_LABELS, ACTION_TYPE_LABELS, CASE_STATUS_LABELS, EXPOSURE_LABELS, IMPACT_LABELS,
  type ActionStatus, type ActionType, type CaseStatus, type Exposure, type Impact,
} from "@/lib/types";
import { formatInZone } from "@/lib/time";

type Tone = "neutral" | "info" | "ok" | "warn" | "bad" | "sim" | "outline";

export function Badge({ tone = "neutral", children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return <span className={`badge b-${tone}`} title={title}>{children}</span>;
}

const IMPACT_TONE: Record<Impact, Tone> = { not_assessed: "outline", possible: "warn", confirmed: "bad", none_found: "ok", insufficient_evidence: "neutral" };
export function ImpactBadge({ impact, suggested = false }: { impact: Impact; suggested?: boolean }) {
  return <Badge tone={IMPACT_TONE[impact]} title={suggested ? "Analyzer suggestion — not a determination" : "Reviewer determination"}>{suggested ? "Suggested: " : ""}{IMPACT_LABELS[impact]}</Badge>;
}

const EXPOSURE_TONE: Record<Exposure, Tone> = { exposed: "info", not_exposed: "ok", undetermined: "neutral" };
export function ExposureBadge({ exposure }: { exposure: Exposure }) {
  return <Badge tone={EXPOSURE_TONE[exposure]}>{EXPOSURE_LABELS[exposure]}</Badge>;
}

const CASE_TONE: Record<CaseStatus, Tone> = { unreviewed: "outline", in_review: "info", needs_evidence: "warn", reviewed: "info", match_rejected: "neutral", merged: "neutral", closed: "ok" };
export function CaseStatusBadge({ status }: { status: CaseStatus }) {
  return <Badge tone={CASE_TONE[status]}>{CASE_STATUS_LABELS[status]}</Badge>;
}

const ACTION_TONE: Record<ActionStatus, Tone> = { draft: "outline", under_review: "info", approved: "info", execution_recorded: "warn", verified_complete: "ok", needs_evidence: "warn", rejected: "neutral", failed: "bad", reopened: "bad" };
export function ActionStatusBadge({ status, simulated }: { status: ActionStatus; simulated?: boolean }) {
  return (
    <span className="row" style={{ gap: ".25rem", display: "inline-flex" }}>
      <Badge tone={ACTION_TONE[status]}>{ACTION_STATUS_LABELS[status]}</Badge>
      {simulated && <Badge tone="sim" title="Execution was simulated for demonstration; no real action was taken">Simulated</Badge>}
    </span>
  );
}

export function ActionTypeLabel({ type }: { type: ActionType }) {
  return <>{ACTION_TYPE_LABELS[type]}</>;
}

export function AnalyzerBadge({ isLive, id, version, model }: { isLive: boolean | number; id: string; version: string; model?: string | null }) {
  return isLive
    ? <Badge tone="info" title="Output from a live model call, validated server-side">Live model · {model} · {version}</Badge>
    : <Badge tone="sim" title="Deterministic rules, not a language model">Demo analyzer (rules-based) · {version}</Badge>;
}

export function Flash({ ok, err }: { ok?: string; err?: string }) {
  if (!ok && !err) return null;
  return (
    <div className={`alert ${err ? "err" : "ok"}`} role={err ? "alert" : "status"}>
      <p><strong>{err ? "Not saved: " : "Saved. "}</strong>{err ?? ok}</p>
    </div>
  );
}

export function money(cents: number | null | undefined, cur = "USD") {
  if (cents == null) return "—";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: cur }).format(cents / 100);
}

export function When({ iso, tz, date = false }: { iso: string | null | undefined; tz: string; date?: boolean }) {
  if (!iso) return <span className="faint">—</span>;
  return <time dateTime={iso} title={iso}>{formatInZone(iso, tz, !date)}</time>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function Card({ title, actions, children, id, flush }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; id?: string; flush?: boolean }) {
  return (
    <section className="card" id={id} aria-labelledby={id && title ? `${id}-h` : undefined}>
      {title && <div className="card-h"><h2 id={id ? `${id}-h` : undefined}>{title}</h2>{actions}</div>}
      <div className={`card-b${flush ? " flush" : ""}`}>{children}</div>
    </section>
  );
}
