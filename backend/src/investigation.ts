import { db } from "./db.js";
import { startRun } from "./creao.js";
import { addEvidence, addTimeline, getIncident, transition } from "./incidents.js";

const now = () => new Date().toISOString();
const BUDGET_MS = Number(process.env.INVESTIGATION_BUDGET_MS ?? 180_000);
const PROPOSAL_TTL_MS = 10 * 60_000;

// ---- What the agent may propose ------------------------------------------
// The backend, not the model, owns this list. Each action names the cause it can address.
const ALLOWED_ACTIONS: Record<string, { addresses: string; parameters: Record<string, unknown> }> = {
  disable_recommendations: { addresses: "recommendations_timeout", parameters: { flag: "recommendations", value: false } },
};

const CAUSES = ["recommendations_timeout", "payment_failure", "other", "unknown"];
const STATUSES = ["supported", "inconclusive", "contradicted"];
const RECOMMENDATIONS = ["request_engineer_decision", "permit_runbook", "escalate_without_action"] as const;
type Recommendation = (typeof RECOMMENDATIONS)[number];

export interface InvestigationResult {
  incident_id: number | string;
  impact: { summary: string; measured_from: string[] };
  hypotheses: { cause: string; status: string; supporting_evidence?: any[]; conflicting_evidence?: any[] }[];
  missing_information: string[];
  applicable_runbook: { id: string; version: number | string; preconditions_met: boolean } | null;
  proposed_action: { action: string; target_environment: string; expected_tradeoff?: string } | null;
  recommendation: Recommendation;
  call_briefing: string;
}

// Hand-rolled so a malformed agent answer is rejected with specific reasons rather than trusted.
export function validateResult(x: any): { ok: true; value: InvestigationResult } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!x || typeof x !== "object") return { ok: false, errors: ["body must be a JSON object"] };
  if (x.incident_id === undefined) errors.push("incident_id missing");
  if (typeof x.impact?.summary !== "string") errors.push("impact.summary missing");
  if (!Array.isArray(x.hypotheses) || x.hypotheses.length === 0) errors.push("hypotheses must be a non-empty array");
  else x.hypotheses.forEach((h: any, i: number) => {
    if (!CAUSES.includes(h?.cause)) errors.push(`hypotheses[${i}].cause must be one of ${CAUSES.join("|")}`);
    if (!STATUSES.includes(h?.status)) errors.push(`hypotheses[${i}].status must be one of ${STATUSES.join("|")}`);
  });
  if (!Array.isArray(x.missing_information)) errors.push("missing_information must be an array");
  if (!RECOMMENDATIONS.includes(x.recommendation)) errors.push(`recommendation must be one of ${RECOMMENDATIONS.join("|")}`);
  if (typeof x.call_briefing !== "string" || !x.call_briefing.trim()) errors.push("call_briefing missing");
  if (x.proposed_action != null && typeof x.proposed_action.action !== "string") errors.push("proposed_action.action missing");
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
}

// Called from the CREAO webhook when a run finishes without a submission having arrived.
export function onRunFinished(runId: string, status: string) {
  const inv = db.prepare(`SELECT * FROM investigations WHERE run_id = ?`).get(runId) as any;
  if (!inv) return;
  if (status !== "completed") fallback(inv.incident_id, inv.id, "failed", `CREAO run ${status}`);
  else if (inv.status === "running") addTimeline(inv.incident_id, "creao", "run_completed_without_submission", { runId }, "degraded");
}

export function submitInvestigation(raw: unknown) {
  const v = validateResult(raw);
  if (!v.ok) return { accepted: false as const, errors: v.errors };
  const r = v.value;
  const incidentId = Number(r.incident_id);
  const inc = getIncident(incidentId);
  if (!inc) return { accepted: false as const, errors: [`incident ${r.incident_id} not found`] };

  const authorised = !!(r.applicable_runbook && db.prepare(
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
  });

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
    ).run(incidentId, r.proposed_action.action, inc.environment, JSON.stringify(ALLOWED_ACTIONS[r.proposed_action.action].parameters),
      new Date(Date.now() + PROPOSAL_TTL_MS).toISOString(), now());
    proposedActionId = Number(info.lastInsertRowid);
    addTimeline(incidentId, "system", "action_proposed", { actionId: proposedActionId, action: r.proposed_action.action, environment: inc.environment, tradeoff: r.proposed_action.expected_tradeoff });
  }
  // The voice briefing is stored from the agent's own words so the phone call speaks from the incident record.
  addTimeline(incidentId, "system", `decision_${decision.final}`, { reasons: decision.reasons, briefing: r.call_briefing });
  transition(incidentId, "awaiting_decision", "system");
  return { accepted: true as const, decision, applied: true, proposedActionId };
}
