import { db } from "./db.js";
import { startRun } from "./creao.js";
import { addEvidence, addTimeline, getIncident, transition } from "./incidents.js";
import { ALLOWED_ACTIONS_MAP, manifest } from "./manifest.js";
import { reportBackendError } from "./monitoring.js";
import { initiateCall, notifyResponder } from "./voice.js";

const now = () => new Date().toISOString();
const BUDGET_MS = Number(process.env.INVESTIGATION_BUDGET_MS ?? 180_000);
const PROPOSAL_TTL_MS = 10 * 60_000;

// ---- What the agent may propose (loaded from service-manifest.json) ------
// The backend, not the model, owns this list. Each action names the cause it can address.
const ALLOWED_ACTIONS = ALLOWED_ACTIONS_MAP;

const CAUSES = manifest.causes;
const STATUSES = ["supported", "inconclusive", "contradicted"];
const RECOMMENDATIONS = ["request_engineer_decision", "permit_runbook", "escalate_without_action"] as const;
type Recommendation = (typeof RECOMMENDATIONS)[number];

export interface InvestigationResult {
  incident_id: number | string;
  impact: { summary: string; measured_from: string[] };
  hypotheses: { cause: string; status: string; supporting_evidence?: any[]; conflicting_evidence?: any[] }[];
  // Blocking: facts that would change or prevent the proposal. Any entry escalates without an action.
  missing_information: string[];
  // Not blocking: gaps that do not bear on the proposal (for example a deeper root cause). Recorded and shown, never hidden.
  non_blocking_unknowns?: string[];
  applicable_runbook: { id: string; version: number | string; preconditions_met: boolean } | null;
  proposed_action: { action: string; target_environment: string; expected_tradeoff?: string } | null;
  recommendation: Recommendation;
  call_briefing: string;
  // Ids from /tools/past_decisions the agent actually read, and how they changed its proposal.
  consulted_decisions?: number[];
  lesson_applied?: string;
}

// Hand-rolled so a malformed agent answer is rejected with specific reasons rather than trusted.
export function validateResult(x: any): { ok: true; value: InvestigationResult } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!x || typeof x !== "object") return { ok: false, errors: ["body must be a JSON object"] };
  if (x.incident_id === undefined) errors.push("incident_id missing");
  if (typeof x.impact?.summary !== "string") errors.push("impact.summary missing");
  if (!Array.isArray(x.impact?.measured_from) || x.impact.measured_from.length === 0 ||
      x.impact.measured_from.some((id: unknown) => typeof id !== "string")) {
    errors.push("impact.measured_from must be a non-empty array of evidence source ids");
  }
  if (!Array.isArray(x.hypotheses) || x.hypotheses.length === 0) errors.push("hypotheses must be a non-empty array");
  else x.hypotheses.forEach((h: any, i: number) => {
    if (!CAUSES.includes(h?.cause)) errors.push(`hypotheses[${i}].cause must be one of ${CAUSES.join("|")}`);
    if (!STATUSES.includes(h?.status)) errors.push(`hypotheses[${i}].status must be one of ${STATUSES.join("|")}`);
    for (const key of ["supporting_evidence", "conflicting_evidence"]) {
      if (h?.[key] !== undefined && !Array.isArray(h[key])) errors.push(`hypotheses[${i}].${key} must be an array`);
      else for (const item of h?.[key] ?? []) {
        if (!item || typeof item !== "object" || typeof item.source_id !== "string" ||
            typeof item.source !== "string" || typeof item.observed_at !== "string") {
          errors.push(`hypotheses[${i}].${key} entries must include source, source_id, and observed_at`);
        }
      }
    }
  });
  if (!Array.isArray(x.missing_information) || x.missing_information.some((item: unknown) => typeof item !== "string")) errors.push("missing_information must be an array of strings");
  if (x.non_blocking_unknowns !== undefined &&
      (!Array.isArray(x.non_blocking_unknowns) || x.non_blocking_unknowns.some((item: unknown) => typeof item !== "string"))) {
    errors.push("non_blocking_unknowns must be an array of strings");
  }
  if (!RECOMMENDATIONS.includes(x.recommendation)) errors.push(`recommendation must be one of ${RECOMMENDATIONS.join("|")}`);
  if (typeof x.call_briefing !== "string" || !x.call_briefing.trim()) errors.push("call_briefing missing");
  if (x.applicable_runbook !== null && x.applicable_runbook !== undefined &&
      (typeof x.applicable_runbook.id !== "string" || !Number.isFinite(Number(x.applicable_runbook.version)) ||
       typeof x.applicable_runbook.preconditions_met !== "boolean")) {
    errors.push("applicable_runbook must include id, numeric version, and preconditions_met");
  }
  if (x.consulted_decisions !== undefined &&
      (!Array.isArray(x.consulted_decisions) || x.consulted_decisions.some((id: unknown) => !Number.isInteger(id)))) {
    errors.push("consulted_decisions must be an array of decision ids from past_decisions");
  }
  if (x.proposed_action != null &&
      (typeof x.proposed_action.action !== "string" || typeof x.proposed_action.target_environment !== "string" ||
       !x.proposed_action.target_environment.trim())) {
    errors.push("proposed_action must include action and target_environment");
  }
  return errors.length ? { ok: false, errors } : { ok: true, value: x as InvestigationResult };
}

// ---- Decision policy -----------------------------------------------------
export type Final = "request_engineer_decision" | "permit_runbook" | "escalate_without_action";
export interface Decision {
  final: Final;
  proposeAction: boolean;
  reasons: string[];
}

export function decide(r: InvestigationResult, authorisedRunbook: boolean): Decision {
  const reasons: string[] = [];
  const supported = r.hypotheses.filter((h) => h.status === "supported" && h.cause !== "unknown" && h.cause !== "other");
  const escalate = (why: string): Decision => ({ final: "escalate_without_action", proposeAction: false, reasons: [...reasons, why] });

  // Never more permissive than the agent itself asked for.
  if (r.recommendation === "escalate_without_action") return escalate("agent recommended escalation");
  if (r.missing_information.length > 0) {
    return escalate(`investigation reports missing information (${r.missing_information.join("; ")})`);
  }
  if (supported.length === 0) return escalate("no hypothesis is supported by evidence");
  if (supported.length > 1) return escalate(`multiple causes supported (${supported.map((h) => h.cause).join(", ")}); one mitigation cannot claim full recovery`);

  const cause = supported[0].cause;
  const pa = r.proposed_action;
  if (!pa) {
    reasons.push(`${cause} supported but no allowed action proposed`);
    return { final: "request_engineer_decision", proposeAction: false, reasons };
  }
  const allowed = ALLOWED_ACTIONS[pa.action];
  if (!allowed) return escalate(`action '${pa.action}' is not on the allowlist`);
  if (pa.target_environment !== "demo") return escalate(`target environment '${pa.target_environment}' is outside the demo allowlist`);
  if (allowed.addresses !== cause) return escalate(`action '${pa.action}' addresses ${allowed.addresses}, but the supported cause is ${cause}`);

  if (r.recommendation === "permit_runbook") {
    const rb = r.applicable_runbook;
    if (rb && rb.preconditions_met && authorisedRunbook) {
      return { final: "permit_runbook", proposeAction: true, reasons: [...reasons, `authorised runbook ${rb.id} v${rb.version} applies`] };
    }
    reasons.push("agent asked to run a runbook, but none is authorised with satisfied conditions; asking the engineer instead");
  }
  return { final: "request_engineer_decision", proposeAction: true, reasons: [...reasons, `${cause} supported; allowlisted action proposed for approval`] };
}

// ---- Lifecycle -----------------------------------------------------------
const timers = new Map<number, NodeJS.Timeout>();

export async function startInvestigation(incidentId: number) {
  const inc = getIncident(incidentId);
  if (!inc || inc.status !== "open") return;
  transition(incidentId, "investigating", "system");
  const info = db.prepare(`INSERT INTO investigations (incident_id, started_at) VALUES (?,?)`).run(incidentId, now());
  const invId = Number(info.lastInsertRowid);
  try {
    // Stable per incident, so a retried trigger returns the same run instead of starting a second one.
    // The open time keeps keys unique even if the database is reset and ids are reused.
    const run = await startRun({ incident_id: String(incidentId) }, `incident-${incidentId}-${Date.parse(inc.opened_at)}-investigation-1`);
    db.prepare(`UPDATE investigations SET run_id = ? WHERE id = ?`).run(run.id, invId);
    addTimeline(incidentId, "system", "investigation_started", { runId: run.id, budgetMs: BUDGET_MS });
  } catch (err) {
    addTimeline(incidentId, "system", "investigation_start_failed", { error: String(err) }, "error");
    void reportBackendError(err, { operation: "creao_investigation_start", incidentId });
    return fallback(incidentId, invId, "failed", "could not start CREAO");
  }
  // Urgent incidents must not wait forever for a diagnosis.
  timers.set(incidentId, setTimeout(() => fallback(incidentId, invId, "timed_out", `no result within ${BUDGET_MS / 1000}s`), BUDGET_MS));
}

function fallback(incidentId: number, invId: number, status: "failed" | "timed_out", why: string) {
  clearTimeout(timers.get(incidentId));
  timers.delete(incidentId);
  const inv = db.prepare(`SELECT status FROM investigations WHERE id = ?`).get(invId) as any;
  if (inv?.status !== "running") return;
  db.prepare(`UPDATE investigations SET status = ?, finished_at = ? WHERE id = ?`).run(status, now(), invId);
  const inc = getIncident(incidentId);
  if (inc?.status === "investigating") transition(incidentId, "awaiting_decision", "system", { reason: why });
  addTimeline(incidentId, "system", "engineer_contact_needed", { reason: `investigation ${status}: ${why}`, knownSoFar: "alert only" }, "degraded");
  if (process.env.PHONE_AUTO_NOTIFY === "true") {
    const report = (error: unknown) => { void reportBackendError(error, { operation: "investigation_fallback_notification", incidentId }); };
    try {
      void notifyResponder(incidentId, "primary").catch(report);
    } catch (error) {
      report(error);
    }
  }
}

// Called from the CREAO webhook when a run finishes without a submission having arrived.
export function onRunFinished(runId: string, status: string) {
  const inv = db.prepare(`SELECT * FROM investigations WHERE run_id = ?`).get(runId) as any;
  if (!inv) return;
  if (status !== "completed") fallback(inv.incident_id, inv.id, "failed", `CREAO run ${status}`);
  else if (inv.status === "running") addTimeline(inv.incident_id, "creao", "run_completed_without_submission", { runId }, "degraded");
}

export function submitInvestigation(raw: unknown, backendVerifiedRunbook = false) {
  const v = validateResult(raw);
  if (!v.ok) return { accepted: false as const, errors: v.errors };
  const r = v.value;
  const incidentId = Number(r.incident_id);
  const inc = getIncident(incidentId);
  if (!inc) return { accepted: false as const, errors: [`incident ${r.incident_id} not found`] };
  const sourceById = db.prepare(`SELECT observed_at FROM evidence WHERE incident_id = ? AND source_id = ?`);
  const sourceByType = db.prepare(`SELECT observed_at FROM evidence WHERE incident_id = ? AND source_id = ? AND source = ?`);
  const missingSources = new Set<string>();
  const staleSources = new Set<string>();
  const citedSourceIds = new Set(r.impact.measured_from);
  for (const hypothesis of r.hypotheses) {
    if (hypothesis.status === "supported" && !(hypothesis.supporting_evidence?.length)) {
      return { accepted: false as const, errors: [`supported hypothesis '${hypothesis.cause}' must cite supporting evidence`] };
    }
    for (const item of [...(hypothesis.supporting_evidence ?? []), ...(hypothesis.conflicting_evidence ?? [])]) {
      const source = sourceByType.get(incidentId, item.source_id, item.source) as { observed_at: string } | undefined;
      if (!source) missingSources.add(`${item.source}:${item.source_id}`);
      else citedSourceIds.add(item.source_id);
    }
  }
  for (const sourceId of citedSourceIds) {
    const source = sourceById.get(incidentId, sourceId) as { observed_at: string } | undefined;
    if (!source) {
      missingSources.add(sourceId);
      continue;
    }
    const age = Date.now() - Date.parse(source.observed_at);
    if (!Number.isFinite(age) || age < -60_000 || age > 15 * 60_000) staleSources.add(sourceId);
  }
  if (missingSources.size) {
    return { accepted: false as const, errors: [`evidence source ids were not retrieved for this incident: ${[...missingSources].join(", ")}`] };
  }
  if (staleSources.size) {
    return { accepted: false as const, errors: [`evidence is missing, future-dated, or older than 15 minutes: ${[...staleSources].join(", ")}`] };
  }

  const authorised = backendVerifiedRunbook && !!(r.applicable_runbook && db.prepare(
    `SELECT 1 FROM runbook_versions WHERE runbook_id = ? AND version = ? AND lifecycle = 'authorised'`,
  ).get(r.applicable_runbook.id, Number(r.applicable_runbook.version)));
  const decision = decide(r, authorised);

  const inv = db.prepare(`SELECT id, status FROM investigations WHERE incident_id = ? ORDER BY id DESC LIMIT 1`).get(incidentId) as any;
  const late = !inv || inv.status !== "running" || inc.status !== "investigating";
  if (inv) db.prepare(`UPDATE investigations SET status = ?, finished_at = ?, result = ?, decision = ? WHERE id = ?`)
    .run(late && inv.status !== "running" ? inv.status : "submitted", now(), JSON.stringify(r), JSON.stringify(decision), inv.id);

  // Keep the agent's evidence on the shared record, labelled by the hypothesis it supported or contradicted.
  let n = 0;
  for (const h of r.hypotheses) {
    for (const [role, items] of [["supporting", h.supporting_evidence], ["conflicting", h.conflicting_evidence]] as const) {
      for (const item of items ?? []) {
        addEvidence(incidentId, `creao.${role}`, `inv${inv?.id ?? 0}-${n++}`, String(item?.observed_at ?? now()), { cause: h.cause, ...item });
      }
    }
  }
  addTimeline(incidentId, "creao", "investigation_submitted", {
    hypotheses: r.hypotheses.map((h) => `${h.cause}:${h.status}`), recommendation: r.recommendation, missing: r.missing_information,
    nonBlockingUnknowns: r.non_blocking_unknowns ?? [],
  });

  // Record which earlier decisions informed this proposal. Only ids that exist for this service count.
  const consulted = (r.consulted_decisions ?? []).filter((id) => db.prepare(
    `SELECT 1 FROM decision_feedback WHERE id = ? AND service = ? AND incident_id != ?`).get(id, inc.service, incidentId));
  if (consulted.length) {
    addTimeline(incidentId, "creao", "past_decisions_consulted", { decisionIds: consulted, lessonApplied: r.lesson_applied ?? null });
  }

  if (late) {
    addTimeline(incidentId, "system", "late_submission_recorded", { incidentStatus: inc.status }, "ignored_for_state");
    return { accepted: true as const, decision, applied: false };
  }

  clearTimeout(timers.get(incidentId));
  timers.delete(incidentId);

  let proposedActionId: number | undefined;
  if (decision.proposeAction && r.proposed_action && inc.autonomy !== "halted") {
    db.prepare(`UPDATE proposed_actions SET approval_state = 'superseded' WHERE incident_id = ? AND approval_state = 'pending'`).run(incidentId);
    const info = db.prepare(
      `INSERT INTO proposed_actions (incident_id, action, target_environment, parameters, expires_at, created_at) VALUES (?,?,?,?,?,?)`,
    ).run(incidentId, r.proposed_action.action, inc.environment, JSON.stringify({
      ...ALLOWED_ACTIONS[r.proposed_action.action].parameters,
      ...(decision.final === "permit_runbook" && r.applicable_runbook ? {
        runbook_id: r.applicable_runbook.id,
        runbook_version: Number(r.applicable_runbook.version),
      } : {}),
    }),
      new Date(Date.now() + PROPOSAL_TTL_MS).toISOString(), now());
    proposedActionId = Number(info.lastInsertRowid);
    addTimeline(incidentId, "system", "action_proposed", { actionId: proposedActionId, action: r.proposed_action.action, environment: inc.environment, tradeoff: r.proposed_action.expected_tradeoff });
  }
  // The voice briefing is stored from the agent's own words so the phone call speaks from the incident record.
  addTimeline(incidentId, "system", `decision_${decision.final}`, { reasons: decision.reasons, briefing: r.call_briefing });
  transition(incidentId, "awaiting_decision", "system");
  if (decision.final !== "permit_runbook") {
    void initiateCall(incidentId, { live: process.env.VOICE_AUTO_CALL === "true" || process.env.PHONE_AUTO_NOTIFY === "true" });
  }
  return { accepted: true as const, decision, applied: true, proposedActionId };
}
