import { timingSafeEqual } from "node:crypto";
import { db } from "./db.js";
import { addTimeline, escalate, getIncident, transition } from "./incidents.js";
import { reportBackendError } from "./monitoring.js";
import { getEvidence } from "./sentry.js";

const now = () => new Date().toISOString();
const demoUrl = () => process.env.DEMO_APP_URL ?? "http://localhost:4000";
const verificationTimers = new Map<number, NodeJS.Timeout>();
const VERIFICATION_LIMIT_MS = 120_000;
const VERIFICATION_INTERVAL_MS = 5_000;
const REQUIRED_CHECKOUTS = 10;
const REQUIRED_WINDOW_MS = 30_000;
const REQUIRED_TRACES = 10;

function responderRole(actor: string, escalated: boolean): "primary" | "backup" | undefined {
  if (actor === (process.env.PRIMARY_RESPONDER ?? "primary-engineer")) return "primary";
  if (escalated && actor === (process.env.BACKUP_RESPONDER ?? "backup-engineer")) return "backup";
  return undefined;
}

async function demoGet(path: string) {
  const token = process.env.DEMO_PROBE_TOKEN;
  if (!token) throw new Error("DEMO_PROBE_TOKEN is not set");
  const response = await fetch(`${demoUrl()}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(5_000),
  });
  const body: unknown = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Demo app ${path} returned ${response.status}`);
  return body as Record<string, unknown>;
}

async function checkApplicability(environment: string) {
  const [config, recommendationProbe, paymentProbe] = await Promise.all([
    demoGet("/config"),
    demoGet("/probe/recommendations"),
    demoGet("/probe/payments"),
  ]);
  if (config.recommendationsEnabled !== true) throw new Error("recommendations are already disabled");
  if (recommendationProbe.healthy !== false) throw new Error("fresh recommendation probe does not confirm a failure");
  if (paymentProbe.healthy !== true) throw new Error("payment probe is unhealthy or inconclusive");
  if (environment !== "demo") throw new Error(`refusing to mutate non-demo environment '${environment}'`);
}

export async function verifyAuthorisedRunbookApplicability(incidentId: number, runbookId: string, version: number) {
  const authorised = db.prepare(
    `SELECT 1 FROM runbook_versions WHERE runbook_id = ? AND version = ? AND lifecycle = 'authorised'`,
  ).get(runbookId, version);
  if (!authorised) return { applicable: false, reason: "runbook version is not authorised" };
  const incident = getIncident(incidentId);
  if (!incident) return { applicable: false, reason: `incident ${incidentId} not found` };
  try {
    await checkApplicability(incident.environment);
    return { applicable: true };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn(`[runbook] ${runbookId} v${version} not applicable to incident ${incidentId}: ${reason}`);
    return { applicable: false, reason };
  }
}

function recordExecutionFailure(executionId: number, incidentId: number, error: string) {
  db.prepare(`UPDATE action_executions SET status = 'failed', finished_at = ?, result = ? WHERE id = ?`)
    .run(now(), JSON.stringify({ error }), executionId);
  db.prepare(`UPDATE proposed_actions SET approval_state = 'failed' WHERE id = (SELECT proposed_action_id FROM action_executions WHERE id = ?)`)
    .run(executionId);
  const incident = getIncident(incidentId);
  if (incident?.status === "mitigating") transition(incidentId, "awaiting_decision", "system", { error });
  addTimeline(incidentId, "system", "mitigation_failed", { error }, "error");
  escalate(incidentId, "mitigation failed; no automatic retry was attempted");
  void reportBackendError(new Error(error), { operation: "mitigation_execution", incidentId });
}

export async function approveAndExecute(
  incidentId: number,
  actionId: number,
  actor: string,
) {
  return executeAction(incidentId, actionId, actor);
}

export function declineAction(incidentId: number, actionId: number, actor: string) {
  const incident = getIncident(incidentId);
  if (!incident) throw new Error(`incident ${incidentId} not found`);
  if (incident.status !== "awaiting_decision") throw new Error(`incident is ${incident.status}, not awaiting a decision`);
  if (!responderRole(actor, incident.escalation_state === "escalated_to_backup")) {
    throw new Error("actor is not an authorised responder for this incident");
  }
  const action = db.prepare(`SELECT approval_state, expires_at FROM proposed_actions WHERE id = ? AND incident_id = ?`)
    .get(actionId, incidentId) as { approval_state: string; expires_at: string } | undefined;
  if (!action) throw new Error("proposed action not found for this incident");
  if (action.approval_state !== "pending") throw new Error(`action is ${action.approval_state}, not pending`);
  const expired = Date.parse(action.expires_at) <= Date.now();
  db.prepare(`UPDATE proposed_actions SET approval_state = ? WHERE id = ?`)
    .run(expired ? "expired" : "rejected", actionId);
  addTimeline(incidentId, actor, expired ? "action_approval_expired" : "action_declined", { actionId }, "rejected");
  return { ok: true, actionId, status: expired ? "expired" : "rejected" };
}

export async function executeAuthorisedRunbook(
  incidentId: number,
  actionId: number,
  runbookId: string,
  version: number,
) {
  const authorised = db.prepare(
    `SELECT 1 FROM runbook_versions WHERE runbook_id = ? AND version = ? AND lifecycle = 'authorised'`,
  ).get(runbookId, version);
  if (!authorised) throw new Error("runbook version is not authorised");
  const action = db.prepare(`SELECT incident_id, parameters FROM proposed_actions WHERE id = ?`)
    .get(actionId) as { incident_id: number; parameters: string } | undefined;
  if (!action || action.incident_id !== incidentId) throw new Error("proposed action not found for this incident");
  const parameters = JSON.parse(action.parameters) as Record<string, unknown>;
  if (parameters.runbook_id !== runbookId || parameters.runbook_version !== version) {
    throw new Error("proposed action is not bound to this runbook version");
  }
  const actor = `runbook:${runbookId}:v${version}`;
  try {
    return await executeAction(incidentId, actionId, actor, { runbookId, version });
  } catch (error) {
    const pending = db.prepare(`SELECT approval_state FROM proposed_actions WHERE id = ?`).get(actionId) as
      { approval_state: string } | undefined;
    if (pending?.approval_state === "pending") {
      const reason = error instanceof Error ? error.message : String(error);
      db.prepare(`UPDATE proposed_actions SET approval_state = 'not_applicable' WHERE id = ?`).run(actionId);
      addTimeline(incidentId, "system", "runbook_not_applicable", { runbookId, version, reason }, "rejected");
    }
    throw error;
  }
}

async function executeAction(
  incidentId: number,
  actionId: number,
  actor: string,
  runbook?: { runbookId: string; version: number },
) {
  const incident = getIncident(incidentId);
  if (!incident) throw new Error(`incident ${incidentId} not found`);
  const prior = db.prepare(`SELECT * FROM action_executions WHERE proposed_action_id = ?`)
    .get(actionId) as { id: number; status: string; result: string | null } | undefined;
  if (prior) return { executionId: prior.id, status: prior.status, result: prior.result ? JSON.parse(prior.result) : null, duplicate: true };
  if (incident.status !== "awaiting_decision") throw new Error(`incident is ${incident.status}, not awaiting a decision`);
  if (incident.autonomy === "halted") throw new Error("autonomous actions were halted by responder takeover");
  const role = runbook ? undefined : responderRole(actor, incident.escalation_state === "escalated_to_backup");
  if (!runbook && !role) throw new Error("actor is not an authorised responder for this incident");

  const action = db.prepare(`SELECT * FROM proposed_actions WHERE id = ? AND incident_id = ?`)
    .get(actionId, incidentId) as {
      id: number; action: string; target_environment: string; expires_at: string; approval_state: string; parameters: string;
    } | undefined;
  if (!action) throw new Error("proposed action not found for this incident");
  if (action.approval_state !== "pending") throw new Error(`action is ${action.approval_state}, not pending`);
  if (Date.parse(action.expires_at) <= Date.now()) {
    db.prepare(`UPDATE proposed_actions SET approval_state = 'expired' WHERE id = ?`).run(actionId);
    addTimeline(incidentId, actor, "action_approval_expired", { actionId }, "rejected");
    throw new Error("proposed action has expired");
  }
  if (action.action !== "disable_recommendations" || action.target_environment !== incident.environment) {
    throw new Error("action or target does not match the permitted operation for this incident");
  }

  try {
    await checkApplicability(action.target_environment);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    addTimeline(incidentId, actor, "action_blocked_by_fresh_checks", { actionId, reason }, "rejected");
    throw error;
  }

  db.exec("BEGIN IMMEDIATE");
  let executionId: number;
  try {
    const concurrent = db.prepare(`SELECT id, status FROM action_executions WHERE proposed_action_id = ?`)
      .get(actionId) as { id: number; status: string } | undefined;
    if (concurrent) {
      db.exec("COMMIT");
      return { executionId: concurrent.id, status: concurrent.status, duplicate: true };
    }
    const currentIncident = getIncident(incidentId);
    if (!currentIncident || currentIncident.status !== "awaiting_decision" || currentIncident.autonomy === "halted") {
      throw new Error("incident state or autonomy changed before action execution");
    }
    if (!runbook && !responderRole(actor, currentIncident.escalation_state === "escalated_to_backup")) {
      throw new Error("actor is no longer authorised to approve this incident");
    }
    if (Date.parse(action.expires_at) <= Date.now()) throw new Error("proposed action expired before execution");
    if (runbook) {
      const currentRunbook = db.prepare(`SELECT 1 FROM runbook_versions WHERE runbook_id = ? AND version = ? AND lifecycle = 'authorised'`)
        .get(runbook.runbookId, runbook.version);
      const parameters = JSON.parse(action.parameters) as Record<string, unknown>;
      if (!currentRunbook || parameters.runbook_id !== runbook.runbookId || parameters.runbook_version !== runbook.version) {
        throw new Error("runbook authorisation or action binding changed before execution");
      }
    }
    const approved = db.prepare(`UPDATE proposed_actions SET approval_state = 'approved', approved_by = ? WHERE id = ? AND approval_state = 'pending'`)
      .run(actor, actionId);
    if (approved.changes !== 1) throw new Error("proposed action is no longer pending");
    const result = db.prepare(
      `INSERT INTO action_executions (proposed_action_id, incident_id, actor, status, started_at) VALUES (?, ?, ?, 'running', ?)`,
    ).run(actionId, incidentId, actor, now());
    executionId = Number(result.lastInsertRowid);
    transition(incidentId, "mitigating", actor, { actionId, executionId, approval: runbook ? "authorised_runbook" : "human" });
    addTimeline(incidentId, actor, runbook ? "runbook_action_authorised" : "action_approved",
      { actionId, executionId, role, runbook });
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }

  try {
    const token = process.env.DEMO_ACTION_TOKEN;
    if (!token) throw new Error("DEMO_ACTION_TOKEN is not set");
    const response = await fetch(`${demoUrl()}/actions/disable-recommendations`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ actor, expectedPreviousValue: true }),
      signal: AbortSignal.timeout(5_000),
    });
    const result: unknown = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`Mitigation endpoint returned ${response.status}: ${JSON.stringify(result)}`);
    const body = result as Record<string, unknown>;
    if (body.currentValue !== false) throw new Error("Mitigation response did not confirm recommendations are disabled");
    db.prepare(`UPDATE action_executions SET status = 'executed', result = ? WHERE id = ?`)
      .run(JSON.stringify(body), executionId);
    db.prepare(`UPDATE proposed_actions SET approval_state = 'executed' WHERE id = ?`).run(actionId);
    addTimeline(incidentId, "system", "action_executed", { actionId, executionId, result: body });
    transition(incidentId, "verifying", "system", { actionId, executionId, startedAt: now() });
    scheduleVerification(executionId, incidentId);
    return { executionId, status: "verifying", result: body, duplicate: false };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    recordExecutionFailure(executionId, incidentId, message);
    throw new Error(message, { cause: error });
  }
}

function scheduleVerification(executionId: number, incidentId: number) {
  const startedAt = Date.now();
  const poll = async () => {
    const incident = getIncident(incidentId);
    if (!incident || incident.status !== "verifying") {
      verificationTimers.delete(executionId);
      return;
    }
    let requests: Record<string, unknown>[] = [];
    let telemetryError: string | undefined;
    try {
      const body = await demoGet("/requests?limit=1000");
      if (!Array.isArray(body)) throw new Error("Demo request history did not return an array");
      requests = body as Record<string, unknown>[];
    } catch (error) {
      telemetryError = error instanceof Error ? error.message : String(error);
      console.error(`[verification] functional checks unavailable for incident ${incidentId}: ${telemetryError}`);
    }

    const execution = db.prepare(`SELECT started_at FROM action_executions WHERE id = ?`).get(executionId) as { started_at: string };
    const actionAt = Date.parse(execution.started_at);
    const successful = requests.filter((request) =>
      request.runId === incident.run_id &&
      request.ok === true &&
      Date.parse(String(request.at)) >= actionAt,
    );
    const times = successful.map((request) => Date.parse(String(request.at))).filter(Number.isFinite);
    const checkWindow = times.length > 1 ? Math.max(...times) - Math.min(...times) : 0;

    let successfulTraces = 0;
    if (!incident.run_id) {
      telemetryError = "incident has no opaque run_id; successful traces cannot be correlated safely";
    } else {
      try {
        const evidence = await getEvidence(
          Math.min(120, Math.max(2, Math.ceil((Date.now() - actionAt) / 60_000) + 1)),
          String(incident.run_id),
        );
        successfulTraces = evidence.spans.filter((span) =>
          span.attributes.run_id === incident.run_id &&
          span.attributes.op === "checkout" &&
          span.attributes.status === "ok" &&
          Date.parse(span.observedAt) >= actionAt,
        ).length;
      } catch (error) {
        telemetryError = error instanceof Error ? error.message : String(error);
        console.error(`[verification] Sentry telemetry unavailable for incident ${incidentId}: ${telemetryError}`);
      }
    }

    const passed = successful.length >= REQUIRED_CHECKOUTS &&
      checkWindow >= REQUIRED_WINDOW_MS &&
      successfulTraces >= REQUIRED_TRACES;
    db.prepare(
      `INSERT INTO verification_samples (execution_id, observed_at, successful_checkouts, checkout_window_ms, successful_traces, telemetry_error, result)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(executionId, now(), successful.length, checkWindow, successfulTraces, telemetryError ?? null,
      passed ? "passed" : Date.now() - startedAt >= VERIFICATION_LIMIT_MS ? "timed_out" : "pending");

    if (passed) {
      verificationTimers.delete(executionId);
      finishRecovery(executionId, incidentId, {
        status: "recovered",
        successfulCheckouts: successful.length,
        checkoutWindowMs: checkWindow,
        successfulTraces,
      });
      return;
    }

    if (Date.now() - startedAt >= VERIFICATION_LIMIT_MS) {
      verificationTimers.delete(executionId);
      const final = {
        status: "verification_incomplete",
        successfulCheckouts: successful.length,
        checkoutWindowMs: checkWindow,
        successfulTraces,
        note: successful.length >= REQUIRED_CHECKOUTS && checkWindow >= REQUIRED_WINDOW_MS
          ? "functional checks passed; telemetry confirmation pending"
          : "recovery threshold was not met",
      };
      db.prepare(`UPDATE action_executions SET status = 'verification_incomplete', finished_at = ?, verification = ? WHERE id = ?`)
        .run(now(), JSON.stringify(final), executionId);
      addTimeline(incidentId, "system", "verification_incomplete", final, "degraded");
      transition(incidentId, "awaiting_decision", "system", final);
      escalate(incidentId, "recovery could not be fully verified; no automatic retry was attempted");
      return;
    }
    verificationTimers.set(executionId, setTimeout(() => { void poll(); }, VERIFICATION_INTERVAL_MS));
  };
  void poll();
}

export interface RunbookFacts {
  evidenceFresh: boolean;
  recommendationFailureSupported: boolean;
  recommendationHealthy: boolean;
  paymentHealthy: boolean;
  recommendationsEnabled: boolean;
  operationAllowed: boolean;
  environment: string;
}

export function evaluateRunbookApplicability(facts: RunbookFacts) {
  return facts.environment === "demo" &&
    facts.evidenceFresh &&
    facts.recommendationFailureSupported &&
    facts.recommendationHealthy === false &&
    facts.paymentHealthy === true &&
    facts.recommendationsEnabled &&
    facts.operationAllowed;
}

function evaluateFixedRunbookCases() {
  const cases = [
    { name: "recommendation timeout", issueId: "fixed-1", evidenceFresh: true, recommendationFailureSupported: true, recommendationHealthy: false, paymentHealthy: true, recommendationsEnabled: true, operationAllowed: true, environment: "demo", expected: true },
    { name: "matching recurrence with a new issue id", issueId: "held-out-47", evidenceFresh: true, recommendationFailureSupported: true, recommendationHealthy: false, paymentHealthy: true, recommendationsEnabled: true, operationAllowed: true, environment: "demo", expected: true },
    { name: "payment failure only", issueId: "fixed-2", evidenceFresh: true, recommendationFailureSupported: false, recommendationHealthy: true, paymentHealthy: false, recommendationsEnabled: true, operationAllowed: true, environment: "demo", expected: false },
    { name: "both dependencies failing", issueId: "fixed-3", evidenceFresh: true, recommendationFailureSupported: true, recommendationHealthy: false, paymentHealthy: false, recommendationsEnabled: true, operationAllowed: true, environment: "demo", expected: false },
    { name: "missing or stale evidence", issueId: "fixed-4", evidenceFresh: false, recommendationFailureSupported: false, recommendationHealthy: true, paymentHealthy: true, recommendationsEnabled: true, operationAllowed: true, environment: "demo", expected: false },
    { name: "recommendations already disabled", issueId: "fixed-5", evidenceFresh: true, recommendationFailureSupported: true, recommendationHealthy: false, paymentHealthy: true, recommendationsEnabled: false, operationAllowed: true, environment: "demo", expected: false },
    { name: "action rejected or ineffective", issueId: "fixed-6", evidenceFresh: true, recommendationFailureSupported: true, recommendationHealthy: false, paymentHealthy: true, recommendationsEnabled: true, operationAllowed: false, environment: "demo", expected: false },
    { name: "out-of-scope environment", issueId: "fixed-7", evidenceFresh: true, recommendationFailureSupported: true, recommendationHealthy: false, paymentHealthy: true, recommendationsEnabled: true, operationAllowed: true, environment: "production", expected: false },
  ];
  return cases.map((test) => {
    const selected = evaluateRunbookApplicability(test);
    return { name: test.name, issueId: test.issueId, expected: test.expected, selected, passed: selected === test.expected };
  });
}

function createLearnedRunbook(incidentId: number, executionId: number, verification: unknown) {
  const runbookId = "checkout-disable-recommendations";
  const latest = db.prepare(`SELECT MAX(version) AS version FROM runbook_versions WHERE runbook_id = ?`)
    .get(runbookId) as { version: number | null };
  const version = (latest.version ?? 0) + 1;
  const evaluation = evaluateFixedRunbookCases();
  const spec = {
    name: "Disable recommendations when checkout recommendation lookup times out",
    scope: { service: "checkout", environment: "demo", action: "disable_recommendations" },
    preconditions: [
      "Fresh recommendation dependency probe is unhealthy.",
      "Fresh payment dependency probe is healthy.",
      "The recommendations feature is currently enabled.",
      "Current incident evidence supports a recommendation timeout.",
    ],
    disqualifyingConditions: [
      "Payment dependency is unhealthy or its health is unknown.",
      "Both dependencies are unhealthy.",
      "Evidence is missing, stale, or contradictory.",
      "Recommendations are already disabled.",
    ],
    operation: { endpoint: "POST /actions/disable-recommendations", idempotent: true },
    verification: { successfulCheckouts: REQUIRED_CHECKOUTS, minimumWindowMs: REQUIRED_WINDOW_MS, matchingSuccessfulTraces: REQUIRED_TRACES },
    escalation: "Stop after one ineffective action; contact the responder and do not re-enable recommendations automatically.",
    learnedFrom: { incidentId, executionId, verification },
  };
  const markdown = [
    `# ${spec.name}`,
    "",
    `Version ${version} — ${evaluation.every((test) => test.passed) ? "all fixed evaluation cases passed" : "evaluation failed"}.`,
    "",
    "## Preconditions",
    ...spec.preconditions.map((condition) => `- ${condition}`),
    "",
    "## Disqualifying conditions",
    ...spec.disqualifyingConditions.map((condition) => `- ${condition}`),
    "",
    "## Operation",
    "- Disable recommendations in the demo environment. Do not toggle or automatically re-enable the flag.",
    "",
    "## Verification",
    `- Require ${REQUIRED_CHECKOUTS} successful synthetic checkouts spanning at least ${REQUIRED_WINDOW_MS / 1000} seconds and ${REQUIRED_TRACES} successful Sentry checkout traces.`,
    "",
    "## Escalation",
    `- ${spec.escalation}`,
    "",
    "## Evaluation",
    ...evaluation.map((test) => `- ${test.passed ? "PASS" : "FAIL"} — ${test.name}`),
  ].join("\n");
  db.prepare(
    `INSERT INTO runbook_versions (runbook_id, version, lifecycle, spec, evaluation, created_at) VALUES (?, ?, 'draft', ?, ?, ?)`,
  ).run(runbookId, version, JSON.stringify({ ...spec, markdown }), JSON.stringify(evaluation), now());
  if (evaluation.every((test) => test.passed)) {
    db.prepare(`UPDATE runbook_versions SET lifecycle = 'evaluated' WHERE runbook_id = ? AND version = ?`)
      .run(runbookId, version);
  }
  addTimeline(incidentId, "system", "runbook_drafted", { runbookId, version, evaluation });
}

function finishRecovery(executionId: number, incidentId: number, result: Record<string, unknown>) {
  db.prepare(`UPDATE action_executions SET status = 'recovered', finished_at = ?, verification = ? WHERE id = ?`)
    .run(now(), JSON.stringify(result), executionId);
  addTimeline(incidentId, "system", "recovery_verified", result);
  transition(incidentId, "recovered", "system", result);
  const execution = db.prepare(`SELECT actor FROM action_executions WHERE id = ?`).get(executionId) as { actor: string };
  if (!execution.actor.startsWith("runbook:")) createLearnedRunbook(incidentId, executionId, result);
  db.prepare(`INSERT OR REPLACE INTO retrospectives (incident_id, summary, unresolved_work, generated_at) VALUES (?, ?, ?, ?)`)
    .run(incidentId, "Checkout recovered; recommendations remain disabled.",
      "Make checkout tolerate recommendation outages; the recommendation dependency itself was not repaired.", now());
  addTimeline(incidentId, "system", "retrospective_generated", {
    summary: "Checkout recovered; recommendations remain disabled.",
    followUp: "Make checkout tolerate recommendation outages.",
  });
}

export function authoriseRunbook(runbookId: string, version: number, actor: string) {
  const row = db.prepare(`SELECT lifecycle, evaluation, spec FROM runbook_versions WHERE runbook_id = ? AND version = ?`)
    .get(runbookId, version) as { lifecycle: string; evaluation: string | null; spec: string } | undefined;
  if (!row) throw new Error("runbook version not found");
  if (actor !== (process.env.PRIMARY_RESPONDER ?? "primary-engineer")) {
    throw new Error("only the primary responder may authorise a runbook");
  }
  if (row.lifecycle !== "evaluated" || !row.evaluation) throw new Error(`runbook lifecycle is ${row.lifecycle}; only evaluated runbooks may be authorised`);
  const results = JSON.parse(row.evaluation) as { passed: boolean }[];
  if (results.length === 0 || results.some((test) => test.passed !== true)) throw new Error("runbook evaluation did not pass every fixed case");
  db.prepare(`UPDATE runbook_versions SET lifecycle = 'authorised' WHERE runbook_id = ? AND version = ?`)
    .run(runbookId, version);
  const incidentId = Number(JSON.parse(row.spec).learnedFrom?.incidentId);
  if (Number.isInteger(incidentId)) addTimeline(incidentId, actor, "runbook_authorised", { runbookId, version });
  return { runbookId, version, lifecycle: "authorised" };
}

export function suspendRunbook(runbookId: string, version: number, actor: string) {
  if (actor !== (process.env.PRIMARY_RESPONDER ?? "primary-engineer")) {
    throw new Error("only the primary responder may suspend a runbook");
  }
  const row = db.prepare(`SELECT lifecycle, spec FROM runbook_versions WHERE runbook_id = ? AND version = ?`)
    .get(runbookId, version) as { lifecycle: string; spec: string } | undefined;
  if (!row) throw new Error("runbook version not found");
  if (row.lifecycle !== "authorised" && row.lifecycle !== "evaluated") {
    throw new Error(`runbook lifecycle is ${row.lifecycle}; only evaluated or authorised runbooks may be suspended`);
  }
  db.prepare(`UPDATE runbook_versions SET lifecycle = 'suspended' WHERE runbook_id = ? AND version = ?`)
    .run(runbookId, version);
  const incidentId = Number(JSON.parse(row.spec).learnedFrom?.incidentId);
  if (Number.isInteger(incidentId)) addTimeline(incidentId, actor, "runbook_suspended", { runbookId, version });
  return { runbookId, version, lifecycle: "suspended" };
}

export function startPhoneCall(incidentId: number, responder: string, phoneNumber: string) {
  const incident = getIncident(incidentId);
  if (!incident) throw new Error(`incident ${incidentId} not found`);
  if (incident.autonomy === "halted") throw new Error("phone notification is halted after responder takeover");
  const elevenKey = process.env.ELEVENLABS_API_KEY;
  const elevenAgentId = process.env.ELEVENLABS_AGENT_ID;
  const elevenPhoneId = process.env.ELEVENLABS_PHONE_NUMBER_ID;
  const useElevenLabs = Boolean(elevenKey && elevenAgentId && elevenPhoneId);
  const callToken = process.env.RETELL_API_KEY;
  const fromNumber = process.env.RETELL_FROM_NUMBER;
  const agentId = process.env.RETELL_AGENT_ID;
  if (!useElevenLabs && (!callToken || !fromNumber || !agentId)) {
    throw new Error("Configure ELEVENLABS_API_KEY, ELEVENLABS_AGENT_ID, ELEVENLABS_PHONE_NUMBER_ID (or RETELL_API_KEY, RETELL_FROM_NUMBER, RETELL_AGENT_ID)");
  }
  if (!/^\+[1-9]\d{7,14}$/.test(phoneNumber)) throw new Error("responder phone number must use E.164 format");
  const existing = db.prepare(`SELECT id, retell_call_id, status FROM phone_calls WHERE incident_id = ? AND phone_number = ?`)
    .get(incidentId, phoneNumber) as { id: number; retell_call_id: string | null; status: string } | undefined;
  if (existing) return { ...existing, duplicate: true };
  const briefing = db.prepare(
    `SELECT detail FROM timeline_events WHERE incident_id = ? AND action LIKE 'decision_%' ORDER BY id DESC LIMIT 1`,
  ).get(incidentId) as { detail: string | null } | undefined;
  const callBriefing = briefing?.detail ? JSON.parse(briefing.detail).briefing : undefined;
  const message = typeof callBriefing === "string" && callBriefing.trim()
    ? callBriefing
    : `SecondShift incident ${incidentId}. Checkout requests are failing. Investigation is ongoing. Please check the incident dashboard.`;
  const at = now();
  const inserted = db.prepare(
    `INSERT INTO phone_calls (incident_id, responder, phone_number, status, briefing, created_at, updated_at)
     VALUES (?, ?, ?, 'initiated', ?, ?, ?)`,
  ).run(incidentId, responder, phoneNumber, message, at, at);
  const id = Number(inserted.lastInsertRowid);
  addTimeline(incidentId, "system", "phone_call_initiated", { callRecordId: id, responder });

  void (async () => {
    try {
      if (useElevenLabs) {
        const pendingAction = db
          .prepare(`SELECT id, action FROM proposed_actions WHERE incident_id = ? AND approval_state = 'pending' ORDER BY id DESC LIMIT 1`)
          .get(incidentId) as { id: number; action: string } | undefined;
        const response = await fetch("https://api.elevenlabs.io/v1/convai/sip-trunk/outbound-call", {
          method: "POST",
          headers: { "xi-api-key": elevenKey!, "Content-Type": "application/json" },
          body: JSON.stringify({
            agent_id: elevenAgentId,
            agent_phone_number_id: elevenPhoneId,
            to_number: phoneNumber,
            conversation_initiation_client_data: {
              dynamic_variables: {
                incident_id: String(incidentId),
                call_id: String(id),
                responder,
                proposed_action: pendingAction?.action ?? "none",
                call_briefing: message,
              },
              conversation_config_override: {
                agent: { first_message: message },
              },
            },
          }),
          signal: AbortSignal.timeout(15_000),
        });
        const result = await response.json().catch(() => ({})) as Record<string, unknown>;
        if (!response.ok || result.success === false || typeof result.conversation_id !== "string") {
          throw new Error(`ElevenLabs call request failed (${response.status}): ${JSON.stringify(result).slice(0, 400)}`);
        }
        db.prepare(`UPDATE phone_calls SET retell_call_id = ?, updated_at = ? WHERE id = ?`)
          .run(result.conversation_id, now(), id);
        addTimeline(incidentId, "elevenlabs", "phone_call_connected_to_provider", { callRecordId: id, callId: result.conversation_id });
        return;
      }
      const response = await fetch("https://api.retellai.com/v2/create-phone-call", {
        method: "POST",
        headers: { Authorization: `Bearer ${callToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from_number: fromNumber,
          to_number: phoneNumber,
          override_agent_id: agentId,
          idempotency_key: `secondshift_${incidentId}_${id}`,
          metadata: { incident_id: String(incidentId), call_record_id: String(id), responder },
          retell_llm_dynamic_variables: {
            incident_id: String(incidentId),
            incident_briefing: message,
            incident_status: incident.status,
          },
        }),
        signal: AbortSignal.timeout(10_000),
      });
      const result = await response.json().catch(() => ({})) as Record<string, unknown>;
      if (!response.ok || typeof result.call_id !== "string") {
        throw new Error(`Retell call request failed (${response.status}): ${JSON.stringify(result).slice(0, 400)}`);
      }
      db.prepare(`UPDATE phone_calls SET retell_call_id = ?, updated_at = ? WHERE id = ?`)
        .run(result.call_id, now(), id);
      addTimeline(incidentId, "retell", "phone_call_connected_to_provider", { callRecordId: id, callId: result.call_id });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      db.prepare(`UPDATE phone_calls SET status = 'failed', outcome = ?, updated_at = ? WHERE id = ?`)
        .run(message, now(), id);
      addTimeline(incidentId, useElevenLabs ? "elevenlabs" : "retell", "phone_call_failed", { callRecordId: id, error: message }, "error");
      console.error(`[phone] incident ${incidentId} call failed: ${message}`);
      void reportBackendError(error, { operation: "phone_call_start", incidentId });
      if (responder === (process.env.PRIMARY_RESPONDER ?? "primary-engineer")) {
        try {
          escalate(incidentId, "primary phone call could not be initiated");
          notifyResponder(incidentId, "backup");
        } catch (backupError) {
          void reportBackendError(backupError, { operation: "backup_phone_notification", incidentId });
        }
      }
    }
  })();
  return { id, status: "initiated", duplicate: false, briefing: message };
}

export function notifyResponder(incidentId: number, target: "primary" | "backup" = "primary") {
  const responder = target === "primary"
    ? process.env.PRIMARY_RESPONDER ?? "primary-engineer"
    : process.env.BACKUP_RESPONDER ?? "backup-engineer";
  const phoneNumber = target === "primary" ? process.env.PRIMARY_PHONE : process.env.BACKUP_PHONE;
  if (!phoneNumber) throw new Error(`${target === "primary" ? "PRIMARY_PHONE" : "BACKUP_PHONE"} is not set`);
  return startPhoneCall(incidentId, responder, phoneNumber);
}

export function recordPhoneOutcome(callId: string, status: string, outcome?: string) {
  const allowed = new Set(["initiated", "answered", "acknowledged", "approved", "failed", "unanswered"]);
  if (!allowed.has(status)) throw new Error("invalid call status");
  const call = db.prepare(`SELECT id, incident_id, status AS current_status FROM phone_calls WHERE retell_call_id = ?`).get(callId) as
    { id: number; incident_id: number; current_status: string } | undefined;
  if (!call) throw new Error("phone call not found");
  const effectiveStatus = ["approved", "acknowledged"].includes(call.current_status)
    ? call.current_status
    : status;
  db.prepare(`UPDATE phone_calls SET status = ?, outcome = ?, updated_at = ? WHERE id = ?`)
    .run(effectiveStatus, outcome ?? null, now(), call.id);
  addTimeline(call.incident_id, "retell", `phone_call_${status}`, { callId, outcome });
  return { ok: true, callId, status };
}

export function approveVoiceAction(callId: string, actionId: number, pin: string) {
  const call = db.prepare(`SELECT id, incident_id, responder, phone_number FROM phone_calls WHERE retell_call_id = ? AND status = 'answered'`)
    .get(callId) as { id: number; incident_id: number; responder: string; phone_number: string } | undefined;
  if (!call) throw new Error("an answered, registered call is required");
  const expectedPin = process.env.VOICE_APPROVAL_PIN ?? "";
  const given = Buffer.from(pin);
  const expected = Buffer.from(expectedPin);
  if (!expectedPin || given.length !== expected.length || !timingSafeEqual(given, expected)) {
    throw new Error("voice approval PIN is invalid");
  }
  return approveAndExecute(call.incident_id, actionId, call.responder).then((result) => {
    recordPhoneOutcome(callId, "approved", `approved action ${actionId}`);
    return result;
  });
}
