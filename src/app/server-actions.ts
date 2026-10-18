"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { getDb } from "@/lib/db";
import { DomainError, PermissionError, getActor } from "@/lib/actors";
import { ACTOR_COOKIE, INCIDENT_COOKIE, currentActor } from "@/lib/session";
import { createIncident, addKnownGap } from "@/lib/incidents";
import { addPolicyVersion } from "@/lib/policy";
import { importEvidence, type ImportResult, type ImportKind } from "@/lib/importers";
import { runAnalysis } from "@/lib/analysis/engine";
import * as cases from "@/lib/cases";
import * as rem from "@/lib/remediation";
import type { ActionType, Exposure, Impact } from "@/lib/types";

// Every mutation goes through the domain services, which enforce permissions server-side
// and write the audit history. The UI's role switcher is a demo stand-in for authentication.

const str = (f: FormData, k: string) => String(f.get(k) ?? "").trim();
const refs = (f: FormData, k = "refs") => str(f, k).split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
const cents = (v: string) => (v === "" ? null : Math.round(Number(v.replace(/[$,]/g, "")) * 100));

function back(to: string, kind: "ok" | "err", msg: string): never {
  const [path, hash] = to.split("#");
  redirect(`${path}${path.includes("?") ? "&" : "?"}${kind}=${encodeURIComponent(msg)}${hash ? `#${hash}` : ""}`);
}

async function run(to: string, okMsg: string | (() => string), fn: () => unknown | Promise<unknown>): Promise<never> {
  let error: string | null = null;
  try {
    await fn();
  } catch (e) {
    if (e instanceof DomainError || e instanceof PermissionError) error = e.message;
    else { console.error(e); error = `Unexpected error: ${(e as Error).message}`; }
  }
  revalidatePath("/", "layout");
  return back(to, error ? "err" : "ok", error ?? (typeof okMsg === "function" ? okMsg() : okMsg));
}

export async function switchActor(formData: FormData) {
  const actor = getActor(str(formData, "actor"));
  (await cookies()).set(ACTOR_COOKIE, actor.id, { path: "/", sameSite: "lax", httpOnly: true });
  redirect(str(formData, "returnTo") || "/");
}

export async function switchIncident(formData: FormData) {
  (await cookies()).set(INCIDENT_COOKIE, str(formData, "incident"), { path: "/", sameSite: "lax", httpOnly: true });
  redirect("/");
}

export async function createIncidentAction(_: unknown, formData: FormData): Promise<{ error: string | null }> {
  const actor = await currentActor();
  let id: string | null = null;
  try {
    const inc = createIncident(getDb(), actor, {
      title: str(formData, "title"), description: str(formData, "description"), ai_system: str(formData, "ai_system"),
      known_versions: str(formData, "known_versions"), start_local: str(formData, "start_local"), end_local: str(formData, "end_local"),
      timezone: str(formData, "timezone"), incorrect_behavior: str(formData, "incorrect_behavior"),
      scope: {
        affected_versions: str(formData, "affected_versions"), include_unknown_versions: formData.get("include_unknown_versions") === "on",
        topic_keywords: str(formData, "topic_keywords"), excluded_customer_prefixes: str(formData, "excluded_customer_prefixes"),
        exclude_without_assistant_messages: formData.get("exclude_without_assistant_messages") === "on",
      },
      exclusions: str(formData, "exclusions"), impact_criteria: str(formData, "impact_criteria"),
      owner: str(formData, "owner") || actor.id, reviewers: formData.getAll("reviewers").map(String), known_gaps: str(formData, "known_gaps"),
    });
    id = inc.id;
  } catch (e) {
    if (e instanceof DomainError || e instanceof PermissionError) return { error: e.message };
    throw e;
  }
  (await cookies()).set(INCIDENT_COOKIE, id, { path: "/", sameSite: "lax", httpOnly: true });
  revalidatePath("/", "layout");
  redirect(`/incidents/${id}?tab=setup&ok=${encodeURIComponent("Incident registered. Add the policy versions next.")}`);
}

export async function addPolicyAction(formData: FormData) {
  const actor = await currentActor();
  const incidentId = str(formData, "incidentId");
  const def = str(formData, "defective_window_days");
  await run(`/incidents/${incidentId}?tab=setup#policies`, "Policy version added.", () =>
    addPolicyVersion(getDb(), actor, incidentId, {
      policy_key: str(formData, "policy_key") || "refund", version: str(formData, "version"), role: str(formData, "role"),
      effective_from: str(formData, "effective_from"), effective_to: str(formData, "effective_to") || null, timezone: str(formData, "timezone"),
      text: str(formData, "text"),
      params: { window_days: str(formData, "window_days"), sale_refundable: formData.get("sale_refundable") === "on", proof: str(formData, "proof"), defective_window_days: def === "" ? null : def },
    }),
  );
}

export async function addGapAction(formData: FormData) {
  const actor = await currentActor();
  const incidentId = str(formData, "incidentId");
  await run(`/incidents/${incidentId}?tab=setup#gaps`, "Known gap recorded.", () => addKnownGap(getDb(), actor, incidentId, str(formData, "gap")));
}

export async function importAction(_: unknown, formData: FormData): Promise<ImportResult & { error?: string; filename?: string }> {
  const actor = await currentActor();
  const incidentId = str(formData, "incidentId");
  const kind = str(formData, "kind") as ImportKind;
  const file = formData.get("file");
  let content = str(formData, "content");
  let filename = "pasted-content";
  if (file instanceof File && file.size > 0) { content = await file.text(); filename = file.name; }
  const format = (str(formData, "format") || (filename.endsWith(".csv") ? "csv" : "json")) as "csv" | "json";
  if (!content) return { ok: false, recordCount: 0, flagged: [], issues: [{ row: null, field: null, message: "Choose a file or paste content." }] };
  try {
    const r = importEvidence(getDb(), actor, incidentId, { kind, format, filename, content });
    revalidatePath("/", "layout");
    return { ...r, filename };
  } catch (e) {
    if (e instanceof DomainError || e instanceof PermissionError) return { ok: false, recordCount: 0, flagged: [], issues: [], error: e.message };
    throw e;
  }
}

export async function runAnalysisAction(formData: FormData) {
  const actor = await currentActor();
  const incidentId = str(formData, "incidentId");
  let msg = "Analysis complete.";
  await run(`/incidents/${incidentId}?tab=investigation`, () => msg, async () => {
    const s = await runAnalysis(getDb(), actor, incidentId);
    msg = `${s.analyzer}: ${s.candidates} candidate interactions, ${s.exposed} with incorrect information, ${s.casesCreated} new case(s), ${s.casesUpdated} updated, ${s.rejectedOutputs} output(s) rejected.`;
  });
}

// ---------- Case review ----------
const caseUrl = (id: string, hash = "") => `/review/${id}${hash ? `#${hash}` : ""}`;

export async function startReviewAction(formData: FormData) {
  const actor = await currentActor(); const id = str(formData, "caseId");
  await run(caseUrl(id), "Review started.", () => cases.startReview(getDb(), actor, id));
}

export async function determinationAction(formData: FormData) {
  const actor = await currentActor(); const id = str(formData, "caseId");
  await run(caseUrl(id, "review"), "Determination recorded.", () =>
    cases.recordDetermination(getDb(), actor, id, {
      exposure: str(formData, "exposure") as Exposure, impact: str(formData, "impact") as Exclude<Impact, "not_assessed">,
      criteriaMet: formData.getAll("criteria").map(String), reason: str(formData, "reason"), evidenceRefs: refs(formData),
    }),
  );
}

export async function rejectMatchAction(formData: FormData) {
  const actor = await currentActor(); const id = str(formData, "caseId");
  await run(caseUrl(id, "review"), "Match rejected.", () => cases.rejectMatch(getDb(), actor, id, str(formData, "reason")));
}

export async function reopenMatchAction(formData: FormData) {
  const actor = await currentActor(); const id = str(formData, "caseId");
  await run(caseUrl(id, "review"), "Match reopened.", () => cases.reopenMatch(getDb(), actor, id, str(formData, "reason")));
}

export async function requestEvidenceAction(formData: FormData) {
  const actor = await currentActor(); const id = str(formData, "caseId");
  await run(caseUrl(id, "review"), "Evidence requested.", () => cases.requestEvidence(getDb(), actor, id, str(formData, "reason")));
}

export async function evidenceReceivedAction(formData: FormData) {
  const actor = await currentActor(); const id = str(formData, "caseId");
  await run(caseUrl(id, "review"), "Evidence linked; case back in review.", () => cases.recordEvidenceReceived(getDb(), actor, id, refs(formData), str(formData, "reason")));
}

export async function noteAction(formData: FormData) {
  const actor = await currentActor(); const id = str(formData, "caseId");
  await run(caseUrl(id, "history"), "Note added.", () => cases.addNote(getDb(), actor, id, str(formData, "note"), refs(formData)));
}

export async function mergeAction(formData: FormData) {
  const actor = await currentActor(); const id = str(formData, "caseId"); const target = str(formData, "target");
  await run(caseUrl(target || id), `Merged ${id} into ${target}.`, () => cases.mergeCases(getDb(), actor, id, target, str(formData, "reason")));
}

export async function closeCaseAction(formData: FormData) {
  const actor = await currentActor(); const id = str(formData, "caseId");
  await run(caseUrl(id), "Case closed.", () => cases.closeCase(getDb(), actor, id, str(formData, "reason")));
}

// ---------- Corrective actions ----------
export async function proposeActionAction(formData: FormData) {
  const actor = await currentActor(); const id = str(formData, "caseId");
  await run(caseUrl(id, "actions"), "Corrective action drafted. Nothing has been sent or executed.", () =>
    rem.proposeAction(getDb(), actor, id, {
      type: str(formData, "type") as ActionType, summary: str(formData, "summary"), justification: str(formData, "justification"),
      proposedAmountCents: cents(str(formData, "amount")), communicationDraft: str(formData, "communication") || null,
    }),
  );
}

export async function editDraftAction(formData: FormData) {
  const actor = await currentActor(); const id = str(formData, "actionId"); const caseId = str(formData, "caseId");
  const amount = str(formData, "amount");
  await run(caseUrl(caseId, id), "Draft saved (not sent).", () =>
    rem.editDraft(getDb(), actor, id, { summary: str(formData, "summary"), justification: str(formData, "justification"), communicationDraft: String(formData.get("communication") ?? ""), ...(amount ? { proposedAmountCents: cents(amount) } : {}) }),
  );
}

export async function actionTransition(formData: FormData) {
  const actor = await currentActor();
  const db = getDb();
  const id = str(formData, "actionId"); const caseId = str(formData, "caseId"); const op = str(formData, "op");
  const to = str(formData, "returnTo") || caseUrl(caseId, id);
  const reason = str(formData, "reason");
  const labels: Record<string, string> = {
    submit: "Submitted for review.", approve: "Approved. Approval is not execution: record execution once the work is done.",
    reject: "Action rejected.", request_evidence: "Evidence requested.", execute: "Execution recorded. Verification with completion evidence is still required.",
    simulate: "SIMULATED execution recorded. No real action was taken.", fail: "Failure recorded.", verify: "Verified complete.", reopen: "Action reopened.",
  };
  await run(to, labels[op] ?? "Updated.", () => {
    switch (op) {
      case "submit": return rem.submitForReview(db, actor, id);
      case "approve": return rem.approveAction(db, actor, id, reason);
      case "reject": return rem.rejectAction(db, actor, id, reason);
      case "request_evidence": return rem.requestActionEvidence(db, actor, id, reason);
      case "execute": return rem.recordExecution(db, actor, id, { mode: "recorded", reference: str(formData, "reference"), note: str(formData, "note") });
      case "simulate": return rem.recordExecution(db, actor, id, { mode: "simulated", note: str(formData, "note") });
      case "fail": return rem.recordFailure(db, actor, id, reason, refs(formData));
      case "verify": return rem.verifyCompletion(db, actor, id, { kind: str(formData, "kind") as rem.VerificationInput["kind"], ref: str(formData, "ref"), note: str(formData, "note") });
      case "reopen": return rem.reopenAction(db, actor, id, reason);
      default: throw new DomainError("Unknown operation.");
    }
  });
}
