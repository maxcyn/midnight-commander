import { randomUUID } from "node:crypto";
import * as Sentry from "@sentry/node";
import express, { type NextFunction, type Request, type Response } from "express";

const PORT = Number(process.env.PORT ?? 4000);
const DEV_TOKEN = process.env.DEV_TOKEN;
const ACTION_TOKEN = process.env.ACTION_TOKEN;
const PROBE_TOKEN = process.env.PROBE_TOKEN;
if (!DEV_TOKEN || !ACTION_TOKEN || !PROBE_TOKEN) {
  throw new Error("DEV_TOKEN, ACTION_TOKEN and PROBE_TOKEN must be set (see .env.example)");
}

const RECOMMENDATION_TIMEOUT_MS = 800;
const CATALOG: Record<string, number> = { "sku-tee": 20, "sku-mug": 12, "sku-cap": 15 };

// ---- State ---------------------------------------------------------------
// Feature flag the mitigation changes, plus fault switches only the test runner can set.
const state = {
  recommendationsEnabled: true,
  faults: { recommendation: false, payment: false },
  flagHistory: [] as { at: string; from: boolean; to: boolean; by: string }[],
};

interface RequestRecord {
  at: string;
  requestId: string;
  runId: string;
  ok: boolean;
  status: number;
  stage: string;
  latencyMs: number;
  recommendationsEnabled: boolean;
  error?: string;
}
const requestLog: RequestRecord[] = [];

// ---- Simulated dependencies ----------------------------------------------
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class DependencyError extends Error {
  constructor(public stage: string, message: string, public status: number) {
    super(message);
  }
}

async function lookupRecommendations(): Promise<string[]> {
  const call = async () => {
    await sleep(state.faults.recommendation ? 3000 : 40);
    return ["sku-mug", "sku-cap"];
  };
  const timeout = new Promise<never>((_, reject) =>
    setTimeout(
      () => reject(new DependencyError("recommendations", `recommendation lookup timed out after ${RECOMMENDATION_TIMEOUT_MS}ms`, 504)),
      RECOMMENDATION_TIMEOUT_MS,
    ),
  );
  return Promise.race([call(), timeout]);
}

async function simulatedPayment(amount: number): Promise<string> {
  await sleep(60);
  if (state.faults.payment) throw new DependencyError("payment", "payment provider declined the charge (simulated outage)", 502);
  return `pay_${randomUUID().slice(0, 8)}`;
}

// ---- Checkout ------------------------------------------------------------
interface BasketItem { sku: string; qty: number }

function validateBasket(body: any): { items: BasketItem[]; total: number } {
  const items = body?.items;
  if (!Array.isArray(items) || items.length === 0) throw new DependencyError("validation", "basket is empty", 400);
  let total = 0;
  for (const it of items) {
    if (!(it?.sku in CATALOG) || !Number.isInteger(it.qty) || it.qty < 1) {
      throw new DependencyError("validation", `invalid basket item: ${JSON.stringify(it)}`, 400);
    }
    total += CATALOG[it.sku] * it.qty;
  }
  return { items, total };
}

const app = express();
app.use(express.json());
app.use(express.static(new URL("../public", import.meta.url).pathname));

app.post("/checkout", async (req, res) => {
  const requestId = (req.get("x-request-id") ?? randomUUID()).slice(0, 64);
  // Opaque id the test runner attaches so evidence from one run can be isolated. Carries no scenario meaning.
  const runId = (req.get("x-run-id") ?? "none").slice(0, 64);
  const started = Date.now();
  let stage = "validation";
  const record = (ok: boolean, status: number, error?: string) =>
    requestLog.push({
      at: new Date().toISOString(), requestId, runId, ok, status, stage,
      latencyMs: Date.now() - started,
      recommendationsEnabled: state.recommendationsEnabled, error,
    });
  const attrs = { request_id: requestId, run_id: runId, recommendations_enabled: state.recommendationsEnabled };

  await Sentry.startSpan({ name: "checkout", op: "checkout", attributes: attrs }, async (span) => {
    Sentry.setTags({ request_id: requestId, run_id: runId });
    try {
      const { items, total } = validateBasket(req.body);
      let recommendations: string[] = [];
      if (state.recommendationsEnabled) {
        stage = "recommendations";
        // Deliberately not caught: a recommendation outage breaks checkout. That is the demo bug.
        recommendations = await Sentry.startSpan({ name: "recommendations.lookup", op: "dependency.recommendations" }, async () => {
          const t0 = Date.now();
          const out = await lookupRecommendations();
          Sentry.logger.info("recommendation lookup succeeded", { ...attrs, dependency: "recommendations", latency_ms: Date.now() - t0 });
          return out;
        });
      } else {
        Sentry.logger.info("recommendations skipped (feature disabled)", { ...attrs, dependency: "recommendations" });
      }
      stage = "payment";
      const paymentId = await Sentry.startSpan({ name: "payment.charge", op: "dependency.payment" }, async () => {
        const t0 = Date.now();
        const id = await simulatedPayment(total);
        Sentry.logger.info("payment succeeded", { ...attrs, dependency: "payment", latency_ms: Date.now() - t0 });
        return id;
      });
      stage = "confirmation";
      const orderId = `ord_${randomUUID().slice(0, 8)}`;
      record(true, 200);
      Sentry.logger.info("order confirmed", { ...attrs, order_id: orderId, total });
      res.json({ ok: true, requestId, orderId, paymentId, items, total, recommendations });
    } catch (err) {
      const e = err instanceof DependencyError ? err : new DependencyError(stage, String(err), 500);
      record(false, e.status, e.message);
      span.setStatus({ code: 2, message: e.message });
      span.setAttribute("failed_stage", e.stage);
      if (e.status >= 500) {
        // Server-side failures are the alertable ones; bad baskets (400) are the caller's problem.
        Sentry.logger.error(`checkout failed at ${e.stage}: ${e.message}`, { ...attrs, dependency: e.stage, failed_stage: e.stage });
        Sentry.captureException(err instanceof Error ? err : new Error(e.message), {
          tags: { failed_stage: e.stage },
          extra: { requestId, runId },
        });
      }
      res.status(e.status).json({ ok: false, requestId, stage: e.stage, error: e.message });
    }
  });
});

// ---- Auth helpers --------------------------------------------------------
const bearer = (token: string) => (req: Request, res: Response, next: NextFunction) =>
  req.get("authorization") === `Bearer ${token}` ? next() : res.status(401).json({ error: "unauthorized" });

// ---- Dev controls (test runner only) -------------------------------------
app.post("/dev/faults", bearer(DEV_TOKEN), (req, res) => {
  if (typeof req.body?.recommendation === "boolean") state.faults.recommendation = req.body.recommendation;
  if (typeof req.body?.payment === "boolean") state.faults.payment = req.body.payment;
  res.json(state.faults);
});

app.post("/dev/recommendations", bearer(DEV_TOKEN), (req, res) => {
  if (typeof req.body?.enabled !== "boolean") return res.status(400).json({ error: "enabled must be boolean" });
  state.flagHistory.push({ at: new Date().toISOString(), from: state.recommendationsEnabled, to: req.body.enabled, by: "dev" });
  state.recommendationsEnabled = req.body.enabled;
  Sentry.logger.info("feature flag changed", { flag: "recommendations", to: req.body.enabled, by: "dev" });
  res.json({ recommendationsEnabled: state.recommendationsEnabled });
});

app.post("/dev/reset", bearer(DEV_TOKEN), (_req, res) => {
  state.recommendationsEnabled = true;
  state.faults = { recommendation: false, payment: false };
  state.flagHistory = [];
  requestLog.length = 0;
  res.json({ reset: true });
});

app.get("/dev/state", bearer(DEV_TOKEN), (_req, res) => {
  res.json({ recommendationsEnabled: state.recommendationsEnabled, faults: state.faults });
});

// ---- Evidence the responder may read (no fault labels) -------------------
app.get("/requests", bearer(PROBE_TOKEN), (req, res) => {
  const limit = Math.min(Number(req.query.limit ?? 100), 1000);
  res.json(requestLog.slice(-limit));
});

app.get("/config", bearer(PROBE_TOKEN), (_req, res) => {
  res.json({ recommendationsEnabled: state.recommendationsEnabled, flagHistory: state.flagHistory });
});

// Independent, read-only probes: they exercise the dependency directly, not via checkout,
// so "no payment errors" is never mistaken for "payments healthy".
app.get("/probe/:dependency", bearer(PROBE_TOKEN), async (req, res) => {
  const started = Date.now();
  try {
    if (req.params.dependency === "recommendations") await lookupRecommendations();
    else if (req.params.dependency === "payments") await simulatedPayment(0);
    else return res.status(404).json({ error: "unknown dependency" });
    res.json({ dependency: req.params.dependency, healthy: true, latencyMs: Date.now() - started, at: new Date().toISOString() });
  } catch (err) {
    res.json({
      dependency: req.params.dependency, healthy: false, latencyMs: Date.now() - started,
      error: err instanceof Error ? err.message : String(err), at: new Date().toISOString(),
    });
  }
});

// ---- Mitigation: one explicit, idempotent action (not a toggle) ----------
app.post("/actions/disable-recommendations", bearer(ACTION_TOKEN), (req, res) => {
  const previous = state.recommendationsEnabled;
  if (req.body?.expectedPreviousValue === true && !previous) {
    return res.status(409).json({ error: "precondition failed: recommendations are already disabled", currentValue: false });
  }
  if (previous) {
    state.flagHistory.push({ at: new Date().toISOString(), from: true, to: false, by: String(req.body?.actor ?? "responder") });
    state.recommendationsEnabled = false;
  }
  Sentry.logger.info(previous ? "mitigation applied: recommendations disabled" : "mitigation skipped: already disabled", {
    action: "disable_recommendations", previous_value: previous, current_value: false, actor: String(req.body?.actor ?? "responder"),
  });
  res.json({ action: "disable_recommendations", previousValue: previous, currentValue: false, changed: previous });
});

app.listen(PORT, () => console.log(`demo app on http://localhost:${PORT}`));
