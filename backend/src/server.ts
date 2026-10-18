import express, { type NextFunction, type Request, type Response } from "express";
import { getRun, startRun } from "./creao.js";

const PORT = Number(process.env.PORT ?? 3000);
const TOOL_TOKEN = process.env.TOOL_TOKEN;
if (!TOOL_TOKEN) throw new Error("TOOL_TOKEN is not set (see .env.example)");

const app = express();
app.use(express.json({ limit: "1mb" }));

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
  console.log("[submit_investigation]", JSON.stringify(req.body, null, 2));
  submissions.push({ receivedAt: new Date().toISOString(), body: req.body });
  res.json({ accepted: true, count: submissions.length });
});

// Handy for checking what CREAO actually sent.
app.get("/debug/submissions", requireToken, (_req, res) => {
  res.json(submissions);
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
