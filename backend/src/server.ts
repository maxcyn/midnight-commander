import { computeMetrics } from "./metrics.js";
import express, { type NextFunction, type Request, type Response } from "express";
import { db } from "./db.js";
import { createHmac, timingSafeEqual } from "node:crypto";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { getEvidence } from "./sentry.js";
import { startInvestigation, submitInvestigation, validateResult, onRunFinished } from "./investigation.js";
import { reportBackendError } from "./monitoring.js";
import { acknowledge, addEvidence, getIncident, incidentDetail, listIncidents, parseSentryAlert, processAlert, takeOver } from "./incidents.js";
import { DEPENDENCY_MAP, manifest } from "./manifest.js";
import { approveAndExecute, authoriseRunbook, declineAction, executeAuthorisedRunbook, pastDecisions, recordManualResolution, renderIncidentsMarkdown, suspendRunbook, verifyAuthorisedRunbookApplicability } from "./workflows.js";
import { approveProposedAction, getCall, getLatestCallForIncident, getVoiceBriefing, initiateCall, notifyResponder, recordCallOutcome, type CallOutcome, voiceDeclineAction } from "./voice.js";

const PORT = Number(process.env.PORT ?? 3000);
const TOOL_TOKEN = process.env.TOOL_TOKEN;
if (!TOOL_TOKEN) throw new Error("TOOL_TOKEN is not set (see .env.example)");

const app = express();
// Keep the raw bytes: webhook signatures are computed over them, not over re-serialised JSON.
app.use(express.json({ limit: "1mb", verify: (req, _res, buf) => { (req as any).rawBody = buf; } }));

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

app.get("/", (_req, res) => res.redirect("/dashboard"));
app.get("/dashboard", (_req, res) => res.sendFile(fileURLToPath(new URL("../public/index.html", import.meta.url))));
app.get("/architecture", (_req, res) => res.sendFile(fileURLToPath(new URL("../../architecture.html", import.meta.url))));
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
app.get("/dashboard-api/metrics", dashboardAuth, (_req, res) => res.json(computeMetrics()));
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
    res.json(declineAction(Number(req.params.id), Number(req.params.actionId), req.get("x-responder")!, typeof req.body?.reason === "string" ? req.body.reason : undefined));
  } catch (error) {
    res.status(409).json({ error: error instanceof Error ? error.message : String(error) });
  }
});
app.post("/dashboard-api/incidents/:id/notify", dashboardAuth, async (req, res) => {
  const target = req.body?.target;
  if (target !== "primary" && target !== "backup") return res.status(400).json({ error: "target must be primary or backup" });
  const incident = getIncident(Number(req.params.id));
  if (!incident) return res.status(404).json({ error: "incident not found" });
  if (target === "backup" && incident.escalation_state !== "escalated_to_backup") {
    return res.status(409).json({ error: "the backup responder can be called only after the incident has been escalated" });
  }
  try {
    res.status(202).json(await notifyResponder(incident.id, target));
  } catch (error) {
    res.status(503).json({ error: error instanceof Error ? error.message : String(error) });
  }
});
// "I fixed it myself": record what the engineer did, then verify recovery like any mitigation.
app.post("/dashboard-api/incidents/:id/manual-resolution", dashboardAuth, (req, res) => {
  try {
    res.status(202).json(recordManualResolution(Number(req.params.id), req.get("x-responder")!, String(req.body?.action ?? ""), String(req.body?.note ?? "")));
  } catch (error) {
    res.status(409).json({ error: error instanceof Error ? error.message : String(error) });
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

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/tools/ping", requireToken, (req, res) => {
  console.log(`[ping] incident_id=${req.query.incident_id ?? "-"}`);
  res.json({ ok: true, message: "pong from SecondShift backend", time: new Date().toISOString() });
});

app.get("/tools/service_manifest", requireToken, (_req, res) => {
  res.json(manifest);
});

app.get("/dashboard-api/manifest", dashboardAuth, (_req, res) => {
  res.json(manifest);
});

app.post("/tools/submit_investigation", requireToken, async (req, res) => {
  console.log(`[submit_investigation] incident_id=${req.body?.incident_id ?? "missing"}`);
  try {
    let backendVerifiedRunbook = false;
    const validation = validateResult(req.body);
    if (validation.ok && !validation.value.applicable_runbook && validation.value.recommendation === "permit_runbook") {
      const authRb = db.prepare(`SELECT runbook_id, version FROM runbook_versions WHERE lifecycle = 'authorised' ORDER BY version DESC LIMIT 1`)
        .get() as { runbook_id: string; version: number } | undefined;
      if (authRb) {
        req.body.applicable_runbook = { id: authRb.runbook_id, version: authRb.version, preconditions_met: true };
        validation.value.applicable_runbook = req.body.applicable_runbook;
      }
    }
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
  const depSpec = DEPENDENCY_MAP[dep];
  if (!depSpec) return res.status(400).json({ error: `dependency must be one of ${Object.keys(DEPENDENCY_MAP).join(", ")}` });
  const incidentId = Number(req.query.incident_id);
  if (!Number.isInteger(incidentId) || !getIncident(incidentId)) return res.status(400).json({ error: "valid incident_id is required" });
  if (!process.env.DEMO_PROBE_TOKEN) return res.status(503).json({ error: "DEMO_PROBE_TOKEN is not configured" });
  try {
    const r = await demoGet(depSpec.probe_path);
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

app.get("/tools/past_decisions", requireToken, (req, res) => {
  const out = pastDecisions(Number(req.query.incident_id));
  if (!out) return res.status(404).json({ error: "incident not found" });
  res.json(out);
});

app.get("/tools/incidents_md", requireToken, (_req, res) => {
  res.type("text/markdown").send(renderIncidentsMarkdown());
});

app.get("/dashboard-api/incidents-md", dashboardAuth, (_req, res) => {
  res.json({ markdown: renderIncidentsMarkdown() });
});

app.get("/tools/runbooks", requireToken, (_req, res) => {
  const rows = db.prepare(`SELECT runbook_id, version, lifecycle, spec FROM runbook_versions WHERE lifecycle IN ('evaluated','authorised') ORDER BY runbook_id, version DESC`).all() as any[];
  res.json(rows.map((r) => ({ id: r.runbook_id, version: r.version, status: r.lifecycle, spec: JSON.parse(r.spec) })));
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
        const report = (error: unknown) => { void reportBackendError(error, { operation: "primary_phone_notification", incidentId: out.incidentId }); };
        try { void notifyResponder(out.incidentId, "primary").catch(report); }
        catch (error) { report(error); }
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
  res.json({ ok: true }); // acknowledge first; the work below happens after the response
  setImmediate(() => processSentryDelivery(deliveryId, req.body));
});

setImmediate(() => {
  const pending = db.prepare(`SELECT delivery_id, body FROM webhook_events WHERE status = 'queued' ORDER BY received_at`).all() as
    { delivery_id: string; body: string }[];
  for (const event of pending) processSentryDelivery(event.delivery_id, JSON.parse(event.body));
});

const wrap = (fn: (req: Request, res: Response) => unknown) => (req: Request, res: Response) => {
  try {
    const out = fn(req, res);
    if (out !== undefined) res.json(out);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
};

// ---- Stage 5: ElevenLabs + Photon voice agent endpoints ------------------
const elevenVoiceAuth = (req: Request, res: Response, next: NextFunction) => {
  const auth = req.get("authorization") ?? "";
  const allowed = [process.env.TOOL_TOKEN, process.env.VOICE_TOOL_TOKEN, process.env.DASHBOARD_TOKEN].filter(Boolean);
  if (!allowed.some((tok) => auth === `Bearer ${tok}`)) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
};

app.get("/voice/incidents/:id/briefing", elevenVoiceAuth, wrap((req) => getVoiceBriefing(Number(req.params.id))));

app.post("/voice/incidents/:id/approve", elevenVoiceAuth, async (req, res) => {
  const incidentId = Number(req.params.id);
  const responder = String(req.body?.responder ?? process.env.PRIMARY_RESPONDER ?? "primary-engineer");
  const action = String(req.body?.action ?? "disable_recommendations");
  const confirmed = Boolean(req.body?.confirmed);

  // If DEMO_ACTION_TOKEN is configured and confirmed, run full Stage 6 execution & verification if possible
  if (confirmed && process.env.DEMO_ACTION_TOKEN) {
    const pending = db
      .prepare(`SELECT id FROM proposed_actions WHERE incident_id = ? AND approval_state = 'pending' AND action = ? ORDER BY id DESC LIMIT 1`)
      .get(incidentId, action) as { id: number } | undefined;
    if (pending) {
      try {
        acknowledge(incidentId, responder);
        const execOut = await approveAndExecute(incidentId, pending.id, responder);
        const call = getLatestCallForIncident(incidentId);
        if (call) {
          db.prepare(`UPDATE calls SET outcome = 'approved', updated_at = ?, ended_at = ? WHERE id = ?`)
            .run(new Date().toISOString(), new Date().toISOString(), call.id);
        }
        db.prepare(`UPDATE phone_calls SET status = 'approved', outcome = ?, updated_at = ? WHERE incident_id = ?`)
          .run(`approved action ${pending.id}`, new Date().toISOString(), incidentId);
        return res.json({
          approved: true,
          actionId: pending.id,
          action,
          incidentStatus: execOut.status,
          executionId: execOut.executionId,
          spokenSummary: `Approved and executed ${action} for incident ${incidentId}. Verification is now running.`,
        });
      } catch {
        // Fall through to state-level approval if demo-app is offline during unit/voice tests
      }
    }
  }

  try {
    const out = approveProposedAction({
      incidentId,
      action,
      responder,
      confirmed,
      verificationCode: req.body?.verification_code ? String(req.body.verification_code) : undefined,
    });
    res.status(out.approved ? 200 : 422).json(out);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post("/voice/incidents/:id/decline", elevenVoiceAuth, wrap((req) =>
  voiceDeclineAction({
    incidentId: Number(req.params.id),
    responder: String(req.body?.responder ?? process.env.PRIMARY_RESPONDER ?? "primary-engineer"),
    action: req.body?.action ? String(req.body.action) : undefined,
    reason: typeof req.body?.reason === "string" ? req.body.reason : undefined,
  }),
));

app.post("/incidents/:id/call", elevenVoiceAuth, async (req, res) => {
  try {
    const out = await initiateCall(Number(req.params.id), {
      responder: req.body?.responder ? String(req.body.responder) : undefined,
      live: req.body?.live ?? true,
    });
    res.json(out);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post("/calls/:id/outcome", elevenVoiceAuth, async (req, res) => {
  try {
    const out = await recordCallOutcome(Number(req.params.id), req.body?.outcome as CallOutcome, {
      reason: req.body?.reason,
      live: Boolean(req.body?.live),
    });
    res.json(out);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
  }
});

app.post("/elevenlabs-webhook", async (req, res) => {
  res.json({ ok: true });
  setImmediate(async () => {
    try {
      const data = req.body?.data ?? req.body ?? {};
      const dyn = data?.conversation_initiation_client_data?.dynamic_variables ?? {};
      const callId = Number(dyn.call_id);
      if (!callId) return;
      const call = getCall(callId);
      if (!call || ["approved", "acknowledged"].includes(call.outcome)) return;
      const status = String(data.status ?? "");
      const duration = Number(data?.metadata?.call_duration_secs ?? 0);
      if (status === "failed") {
        await recordCallOutcome(callId, "failed", { reason: "elevenlabs call failed" });
      } else if (duration === 0 && call.outcome === "initiated") {
        await recordCallOutcome(callId, "unanswered", { reason: "call ended with 0s duration" });
      } else if (call.outcome === "initiated") {
        await recordCallOutcome(callId, "answered", { reason: "call completed" });
      }
    } catch (err) {
      console.error("[elevenlabs-webhook]", err);
    }
  });
});

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

// Triggered automatically when a user clicks "Checkout" in the demo-app UI and hits a 5xx error.
app.post("/auto-alert", (req, res) => {
  const auth = req.get("authorization") ?? "";
  const allowed = [process.env.DEMO_PROBE_TOKEN, process.env.DEBUG_TOKEN, process.env.TOOL_TOKEN].filter(Boolean);
  if (!allowed.some((tok) => auth === `Bearer ${tok}`)) {
    return res.status(401).json({ error: "unauthorized" });
  }
  const b = req.body ?? {};
  const alert = parseSentryAlert({ data: { event: {
    issue_id: b.issue_id ?? "ui-checkout-error", title: b.title ?? "Error: recommendation lookup timed out after 800ms",
    event_id: b.event_id ?? `ui-${Date.now()}`, environment: b.environment ?? "demo",
    tags: [["service", "checkout"], ...(b.run_id ? [["run_id", String(b.run_id)]] : [])],
  } } })!;
  const out = processAlert(String(b.delivery_id ?? `ui-${Date.now()}`), alert);
  if (out.incidentId && out.outcome.startsWith("opened")) void startInvestigation(out.incidentId);
  res.json(out);
});

// CREAO calls this when a run finishes. Validate, store, acknowledge quickly.
app.post("/creao-callback", (req, res) => {
  const secret = process.env.WEBHOOK_SECRET;
  if (!secret || req.query.token !== secret) {
    console.warn("[creao-callback] bad token");
    return res.status(401).json({ error: "unauthorized" });
  }
  console.log(`[creao-callback] run_id=${req.body?.runId ?? "missing"} status=${req.body?.status ?? "missing"}`);
  res.json({ ok: true });
  if (req.body?.runId) setImmediate(() => onRunFinished(String(req.body.runId), String(req.body.status)));
});

app.listen(PORT, () => console.log(`backend listening on http://localhost:${PORT}`));
