import express, { type NextFunction, type Request, type Response } from "express";
import { db } from "./db.js";
import { createHmac, timingSafeEqual } from "node:crypto";
import { getRun, startRun } from "./creao.js";
import { getEvidence } from "./sentry.js";
import { startInvestigation, submitInvestigation, onRunFinished } from "./investigation.js";
import { acknowledge, escalate, getIncident, incidentDetail, listIncidents, parseSentryAlert, processAlert, takeOver, transition, type Status } from "./incidents.js";

const PORT = Number(process.env.PORT ?? 3000);
const TOOL_TOKEN = process.env.TOOL_TOKEN;
if (!TOOL_TOKEN) throw new Error("TOOL_TOKEN is not set (see .env.example)");

const app = express();
// Keep the raw bytes: webhook signatures are computed over them, not over re-serialised JSON.
app.use(express.json({ limit: "1mb", verify: (req, _res, buf) => { (req as any).rawBody = buf; } }));

// Every tool call from CREAO must carry the shared secret.
function requireToken(req: Request, res: Response, next: NextFunction) {
  if (req.get("authorization") !== `Bearer ${TOOL_TOKEN}`) {
    console.warn(`[auth] rejected ${req.method} ${req.path}`);
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

app.post("/tools/submit_investigation", requireToken, (req, res) => {
  console.log("[submit_investigation]", JSON.stringify(req.body).slice(0, 400));
  submissions.push({ receivedAt: new Date().toISOString(), body: req.body });
  try {
    const out = submitInvestigation(req.body);
    // Rejection reasons go back to the agent so it can correct and resubmit.
    res.status(out.accepted ? 200 : 422).json(out);
  } catch (err) {
    console.error("[submit_investigation]", err);
    res.status(500).json({ accepted: false, errors: [String(err)] });
  }
});

// Read-only views of the demo app for the investigator. These use the probe token, never the fault controls.
const DEMO = () => process.env.DEMO_APP_URL ?? "http://localhost:4000";
const demoGet = (path: string) =>
  fetch(`${DEMO()}${path}`, { headers: { Authorization: `Bearer ${process.env.DEMO_PROBE_TOKEN}` } });

app.get("/tools/feature_config", requireToken, async (_req, res) => {
  try {
    const r = await demoGet("/config");
    res.status(r.status).json(await r.json());
  } catch (err) {
    res.status(502).json({ error: String(err) });
  }
});

app.get("/tools/probe", requireToken, async (req, res) => {
  const dep = String(req.query.dependency ?? "");
  if (!["recommendations", "payments"].includes(dep)) return res.status(400).json({ error: "dependency must be recommendations or payments" });
  try {
    const r = await demoGet(`/probe/${dep}`);
    res.status(r.status).json(await r.json());
  } catch (err) {
    res.status(502).json({ error: String(err) });
  }
});

app.get("/tools/runbooks", requireToken, (_req, res) => {
  const rows = db.prepare(`SELECT runbook_id, version, lifecycle, spec FROM runbook_versions WHERE lifecycle IN ('evaluated','authorised') ORDER BY runbook_id, version DESC`).all() as any[];
  res.json(rows.map((r) => ({ id: r.runbook_id, version: r.version, status: r.lifecycle, spec: JSON.parse(r.spec) })));
});

// Handy for checking what CREAO actually sent.
app.get("/debug/submissions", requireToken, (_req, res) => {
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
  const runId = typeof req.query.run_id === "string" ? req.query.run_id : undefined;
  try {
    res.json(await getEvidence(minutes, runId));
  } catch (err) {
    console.error("[sentry_evidence]", err);
    res.status(502).json({ error: String(err) });
  }
});

// Sentry alert webhook: verify signature, drop duplicate deliveries, save, acknowledge fast, process later.
const alerts: { receivedAt: string; deliveryId: string; body: unknown }[] = [];
app.post("/sentry-webhook", (req, res) => {
  const secret = process.env.SENTRY_WEBHOOK_SECRET;
  if (secret) {
    const given = Buffer.from(req.get("sentry-hook-signature") ?? "", "hex");
    const want = createHmac("sha256", secret).update((req as any).rawBody ?? "").digest();
    if (given.length !== want.length || !timingSafeEqual(given, want)) {
      console.warn("[sentry-webhook] bad signature");
      return res.status(401).json({ error: "bad signature" });
    }
  }
  const deliveryId = req.get("request-id") ?? req.get("sentry-hook-timestamp") ?? `local-${Date.now()}`;
  alerts.push({ receivedAt: new Date().toISOString(), deliveryId, body: req.body });
  res.json({ ok: true }); // acknowledge first; the work below happens after the response
  setImmediate(() => {
    try {
      const alert = parseSentryAlert(req.body);
      if (!alert) return console.warn(`[sentry-webhook] delivery ${deliveryId} has no issue id; saved but not processed`);
      const out = processAlert(deliveryId, alert);
      console.log(`[sentry-webhook] delivery ${deliveryId}: ${out.outcome}${out.incidentId ? ` incident #${out.incidentId}` : ""}`);
      if (out.incidentId && out.outcome.startsWith("opened")) void startInvestigation(out.incidentId);
    } catch (err) {
      console.error("[sentry-webhook] processing failed", err);
    }
  });
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
app.get("/incidents", requireToken, wrap(() => listIncidents()));
app.get("/incidents/:id", requireToken, wrap((req, res) => {
  const d = incidentDetail(Number(req.params.id));
  if (!d) return void res.status(404).json({ error: "not found" });
  return d;
}));
app.post("/incidents/:id/ack", requireToken, wrap((req) => { acknowledge(Number(req.params.id), String(req.body?.by ?? "unknown")); return { ok: true }; }));
app.post("/incidents/:id/escalate", requireToken, wrap((req) => { escalate(Number(req.params.id), String(req.body?.reason ?? "manual")); return { ok: true }; }));
app.post("/incidents/:id/take-over", requireToken, wrap((req) => { takeOver(Number(req.params.id), String(req.body?.by ?? "unknown")); return { ok: true }; }));
app.post("/incidents/:id/transition", requireToken, wrap((req) => { transition(Number(req.params.id), req.body?.to as Status, String(req.body?.actor ?? "system")); return { ok: true }; }));

// Lets you exercise the full path (incident -> CREAO -> decision) without waiting for a Sentry alert rule.
app.post("/debug/alert", requireToken, (req, res) => {
  const b = req.body ?? {};
  const alert = parseSentryAlert({ data: { event: {
    issue_id: b.issue_id ?? "debug-1", title: b.title ?? "Error: recommendation lookup timed out after 800ms",
    event_id: b.event_id ?? `dbg-${Date.now()}`, environment: b.environment ?? "demo",
  } } })!;
  const out = processAlert(String(b.delivery_id ?? `dbg-${Date.now()}`), alert);
  if (out.incidentId && out.outcome.startsWith("opened")) void startInvestigation(out.incidentId);
  res.json(out);
});

app.get("/debug/alerts", requireToken, (_req, res) => {
  res.json(alerts);
});

// Kick off a CREAO investigation. Manual for now; later the Sentry webhook calls this.
app.post("/debug/trigger", requireToken, async (req, res) => {
  const incidentId = String(req.body?.incident_id ?? "test");
  const attempt = String(req.body?.attempt ?? "1");
  try {
    const run = await startRun({ incident_id: incidentId }, `incident-${incidentId}-investigation-${attempt}`);
    console.log(`[creao] started run ${run.id} for incident ${incidentId}`);
    res.status(202).json(run);
  } catch (err) {
    console.error("[creao] start failed", err);
    res.status(502).json({ error: String(err) });
  }
});

// CREAO calls this when a run finishes. Validate, store, acknowledge quickly.
const callbacks: unknown[] = [];
app.post("/creao-callback", (req, res) => {
  if (req.query.token !== process.env.WEBHOOK_SECRET) {
    console.warn("[creao-callback] bad token");
    return res.status(401).json({ error: "unauthorized" });
  }
  console.log("[creao-callback]", JSON.stringify(req.body, null, 2));
  callbacks.push({ receivedAt: new Date().toISOString(), body: req.body });
  res.json({ ok: true });
  if (req.body?.runId) setImmediate(() => onRunFinished(String(req.body.runId), String(req.body.status)));
});

app.get("/debug/callbacks", requireToken, (_req, res) => {
  res.json(callbacks);
});

// Polling fallback if the webhook never arrives.
app.get("/debug/run/:id", requireToken, async (req, res) => {
  try {
    res.json(await getRun(String(req.params.id)));
  } catch (err) {
    res.status(502).json({ error: String(err) });
  }
});

app.listen(PORT, () => console.log(`backend listening on http://localhost:${PORT}`));
