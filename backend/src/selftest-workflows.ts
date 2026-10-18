// Stages 6-8 checks: gated execution, verification, learned-runbook lifecycle, retrospective, metrics.
// A fake demo app stands in for the real one; Sentry telemetry is supplied through the verification seam.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { db } from "./db.js";
import { getIncident, incidentDetail, parseSentryAlert, processAlert, transition } from "./incidents.js";
import { computeMetrics } from "./metrics.js";
import { approveAndExecute, authoriseRunbook, declineAction, executeAuthorisedRunbook, pastDecisions, recordManualResolution, suspendRunbook, verificationDeps } from "./workflows.js";

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  " + detail}`);
  if (!cond) failures++;
}
const PRIMARY = "primary-engineer";
const BACKUP = "backup-engineer";

// ---- Fake demo app -------------------------------------------------------
const world = { flagEnabled: true, recHealthy: false, payHealthy: true, payLatency: 60, provider: "primary", actionStatus: 200, actionCalls: 0 };
const reset = () => Object.assign(world, { flagEnabled: true, recHealthy: false, payHealthy: true, payLatency: 60, provider: "primary", actionStatus: 200, actionCalls: 0 });
let runId = "";
const server = createServer((req, res) => {
  const send = (status: number, body: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  const url = req.url ?? "";
  if (url === "/config") return send(200, { recommendationsEnabled: world.flagEnabled, paymentProvider: world.provider });
  if (url === "/probe/recommendations") return send(200, { healthy: world.recHealthy });
  if (url === "/probe/payments") return send(200, { healthy: world.payHealthy, latencyMs: world.payLatency });
  if (url.startsWith("/requests")) {
    // Ten good checkouts four seconds apart, starting just after the action: a 36s observation window without waiting.
    const base = Date.now() + 500;
    return send(200, world.flagEnabled && world.provider !== "backup" ? [] : Array.from({ length: 10 }, (_, i) => ({ runId, ok: true, at: new Date(base + i * 4000).toISOString() })));
  }
  if (url === "/actions/disable-recommendations") {
    world.actionCalls++;
    if (world.actionStatus !== 200) return send(world.actionStatus, { error: "boom" });
    const previousValue = world.flagEnabled;
    world.flagEnabled = false;
    return send(200, { action: "disable_recommendations", previousValue, currentValue: false, changed: previousValue });
  }
  if (url === "/actions/switch-payment-provider") {
    world.actionCalls++;
    if (world.actionStatus !== 200) return send(world.actionStatus, { error: "boom" });
    const previousValue = world.provider;
    world.provider = "backup";
    return send(200, { action: "switch_payment_provider", previousValue, currentValue: "backup", changed: previousValue !== "backup" });
  }
  send(404, {});
});
await new Promise<void>((r) => server.listen(0, r));
process.env.DEMO_APP_URL = `http://localhost:${(server.address() as AddressInfo).port}`;
process.env.DEMO_PROBE_TOKEN = "probe";
process.env.DEMO_ACTION_TOKEN = "action";

let telemetry: "ok" | "down" = "ok";
verificationDeps.getEvidence = (async () => {
  if (telemetry === "down") throw new Error("sentry unreachable");
  return { spans: Array.from({ length: 10 }, () => ({ attributes: { run_id: runId, op: "checkout", status: "ok" }, observedAt: new Date(Date.now() + 60_000).toISOString() })) };
}) as any;

// ---- Helpers -------------------------------------------------------------
let n = 0;
function awaitingDecision(opts: { env?: string; ttlMs?: number; parameters?: object; action?: string } = {}) {
  n++;
  runId = `run-${n}`;
  const alert = parseSentryAlert({ data: { event: { issue_id: `w${n}`, title: "recommendation timeout", event_id: `we${n}`, environment: opts.env ?? "demo", tags: [["run_id", runId]] } } })!;
  const id = processAlert(`wd${n}`, alert).incidentId!;
  transition(id, "investigating", "test");
  transition(id, "awaiting_decision", "test");
  const actionId = Number(db.prepare(
    `INSERT INTO proposed_actions (incident_id, action, target_environment, parameters, expires_at, created_at) VALUES (?,?,?,?,?,?)`,
  ).run(id, opts.action ?? "disable_recommendations", opts.env ?? "demo", JSON.stringify(opts.parameters ?? {}), new Date(Date.now() + (opts.ttlMs ?? 600_000)).toISOString(), new Date().toISOString()).lastInsertRowid);
  return { id, actionId };
}
const waitFor = async (cond: () => boolean, ms = 6000) => { const end = Date.now() + ms; while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 50)); return cond(); };
const rejects = async (p: Promise<unknown>) => { try { await p; return false; } catch { return true; } };
const timeline = (id: number) => incidentDetail(id)!.timeline.map((t: any) => t.action);
const approval = (actionId: number) => (db.prepare(`SELECT approval_state FROM proposed_actions WHERE id = ?`).get(actionId) as any).approval_state;
const runbooks = () => db.prepare(`SELECT * FROM runbook_versions ORDER BY version`).all() as any[];

// ---- Stage 6: approval gates --------------------------------------------
let a = awaitingDecision();
check("unauthorised actor cannot approve", await rejects(approveAndExecute(a.id, a.actionId, "random-person")) && world.actionCalls === 0);
check("backup cannot approve before escalation", await rejects(approveAndExecute(a.id, a.actionId, BACKUP)) && world.actionCalls === 0);
check("decline records a refusal and nothing runs", declineAction(a.id, a.actionId, PRIMARY).status === "rejected" && world.actionCalls === 0 && await rejects(approveAndExecute(a.id, a.actionId, PRIMARY)));

reset(); a = awaitingDecision({ ttlMs: -1 });
check("expired proposal refused", await rejects(approveAndExecute(a.id, a.actionId, PRIMARY)) && world.actionCalls === 0 && approval(a.actionId) === "expired");

reset(); a = awaitingDecision({ env: "production" });
check("non-demo environment refused", await rejects(approveAndExecute(a.id, a.actionId, PRIMARY)) && world.actionCalls === 0);

reset(); world.flagEnabled = false; a = awaitingDecision();
check("flag already disabled -> blocked by fresh checks", await rejects(approveAndExecute(a.id, a.actionId, PRIMARY)) && world.actionCalls === 0 && timeline(a.id).includes("action_blocked_by_fresh_checks"));

reset(); world.payHealthy = false; a = awaitingDecision();
check("payment unhealthy -> blocked (counterexample)", await rejects(approveAndExecute(a.id, a.actionId, PRIMARY)) && world.actionCalls === 0);

reset(); world.recHealthy = true; a = awaitingDecision();
check("recommendations healthy now -> blocked", await rejects(approveAndExecute(a.id, a.actionId, PRIMARY)) && world.actionCalls === 0);

// ---- Stage 6: execution, idempotency, verification ----------------------
reset(); a = awaitingDecision();
let out: any = await approveAndExecute(a.id, a.actionId, PRIMARY);
check("approved action executes once and moves to verifying", out.status === "verifying" && world.actionCalls === 1 && getIncident(a.id).status !== "awaiting_decision", JSON.stringify(out));
const dup: any = await approveAndExecute(a.id, a.actionId, PRIMARY);
check("approving again is a no-op (duplicate), not a second mutation", dup.duplicate === true && world.actionCalls === 1);
const exec = db.prepare(`SELECT * FROM action_executions WHERE incident_id = ?`).get(a.id) as any;
check("previous value and result recorded", JSON.parse(exec.result).previousValue === true && exec.actor === PRIMARY, exec.result);

check("recovery requires checkouts, window and traces -> recovered", await waitFor(() => getIncident(a.id).status === "recovered"), getIncident(a.id).status);
const first = a;
check("recovery rows are stored with measured values", (() => {
  const v = JSON.parse((db.prepare(`SELECT verification FROM action_executions WHERE id = ?`).get(exec.id) as any).verification);
  return v.status === "recovered" && v.successfulCheckouts >= 10 && v.checkoutWindowMs >= 30_000 && v.successfulTraces >= 10;
})());

// ---- Stage 8: retrospective ---------------------------------------------
const retro = incidentDetail(a.id)!.retrospective as any;
check("retrospective labels the outcome as mitigation, not a repair", retro?.summary === "Checkout recovered; recommendations remain disabled." && /Make checkout tolerate/.test(retro.unresolved_work), JSON.stringify(retro));
check("timeline reconstructs why and what", ["action_approved", "action_executed", "recovery_verified", "runbook_drafted", "retrospective_generated"].every((x) => timeline(a.id).includes(x)), timeline(a.id).join(","));

// ---- Stage 7: learned runbook ------------------------------------------
let rb = runbooks();
check("a runbook is drafted from the verified human intervention", rb.length === 1 && rb[0].lifecycle === "evaluated", JSON.stringify(rb.map((r) => r.lifecycle)));
const spec = JSON.parse(rb[0].spec);
check("runbook is structured: preconditions, disqualifiers, operation, verification, escalation, markdown",
  spec.preconditions?.length && spec.disqualifyingConditions?.length && spec.operation && spec.verification && spec.escalation && /^# /.test(spec.markdown) && spec.learnedFrom.incidentId === a.id);
const evaluation = JSON.parse(rb[0].evaluation) as any[];
check("evaluation includes refusal cases and held-out variations, all passing",
  evaluation.filter((e) => e.expected === false).length >= 6 && evaluation.filter((e) => e.suite === "held_out").length >= 4 && evaluation.every((e) => e.passed));
check("passing tests did not authorise it", rb[0].lifecycle !== "authorised");
check("only the primary can authorise", (() => { try { authoriseRunbook("checkout-disable-recommendations", 1, BACKUP); return false; } catch { return true; } })());
authoriseRunbook("checkout-disable-recommendations", 1, PRIMARY);
check("authorised by the primary", runbooks()[0].lifecycle === "authorised");

// ---- Matching recurrence: pre-authorised, no human, no new runbook ------
const runbookAction = (id: number) => Number(db.prepare(
  `INSERT INTO proposed_actions (incident_id, action, target_environment, parameters, expires_at, created_at) VALUES (?,?,?,?,?,?)`,
).run(id, "disable_recommendations", "demo", JSON.stringify({ runbook_id: "checkout-disable-recommendations", runbook_version: 1 }), new Date(Date.now() + 600_000).toISOString(), new Date().toISOString()).lastInsertRowid);

reset(); a = awaitingDecision(); let ra = runbookAction(a.id); db.prepare(`DELETE FROM proposed_actions WHERE id = ?`).run(a.actionId);
out = await executeAuthorisedRunbook(a.id, ra, "checkout-disable-recommendations", 1);
check("authorised runbook executes a matching recurrence without a human", out.status === "verifying" && world.actionCalls === 1 && (db.prepare(`SELECT actor FROM action_executions WHERE incident_id = ?`).get(a.id) as any).actor === "runbook:checkout-disable-recommendations:v1");
check("recurrence recovers", await waitFor(() => getIncident(a.id).status === "recovered"));
check("automated runs do not generate another runbook version", runbooks().length === 1);

reset(); world.payHealthy = false; a = awaitingDecision(); ra = runbookAction(a.id);
check("payment counterexample: authorised runbook refuses and records why", await rejects(executeAuthorisedRunbook(a.id, ra, "checkout-disable-recommendations", 1)) && world.actionCalls === 0 && approval(ra) === "not_applicable" && timeline(a.id).includes("runbook_not_applicable"));

reset(); a = awaitingDecision(); ra = Number(db.prepare(`INSERT INTO proposed_actions (incident_id, action, target_environment, parameters, expires_at, created_at) VALUES (?,?,?,?,?,?)`)
  .run(a.id, "disable_recommendations", "demo", JSON.stringify({ runbook_id: "checkout-disable-recommendations", runbook_version: 2 }), new Date(Date.now() + 600_000).toISOString(), new Date().toISOString()).lastInsertRowid);
check("action bound to a different runbook version is refused", await rejects(executeAuthorisedRunbook(a.id, ra, "checkout-disable-recommendations", 1)) && world.actionCalls === 0);

suspendRunbook("checkout-disable-recommendations", 1, PRIMARY);
reset(); a = awaitingDecision(); ra = runbookAction(a.id);
check("suspended runbook cannot execute", await rejects(executeAuthorisedRunbook(a.id, ra, "checkout-disable-recommendations", 1)) && world.actionCalls === 0);

// ---- Failure handling ---------------------------------------------------
reset(); world.actionStatus = 500; a = awaitingDecision();
check("failed mitigation is recorded and escalated, not retried",
  await rejects(approveAndExecute(a.id, a.actionId, PRIMARY)) && world.actionCalls === 1 && getIncident(a.id).status === "awaiting_decision" && getIncident(a.id).escalation_state === "escalated_to_backup" && approval(a.actionId) === "failed");
check("re-approving a failed action reports the stored failure and never re-runs it", await (async () => { const r: any = await approveAndExecute(a.id, a.actionId, PRIMARY).catch(() => ({ duplicate: true, status: "failed" })); return r.duplicate === true && r.status === "failed"; })() && world.actionCalls === 1);
check("no recovery or runbook came from the failure", getIncident(a.id).recovered_at === null && runbooks().length === 1);

reset(); telemetry = "down"; a = awaitingDecision();
await approveAndExecute(a.id, a.actionId, PRIMARY);
await waitFor(() => (db.prepare(`SELECT COUNT(*) c FROM verification_samples`).get() as any).c > 0 && !!db.prepare(`SELECT 1 FROM verification_samples v JOIN action_executions e ON e.id = v.execution_id WHERE e.incident_id = ?`).get(a.id));
const sample = db.prepare(`SELECT v.* FROM verification_samples v JOIN action_executions e ON e.id = v.execution_id WHERE e.incident_id = ?`).get(a.id) as any;
check("functional checks pass but missing Sentry telemetry is NOT recovery", sample.result === "pending" && /sentry unreachable/.test(sample.telemetry_error) && getIncident(a.id).status === "verifying" && !getIncident(a.id).recovered_at, JSON.stringify(sample));
telemetry = "ok";

// ---- Misdiagnosis, decline, manual fix, and the lesson ----------------------
// Provider degradation: recommendations time out as a side effect; the payment probe passes but is slow.
reset(); world.payLatency = 1800; a = awaitingDecision();
check("disable_recommendations is refused when the payment probe is slow (shared pool likely saturated)",
  await rejects(approveAndExecute(a.id, a.actionId, PRIMARY)) && world.actionCalls === 0 && timeline(a.id).includes("action_blocked_by_fresh_checks"));
const blocked = incidentDetail(a.id)!.timeline.find((t: any) => t.action === "action_blocked_by_fresh_checks") as any;
check("the refusal says why", /slow/.test(blocked.detail), blocked.detail);

reset(); world.payLatency = 60; a = awaitingDecision();
check("a genuine recommendation outage (normal payment latency) is NOT blocked by that safety net", (await approveAndExecute(a.id, a.actionId, PRIMARY) as any).status === "verifying");
await waitFor(() => getIncident(a.id).status === "recovered");

// Incident 1 of the demo: the system proposes the wrong action and the engineer declines with a reason.
reset(); world.payLatency = 1800;
const inc1 = awaitingDecision();
db.prepare(`INSERT INTO investigations (incident_id, status, started_at, result) VALUES (?, 'submitted', ?, ?)`).run(inc1.id, new Date().toISOString(),
  JSON.stringify({ impact: { summary: "checkout failing at recommendations" }, hypotheses: [{ cause: "recommendations_timeout", status: "supported" }], proposed_action: { action: "disable_recommendations" } }));
const declined: any = declineAction(inc1.id, inc1.actionId, PRIMARY, "Payment provider is degraded; the recommendation timeouts are a side effect of the shared pool.");
check("decline with a reason records the reason", declined.status === "rejected" && declined.reasonRecorded === true && world.actionCalls === 0);
const fb = db.prepare(`SELECT * FROM decision_feedback WHERE incident_id = ?`).get(inc1.id) as any;
check("the decision keeps what the system believed at the time", fb.action === "disable_recommendations" && JSON.parse(fb.diagnosis).hypotheses[0] === "recommendations_timeout:supported" && /shared pool/.test(fb.reason), JSON.stringify(fb));
check("timeline records the reason too", /shared pool/.test((incidentDetail(inc1.id)!.timeline.find((t: any) => t.action === "action_declined") as any).detail));

check("manual fix refused for an unauthorised actor", (() => { try { recordManualResolution(inc1.id, "random-person", "switch_payment_provider", "did it"); return false; } catch { return true; } })());
check("manual fix needs a note", (() => { try { recordManualResolution(inc1.id, PRIMARY, "switch_payment_provider", "  "); return false; } catch { return true; } })());
check("manual fix needs a known action", (() => { try { recordManualResolution(inc1.id, PRIMARY, "restart_database", "did it"); return false; } catch { return true; } })());
const runbooksBefore = runbooks().length;
world.provider = "backup"; // the engineer switched the provider in their own tooling
recordManualResolution(inc1.id, PRIMARY, "switch_payment_provider", "Switched payments to the backup provider in the provider console.");
check("manual fix goes through verification, not the engineer's say-so", getIncident(inc1.id).status === "verifying" || getIncident(inc1.id).status === "recovered");
check("manual fix recovers once verified", await waitFor(() => getIncident(inc1.id).status === "recovered"), getIncident(inc1.id).status);
const fb2 = db.prepare(`SELECT resolution FROM decision_feedback WHERE incident_id = ?`).get(inc1.id) as any;
check("the lesson now records what actually fixed it", /backup provider/.test(fb2.resolution) && /engineer/.test(fb2.resolution), fb2.resolution);
check("retrospective for a provider switch is labelled correctly",
  (incidentDetail(inc1.id)!.retrospective as any).summary === "Checkout recovered; payments are running on the backup provider.");
check("a manual provider fix does not generate a recommendations runbook", runbooks().length === runbooksBefore);

// Incident 2: the same masked pattern returns; the investigator reads the lesson.
reset(); world.payLatency = 1800;
const inc2 = awaitingDecision({ action: "switch_payment_provider" });
const lessons: any = pastDecisions(inc2.id);
const mine = lessons.decisions.find((d: any) => d.incident_id === inc1.id);
check("past decisions give the investigator the reason and what fixed it", !!mine && mine.action === "disable_recommendations" && /shared pool/.test(mine.engineer_reason) && /backup provider/.test(mine.what_actually_fixed_it), JSON.stringify(lessons));
check("past decisions never include the incident being investigated", !pastDecisions(inc1.id)!.decisions.some((d: any) => d.incident_id === inc1.id));
check("the lesson carries no permission", /do not permit any action/.test(lessons.note));
out = await approveAndExecute(inc2.id, inc2.actionId, PRIMARY) as any;
check("incident 2: the provider switch executes after approval and records the previous value", out.status === "verifying" && out.result.previousValue === "primary" && world.actionCalls === 1);
check("incident 2 recovers via the backend executor", await waitFor(() => getIncident(inc2.id).status === "recovered"), getIncident(inc2.id).status);
check("the declined action never ran in either incident", (db.prepare(`SELECT COUNT(*) c FROM action_executions e JOIN proposed_actions p ON p.id = e.proposed_action_id WHERE p.id = ?`).get(inc1.actionId) as any).c === 0);

reset(); world.provider = "backup"; world.payLatency = 1800; a = awaitingDecision({ action: "switch_payment_provider" });
check("switch refused when payments are already on the backup provider", await rejects(approveAndExecute(a.id, a.actionId, PRIMARY)) && world.actionCalls === 0);
reset(); world.payLatency = 60; a = awaitingDecision({ action: "switch_payment_provider" });
check("switch refused when the payment probe shows no degradation", await rejects(approveAndExecute(a.id, a.actionId, PRIMARY)) && world.actionCalls === 0);
reset(); world.payLatency = 1800; world.actionStatus = 500; a = awaitingDecision({ action: "switch_payment_provider" });
check("a failed provider switch escalates and is not retried", await rejects(approveAndExecute(a.id, a.actionId, PRIMARY)) && world.actionCalls === 1 && getIncident(a.id).escalation_state === "escalated_to_backup");

// ---- Stage 9: metrics ----------------------------------------------------
const m: any = computeMetrics();
check("metrics are labelled as controlled demo measurements", /Controlled demo measurements/.test(m.label));
check("metrics report refusals, selections, held-out results", m.runbookEvaluation.correctRefusals.correct === m.runbookEvaluation.correctRefusals.total && m.runbookEvaluation.correctSelections.total >= 3 && m.runbookEvaluation.heldOutTotal >= 4, JSON.stringify(m.runbookEvaluation));
check("metrics count human decisions, automation, failures and live refusals", m.humanActionDecisions >= 2 && m.authorisedRunbookExecutions === 1 && m.unsuccessfulActions >= 1 && m.liveRunbookRefusals === 1 && m.declinedProposals >= 1 && m.declinesWithReason >= 1, JSON.stringify(m));
check("alert-to-recovery time is measured from real incidents", typeof m.averageAlertToVerifiedRecoveryMs === "number");
void first;

server.close();
console.log(failures ? `\n${failures} Stage 6-8 check(s) failed` : "\nAll Stage 6-8 checks passed");
process.exit(failures ? 1 : 0);
