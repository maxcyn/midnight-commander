import express, { type NextFunction, type Request, type Response } from "express";
import { db } from "./db.js";
import { createHmac, timingSafeEqual } from "node:crypto";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { getRun, startRun } from "./creao.js";
import { getEvidence } from "./sentry.js";
import { startInvestigation, submitInvestigation, validateResult, onRunFinished } from "./investigation.js";
import { reportBackendError } from "./monitoring.js";
import { acknowledge, addEvidence, escalate, getIncident, incidentDetail, listIncidents, parseSentryAlert, processAlert, takeOver } from "./incidents.js";
import { approveAndExecute, approveVoiceAction, authoriseRunbook, declineAction, executeAuthorisedRunbook, notifyResponder, recordPhoneOutcome, suspendRunbook, verifyAuthorisedRunbookApplicability } from "./workflows.js";

const PORT = Number(process.env.PORT ?? 3000);
const TOOL_TOKEN = process.env.TOOL_TOKEN;
if (!TOOL_TOKEN) throw new Error("TOOL_TOKEN is not set (see .env.example)");

const app = express();
// Keep the raw bytes: webhook signatures are computed over them, not over re-serialised JSON.
app.use(express.json({ limit: "1mb", verify: (req, _res, buf) => { (req as any).rawBody = buf; } }));

function verifyRetellSignature(rawBody: Buffer | undefined, signature: string, apiKey: string) {
  const match = /^v=(\d+),d=([a-f0-9]+)$/i.exec(signature);
  if (!rawBody || !match || Math.abs(Date.now() - Number(match[1])) > 5 * 60_000) return false;
  const expected = createHmac("sha256", apiKey).update(Buffer.concat([rawBody, Buffer.from(match[1])])).digest();
  const actual = Buffer.from(match[2], "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

const requireRetellSignature = (req: Request, res: Response, next: NextFunction) => {
  const apiKey = process.env.RETELL_API_KEY;
  if (!apiKey) return res.status(503).json({ error: "RETELL_API_KEY is not configured" });
  if (!verifyRetellSignature((req as any).rawBody, req.get("x-retell-signature") ?? "", apiKey)) {
    return res.status(401).json({ error: "invalid Retell function signature" });
  }
  next();
};

const dashboardAuth = (req: Request, res: Response, next: NextFunction) => {
  const token = process.env.DASHBOARD_TOKEN;
  if (!token) return res.status(503).json({ error: "DASHBOARD_TOKEN is not configured" });
  if (req.get("authorization") !== `Bearer ${token}`) return res.status(401).json({ error: "unauthorized" });
  const actor = req.get("x-responder");
  if (![process.env.PRIMARY_RESPONDER ?? "primary-engineer", process.env.BACKUP_RESPONDER ?? "backup-engineer"].includes(actor ?? "")) {
    return res.status(403).json({ error: "x-responder must identify a configured responder" });
  }
  next();
};

const voiceAuth = (req: Request, res: Response, next: NextFunction) => {
  const token = process.env.VOICE_TOOL_TOKEN;
  if (!token) return res.status(503).json({ error: "VOICE_TOOL_TOKEN is not configured" });
  if (req.get("authorization") !== `Bearer ${token}`) return res.status(401).json({ error: "unauthorized" });
  next();
};

app.get("/dashboard", (_req, res) => res.sendFile(fileURLToPath(new URL("../public/index.html", import.meta.url))));
app.get("/dashboard-api/responders", (req, res) => {
  const token = process.env.DASHBOARD_TOKEN;
  if (!token) return res.status(503).json({ error: "DASHBOARD_TOKEN is not configured" });
  if (req.get("authorization") !== `Bearer ${token}`) return res.status(401).json({ error: "unauthorized" });
  res.json({
    primary: process.env.PRIMARY_RESPONDER ?? "primary-engineer",
    backup: process.env.BACKUP_RESPONDER ?? "backup-engineer",
  });
});
app.get("/dashboard-api/incidents", dashboardAuth, (_req, res) => res.json(listIncidents()));
app.get("/dashboard-api/metrics", dashboardAuth, (_req, res) => {
  const incidents = db.prepare(
    `SELECT i.opened_at, i.recovered_at,
       (SELECT t.at FROM timeline_events t WHERE t.incident_id = i.id AND t.action = 'acknowledged' ORDER BY t.id LIMIT 1) AS acknowledged_at,
       i.alert_count
     FROM incidents i`,
  ).all() as { opened_at: string; recovered_at: string | null; acknowledged_at: string | null; alert_count: number }[];
  const average = (values: number[]) => values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : null;
  const ackDurations = incidents.flatMap((incident) => {
    const duration = incident.acknowledged_at ? Date.parse(incident.acknowledged_at) - Date.parse(incident.opened_at) : NaN;
    return Number.isFinite(duration) && duration >= 0 ? [duration] : [];
  });
  const recoveryDurations = incidents.flatMap((incident) => {
    const duration = incident.recovered_at ? Date.parse(incident.recovered_at) - Date.parse(incident.opened_at) : NaN;
    return Number.isFinite(duration) && duration >= 0 ? [duration] : [];
  });
  const humanDecisions = db.prepare(`SELECT COUNT(*) AS count FROM timeline_events WHERE action IN ('action_approved','action_declined')`).get() as { count: number };
  const automatedActions = db.prepare(`SELECT COUNT(*) AS count FROM action_executions WHERE actor LIKE 'runbook:%'`).get() as { count: number };
  const failedActions = db.prepare(`SELECT COUNT(*) AS count FROM action_executions WHERE status IN ('failed','verification_incomplete')`).get() as { count: number };
  const retries = db.prepare(`SELECT COALESCE(SUM(retry_count), 0) AS count FROM webhook_retries`).get() as { count: number };
  res.json({
    averageAlertToAcknowledgementMs: average(ackDurations),
    averageAlertToVerifiedRecoveryMs: average(recoveryDurations),
    humanActionDecisions: humanDecisions.count,
    authorisedRunbookExecutions: automatedActions.count,
    unsuccessfulActions: failedActions.count,
    repeatAlertsAttached: incidents.reduce((sum, incident) => sum + Math.max(0, incident.alert_count - 1), 0),
    webhookRetriesSuppressed: retries.count,
  });
});
app.get("/dashboard-api/incidents/:id", dashboardAuth, (req, res) => {
  const detail = incidentDetail(Number(req.params.id));
  if (!detail) return res.status(404).json({ error: "incident not found" });
  res.json(detail);
});
app.post("/dashboard-api/incidents/:id/ack", dashboardAuth, (req, res) => {
  try {
    acknowledge(Number(req.params.id), req.get("x-responder")!);
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});
app.post("/dashboard-api/incidents/:id/take-over", dashboardAuth, (req, res) => {
  try {
    takeOver(Number(req.params.id), req.get("x-responder")!);
    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
  }
});
app.post("/dashboard-api/incidents/:id/actions/:actionId/approve", dashboardAuth, async (req, res) => {
  try {
    res.json(await approveAndExecute(Number(req.params.id), Number(req.params.actionId), req.get("x-responder")!));
  } catch (error) {
    res.status(409).json({ error: error instanceof Error ? error.message : String(error) });
  }
});
app.post("/dashboard-api/incidents/:id/actions/:actionId/decline", dashboardAuth, (req, res) => {
  try {
    res.json(declineAction(Number(req.params.id), Number(req.params.actionId), req.get("x-responder")!));
  } catch (error) {
    res.status(409).json({ error: error instanceof Error ? error.message : String(error) });
  }
});
app.post("/dashboard-api/incidents/:id/notify", dashboardAuth, (req, res) => {
  const target = req.body?.target;
  if (target !== "primary" && target !== "backup") return res.status(400).json({ error: "target must be primary or backup" });
  const incident = getIncident(Number(req.params.id));
  if (!incident) return res.status(404).json({ error: "incident not found" });
  if (target === "backup" && incident.escalation_state !== "escalated_to_backup") {
    return res.status(409).json({ error: "escalate the incident before calling the backup responder" });
  }
  try {
    res.status(202).json(notifyResponder(incident.id, target));
  } catch (error) {
    res.status(503).json({ error: error instanceof Error ? error.message : String(error) });
  }
});
app.get("/dashboard-api/runbooks", dashboardAuth, (_req, res) => {
  const rows = db.prepare(`SELECT runbook_id, version, lifecycle, spec, evaluation, created_at FROM runbook_versions ORDER BY runbook_id, version DESC`).all() as any[];
  res.json(rows.map((row) => ({ id: row.runbook_id, version: row.version, lifecycle: row.lifecycle,
    spec: JSON.parse(row.spec), evaluation: row.evaluation ? JSON.parse(row.evaluation) : null, createdAt: row.created_at })));
});
app.post("/dashboard-api/runbooks/:id/:version/authorise", dashboardAuth, (req, res) => {
  try {
    res.json(authoriseRunbook(req.params.id, Number(req.params.version), req.get("x-responder")!));
  } catch (error) {
    res.status(409).json({ error: error instanceof Error ? error.message : String(error) });
  }
});
app.post("/dashboard-api/runbooks/:id/:version/suspend", dashboardAuth, (req, res) => {
  try {
    res.json(suspendRunbook(req.params.id, Number(req.params.version), req.get("x-responder")!));
  } catch (error) {
    res.status(409).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

// Every tool call from CREAO must carry the shared secret.
function requireToken(req: Request, res: Response, next: NextFunction) {
  if (req.get("authorization") !== `Bearer ${TOOL_TOKEN}`) {
    console.warn(`[auth] rejected ${req.method} ${req.path}`);
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
}

function debugAuth(req: Request, res: Response, next: NextFunction) {
  const token = process.env.DEBUG_TOKEN;
  if (!token) return res.status(503).json({ error: "DEBUG_TOKEN is not configured" });
  if (req.get("authorization") !== `Bearer ${token}`) {
    console.warn(`[debug-auth] rejected ${req.method} ${req.path}`);
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
}

// In-memory for now; becomes the incident database later.
const submissions: unknown[] = [];

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/tools/ping", requireToken, (req, res) => {
  console.log(`[ping] incident_id=${req.query.incident_id ?? "-"}`);
  res.json({ ok: true, message: "pong from SecondShift backend", time: new Date().toISOString() });
});

app.post("/tools/submit_investigation", requireToken, async (req, res) => {
  console.log(`[submit_investigation] incident_id=${req.body?.incident_id ?? "missing"}`);
  submissions.push({ receivedAt: new Date().toISOString(), body: req.body });
  try {
    let backendVerifiedRunbook = false;
    const validation = validateResult(req.body);
    if (validation.ok && validation.value.applicable_runbook) {
      const checked = await verifyAuthorisedRunbookApplicability(
        Number(validation.value.incident_id),
        validation.value.applicable_runbook.id,
        Number(validation.value.applicable_runbook.version),
      );
      backendVerifiedRunbook = checked.applicable;
    }
    const out = submitInvestigation(req.body, backendVerifiedRunbook);
    // Rejection reasons go back to the agent so it can correct and resubmit.
    res.status(out.accepted ? 200 : 422).json(out);
    if (out.accepted && out.decision.final === "permit_runbook" && out.proposedActionId && validation.ok && validation.value.applicable_runbook) {
      void executeAuthorisedRunbook(
        Number(validation.value.incident_id),
        out.proposedActionId,
        validation.value.applicable_runbook.id,
        Number(validation.value.applicable_runbook.version),
      ).catch((error) => { void reportBackendError(error, { operation: "runbook_execution", incidentId: Number(validation.value.incident_id) }); });
    }
  } catch (err) {
    void reportBackendError(err, { operation: "submit_investigation" });
    res.status(500).json({ accepted: false, errors: [String(err)] });
  }
});

// Read-only views of the demo app for the investigator. These use the probe token, never the fault controls.
const DEMO = () => process.env.DEMO_APP_URL ?? "http://localhost:4000";
const demoGet = (path: string) =>
  fetch(`${DEMO()}${path}`, {
    headers: { Authorization: `Bearer ${process.env.DEMO_PROBE_TOKEN}` },
    signal: AbortSignal.timeout(5_000),
  });

app.get("/tools/feature_config", requireToken, async (req, res) => {
  const incidentId = Number(req.query.incident_id);
  if (!Number.isInteger(incidentId) || !getIncident(incidentId)) return res.status(400).json({ error: "valid incident_id is required" });
  if (!process.env.DEMO_PROBE_TOKEN) return res.status(503).json({ error: "DEMO_PROBE_TOKEN is not configured" });
  try {
    const r = await demoGet("/config");
    const body = await r.json();
    if (!r.ok) return res.status(r.status).json(body);
    const observedAt = new Date().toISOString();
    const sourceId = `demo.config:${incidentId}:${observedAt}`;
    addEvidence(incidentId, "demo.config", sourceId, observedAt, body);
    res.json({ ...body, source_id: sourceId, observed_at: observedAt });
  } catch (err) {
    res.status(502).json({ error: String(err) });
  }
});

app.get("/tools/probe", requireToken, async (req, res) => {
  const dep = String(req.query.dependency ?? "");
  if (!["recommendations", "payments"].includes(dep)) return res.status(400).json({ error: "dependency must be recommendations or payments" });
  const incidentId = Number(req.query.incident_id);
  if (!Number.isInteger(incidentId) || !getIncident(incidentId)) return res.status(400).json({ error: "valid incident_id is required" });
  if (!process.env.DEMO_PROBE_TOKEN) return res.status(503).json({ error: "DEMO_PROBE_TOKEN is not configured" });
  try {
    const r = await demoGet(`/probe/${dep}`);
    const body = await r.json();
    if (!r.ok) return res.status(r.status).json(body);
    const evidence = body as Record<string, unknown>;
    const observedAt = String(evidence.at ?? new Date().toISOString());
    const sourceId = `demo.probe:${dep}:${observedAt}`;
    addEvidence(incidentId, "demo.probe", sourceId, observedAt, evidence);
    res.json({ ...evidence, source_id: sourceId });
  } catch (err) {
    res.status(502).json({ error: String(err) });
  }
});

app.get("/tools/runbooks", requireToken, (_req, res) => {
  const rows = db.prepare(`SELECT runbook_id, version, lifecycle, spec FROM runbook_versions WHERE lifecycle IN ('evaluated','authorised') ORDER BY runbook_id, version DESC`).all() as any[];
  res.json(rows.map((r) => ({ id: r.runbook_id, version: r.version, status: r.lifecycle, spec: JSON.parse(r.spec) })));
});

// Handy for checking what CREAO actually sent.
app.get("/debug/submissions", debugAuth, (_req, res) => {
  res.json(submissions);
});

// Evidence tool for the CREAO investigator. Window-based for now; scoped to an incident in Stage 3.
// Deliberately returns only observed telemetry: nothing about how failures were injected.
app.get("/tools/sentry_evidence", requireToken, async (req, res) => {
  // Scoped to an incident: from shortly before it opened until now.
  const inc = req.query.incident_id ? getIncident(Number(req.query.incident_id)) : undefined;
  if (req.query.incident_id && !inc) return res.status(404).json({ error: "incident not found" });
  const minutes = inc
    ? Math.min(Math.ceil((Date.now() - Date.parse(inc.opened_at)) / 60_000) + 5, 120)
    : Math.min(Number(req.query.minutes ?? 15) || 15, 120);
  const runId = typeof req.query.run_id === "string" ? req.query.run_id : inc?.run_id;
  try {
    const bundle = await getEvidence(minutes, runId);
    if (inc) {
      for (const item of [...bundle.errors, ...bundle.logs, ...bundle.spans]) {
        addEvidence(inc.id, item.source, item.sourceId, item.observedAt, item);
      }
    }
    res.json(bundle);
  } catch (err) {
    void reportBackendError(err, { operation: "sentry_evidence", incidentId: inc?.id });
    res.status(502).json({ error: String(err) });
  }
});

// Sentry alert webhook: verify signature, drop duplicate deliveries, save, acknowledge fast, process later.
const alerts: { receivedAt: string; deliveryId: string; body: unknown }[] = [];
function processSentryDelivery(deliveryId: string, body: unknown) {
  try {
    const alert = parseSentryAlert(body);
    if (!alert) {
      db.prepare(`UPDATE webhook_events SET status = 'ignored', body = '{}', error = ? WHERE delivery_id = ?`)
        .run("payload has no Sentry issue id", deliveryId);
      console.warn(`[sentry-webhook] delivery ${deliveryId} has no issue id; saved but not processed`);
      return;
    }
    const out = processAlert(deliveryId, alert);
    db.prepare(`UPDATE webhook_events SET status = 'processed', incident_id = ?, body = '{}' WHERE delivery_id = ?`)
      .run(out.incidentId ?? null, deliveryId);
    console.log(`[sentry-webhook] delivery ${deliveryId}: ${out.outcome}${out.incidentId ? ` incident #${out.incidentId}` : ""}`);
    if (out.incidentId && out.outcome.startsWith("opened")) {
      void startInvestigation(out.incidentId).catch((error) => { void reportBackendError(error, { operation: "investigation_start", incidentId: out.incidentId }); });
      if (process.env.PHONE_AUTO_NOTIFY === "true") {
        try { notifyResponder(out.incidentId, "primary"); }
        catch (error) { void reportBackendError(error, { operation: "primary_phone_notification", incidentId: out.incidentId }); }
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    db.prepare(`UPDATE webhook_events SET status = 'failed', body = '{}', error = ? WHERE delivery_id = ?`)
      .run(message, deliveryId);
    void reportBackendError(error, { operation: "sentry_webhook" });
  }
}

app.post("/sentry-webhook", (req, res) => {
  const secret = process.env.SENTRY_WEBHOOK_SECRET;
  if (!secret) return res.status(503).json({ error: "SENTRY_WEBHOOK_SECRET is not configured" });
  const given = Buffer.from(req.get("sentry-hook-signature") ?? "", "hex");
  const want = createHmac("sha256", secret).update((req as any).rawBody ?? "").digest();
  if (given.length !== want.length || !timingSafeEqual(given, want)) {
    console.warn("[sentry-webhook] bad signature");
    return res.status(401).json({ error: "bad signature" });
  }
  const rawBody = (req as any).rawBody as Buffer;
  const deliveryId = req.get("request-id") ?? req.get("sentry-hook-delivery") ??
    createHash("sha256").update(rawBody).digest("hex");
  const saved = db.prepare(
    `INSERT OR IGNORE INTO webhook_events (delivery_id, received_at, body, status) VALUES (?, ?, ?, 'queued')`,
  ).run(deliveryId, new Date().toISOString(), rawBody.toString("utf8"));
  if (saved.changes === 0) {
    db.prepare(
      `INSERT INTO webhook_retries (delivery_id, retry_count, last_received_at) VALUES (?, 1, ?)
       ON CONFLICT(delivery_id) DO UPDATE SET retry_count = retry_count + 1, last_received_at = excluded.last_received_at`,
    ).run(deliveryId, new Date().toISOString());
    return res.json({ ok: true, duplicate: true });
  }
  alerts.push({ receivedAt: new Date().toISOString(), deliveryId, body: req.body });
  res.json({ ok: true }); // acknowledge first; the work below happens after the response
  setImmediate(() => processSentryDelivery(deliveryId, req.body));
});

setImmediate(() => {
  const pending = db.prepare(`SELECT delivery_id, body FROM webhook_events WHERE status = 'queued' ORDER BY received_at`).all() as
    { delivery_id: string; body: string }[];
  for (const event of pending) processSentryDelivery(event.delivery_id, JSON.parse(event.body));
});

app.post("/retell-webhook", (req, res) => {
  const apiKey = process.env.RETELL_API_KEY;
  if (!apiKey) return res.status(503).json({ error: "RETELL_API_KEY is not configured" });
  const rawBody = (req as any).rawBody as Buffer;
  const signature = req.get("x-retell-signature") ?? "";
  const match = /^v=(\d+),d=([a-f0-9]+)$/i.exec(signature);
  if (!match || Math.abs(Date.now() - Number(match[1])) > 5 * 60_000) {
    return res.status(401).json({ error: "invalid or expired Retell signature" });
  }
  const expected = createHmac("sha256", apiKey).update(Buffer.concat([rawBody, Buffer.from(match[1])])).digest();
  const actual = Buffer.from(match[2], "hex");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return res.status(401).json({ error: "invalid Retell signature" });
  }
  const eventId = createHash("sha256").update(rawBody).digest("hex");
  const saved = db.prepare(`INSERT OR IGNORE INTO retell_webhook_events (event_id, received_at) VALUES (?, ?)`)
    .run(eventId, new Date().toISOString());
  if (saved.changes === 0) return res.status(204).end();
  const event = String(req.body?.event ?? "");
  const call = req.body?.call ?? {};
  const callId = String(call.call_id ?? "");
  const recordId = Number(call.metadata?.call_record_id);
  let record = recordId
    ? db.prepare(`SELECT id, incident_id, responder, phone_number, status FROM phone_calls WHERE id = ?`).get(recordId) as any
    : undefined;
  if (!record && callId) {
    record = db.prepare(`SELECT id, incident_id, responder, phone_number, status, retell_call_id FROM phone_calls WHERE retell_call_id = ?`).get(callId) as any;
  }
  if (record && callId && !record.retell_call_id) {
    db.prepare(`UPDATE phone_calls SET retell_call_id = ?, updated_at = ? WHERE id = ?`)
      .run(callId, new Date().toISOString(), record.id);
  }
  if (!record || !callId) {
    console.warn(`[retell-webhook] ${event} could not be linked to a registered call`);
    return res.status(204).end();
  }

  if (event === "call_started") {
    recordPhoneOutcome(callId, "answered");
  } else if (event === "call_ended") {
    const reason = String(call.disconnection_reason ?? "call ended");
    const unanswered = ["dial_no_answer", "dial_failed", "dial_busy"].includes(reason);
    recordPhoneOutcome(callId, unanswered ? (reason === "dial_no_answer" ? "unanswered" : "failed") : "answered", reason);
    if (unanswered && record.responder === (process.env.PRIMARY_RESPONDER ?? "primary-engineer")) {
      try {
        escalate(record.incident_id, "primary responder did not answer");
        notifyResponder(record.incident_id, "backup");
      } catch (error) {
        void reportBackendError(error, { operation: "backup_phone_escalation", incidentId: record.incident_id });
      }
    }
  } else if (event === "call_analyzed") {
    const outcome = call.call_analysis?.custom_analysis_data?.responder_outcome;
    if (outcome === "acknowledged" || outcome === "approved") recordPhoneOutcome(callId, outcome);
  }
  res.status(204).end();
});

function answeredVoiceCall(callId: unknown) {
  if (typeof callId !== "string" || !callId) return undefined;
  return db.prepare(`SELECT id, incident_id, responder, status FROM phone_calls WHERE retell_call_id = ? AND status IN ('answered', 'acknowledged', 'approved')`)
    .get(callId) as { id: number; incident_id: number; responder: string; status: string } | undefined;
}

const voiceArgs = (req: Request) => req.body?.args ?? req.body ?? {};
const voiceCallId = (req: Request) => req.body?.call?.call_id ?? voiceArgs(req).call_id ?? req.query.call_id;

app.post("/voice/briefing", voiceAuth, requireRetellSignature, (req, res) => {
  const call = answeredVoiceCall(voiceCallId(req));
  if (!call) return res.status(403).json({ error: "an active registered responder call is required" });
  const detail = incidentDetail(call.incident_id);
  if (!detail) return res.status(404).json({ error: "incident not found" });
  const decision = [...detail.timeline].reverse().find((item: any) => String(item.action).startsWith("decision_")) as any;
  res.json({
    incident: detail.incident,
    briefing: decision?.detail ? JSON.parse(decision.detail).briefing : `Incident ${call.incident_id}: checkout failures are under investigation.`,
    pendingActions: detail.proposedActions.filter((action: any) =>
      action.approval_state === "pending" && Date.parse(action.expires_at) > Date.now()),
  });
});
app.post("/voice/evidence", voiceAuth, requireRetellSignature, async (req, res) => {
  const call = answeredVoiceCall(voiceCallId(req));
  if (!call) return res.status(403).json({ error: "an active registered responder call is required" });
  const incident = getIncident(call.incident_id);
  if (!incident) return res.status(404).json({ error: "incident not found" });
  const minutes = Math.min(120, Math.max(2, Math.ceil((Date.now() - Date.parse(incident.opened_at)) / 60_000) + 1));
  try {
    res.json(await getEvidence(minutes));
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
  }
});
app.post("/voice/status", voiceAuth, requireRetellSignature, (req, res) => {
  const call = answeredVoiceCall(voiceCallId(req));
  if (!call) return res.status(403).json({ error: "an active registered responder call is required" });
  const detail = incidentDetail(call.incident_id);
  if (!detail) return res.status(404).json({ error: "incident not found" });
  const latestSample = detail.executions.length
    ? db.prepare(`SELECT * FROM verification_samples WHERE execution_id = ? ORDER BY id DESC LIMIT 1`)
      .get((detail.executions[detail.executions.length - 1] as any).id) ?? null
    : null;
  res.json({
    incident_id: call.incident_id,
    status: detail.incident.status,
    recovered: detail.incident.status === "recovered",
    recovery_note: detail.retrospective?.summary ?? null,
    latest_verification: latestSample,
  });
});
app.post("/voice/probe", voiceAuth, requireRetellSignature, async (req, res) => {
  const args = voiceArgs(req);
  const call = answeredVoiceCall(voiceCallId(req));
  if (!call) return res.status(403).json({ error: "an active registered responder call is required" });
  const dependency = String(args.dependency ?? "");
  if (!["recommendations", "payments"].includes(dependency)) {
    return res.status(400).json({ error: "dependency must be recommendations or payments" });
  }
  try {
    const response = await demoGet(`/probe/${dependency}`);
    res.status(response.status).json(await response.json());
  } catch (error) {
    res.status(502).json({ error: error instanceof Error ? error.message : String(error) });
  }
});
app.post("/voice/acknowledge", voiceAuth, requireRetellSignature, (req, res) => {
  const callId = String(voiceCallId(req) ?? "");
  const call = answeredVoiceCall(callId);
  if (!call) return res.status(403).json({ error: "an active registered responder call is required" });
  try {
    acknowledge(call.incident_id, call.responder);
    recordPhoneOutcome(callId, "acknowledged", "responder acknowledged incident");
    res.json({ ok: true, incident_id: call.incident_id });
  } catch (error) {
    res.status(409).json({ error: error instanceof Error ? error.message : String(error) });
  }
});
app.post("/voice/approve", voiceAuth, requireRetellSignature, async (req, res) => {
  const args = voiceArgs(req);
  if (typeof args.action_id !== "number" || typeof args.pin !== "string") {
    return res.status(400).json({ error: "action_id and pin are required" });
  }
  try {
    res.json(await approveVoiceAction(String(voiceCallId(req) ?? ""), args.action_id, args.pin));
  } catch (error) {
    res.status(409).json({ error: error instanceof Error ? error.message : String(error) });
  }
});
app.post("/voice/decline", voiceAuth, requireRetellSignature, (req, res) => {
  const args = voiceArgs(req);
  const callId = String(voiceCallId(req) ?? "");
  const call = answeredVoiceCall(callId);
  if (!call) return res.status(403).json({ error: "an active registered responder call is required" });
  if (typeof args.action_id !== "number") return res.status(400).json({ error: "action_id is required" });
  try {
    const result = declineAction(call.incident_id, args.action_id, call.responder);
    recordPhoneOutcome(callId, "acknowledged", `declined action ${args.action_id}`);
    res.json(result);
  } catch (error) {
    res.status(409).json({ error: error instanceof Error ? error.message : String(error) });
  }
});
app.post("/voice/take-over", voiceAuth, requireRetellSignature, (req, res) => {
  const callId = String(voiceCallId(req) ?? "");
  const call = answeredVoiceCall(callId);
  if (!call) return res.status(403).json({ error: "an active registered responder call is required" });
  try {
    takeOver(call.incident_id, call.responder);
    recordPhoneOutcome(callId, "acknowledged", "responder took over; autonomous actions halted");
    res.json({ ok: true, incident_id: call.incident_id, autonomy: "halted" });
  } catch (error) {
    res.status(409).json({ error: error instanceof Error ? error.message : String(error) });
  }
});

// ---- Incident API (dashboard and voice agent read from here) -----------
const wrap = (fn: (req: Request, res: Response) => unknown) => (req: Request, res: Response) => {
  try {
    const out = fn(req, res);
    if (out !== undefined) res.json(out);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
};
app.get("/incidents", dashboardAuth, wrap(() => listIncidents()));
app.get("/incidents/:id", dashboardAuth, wrap((req, res) => {
  const d = incidentDetail(Number(req.params.id));
  if (!d) return void res.status(404).json({ error: "not found" });
  return d;
}));
app.post("/incidents/:id/ack", dashboardAuth, wrap((req) => { acknowledge(Number(req.params.id), req.get("x-responder")!); return { ok: true }; }));
app.post("/incidents/:id/escalate", dashboardAuth, wrap((req) => { escalate(Number(req.params.id), String(req.body?.reason ?? "manual")); return { ok: true }; }));
app.post("/incidents/:id/take-over", dashboardAuth, wrap((req) => { takeOver(Number(req.params.id), req.get("x-responder")!); return { ok: true }; }));

// Lets you exercise the full path (incident -> CREAO -> decision) without waiting for a Sentry alert rule.
app.post("/debug/alert", debugAuth, (req, res) => {
  const b = req.body ?? {};
  const alert = parseSentryAlert({ data: { event: {
    issue_id: b.issue_id ?? "debug-1", title: b.title ?? "Error: recommendation lookup timed out after 800ms",
    event_id: b.event_id ?? `dbg-${Date.now()}`, environment: b.environment ?? "demo",
    tags: [["service", "checkout"], ...(b.run_id ? [["run_id", String(b.run_id)]] : [])],
  } } })!;
  const out = processAlert(String(b.delivery_id ?? `dbg-${Date.now()}`), alert);
  if (out.incidentId && out.outcome.startsWith("opened")) void startInvestigation(out.incidentId);
  res.json(out);
});

app.get("/debug/alerts", debugAuth, (_req, res) => {
  res.json(alerts);
});

// Kick off a CREAO investigation. Manual for now; later the Sentry webhook calls this.
app.post("/debug/trigger", debugAuth, async (req, res) => {
  const incidentId = String(req.body?.incident_id ?? "test");
  const attempt = String(req.body?.attempt ?? "1");
  try {
    const run = await startRun({ incident_id: incidentId }, `incident-${incidentId}-investigation-${attempt}`);
    console.log(`[creao] started run ${run.id} for incident ${incidentId}`);
    res.status(202).json(run);
  } catch (err) {
    void reportBackendError(err, { operation: "creao_start" });
    res.status(502).json({ error: String(err) });
  }
});

// CREAO calls this when a run finishes. Validate, store, acknowledge quickly.
const callbacks: unknown[] = [];
app.post("/creao-callback", (req, res) => {
  const secret = process.env.WEBHOOK_SECRET;
  if (!secret || req.query.token !== secret) {
    console.warn("[creao-callback] bad token");
    return res.status(401).json({ error: "unauthorized" });
  }
  console.log(`[creao-callback] run_id=${req.body?.runId ?? "missing"} status=${req.body?.status ?? "missing"}`);
  callbacks.push({ receivedAt: new Date().toISOString(), body: req.body });
  res.json({ ok: true });
  if (req.body?.runId) setImmediate(() => onRunFinished(String(req.body.runId), String(req.body.status)));
});

app.get("/debug/callbacks", debugAuth, (_req, res) => {
  res.json(callbacks);
});

// Polling fallback if the webhook never arrives.
app.get("/debug/run/:id", debugAuth, async (req, res) => {
  try {
    res.json(await getRun(String(req.params.id)));
  } catch (err) {
    res.status(502).json({ error: String(err) });
  }
});

app.listen(PORT, () => console.log(`backend listening on http://localhost:${PORT}`));
