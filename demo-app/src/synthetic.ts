import { appendFileSync, mkdirSync } from "node:fs";

const BASE = process.env.TARGET ?? `http://localhost:${process.env.PORT ?? 4000}`;
const INTERVAL_MS = Number(process.env.INTERVAL_MS ?? 2000);
mkdirSync("logs", { recursive: true });

// Continuous synthetic checkouts. Records timestamp, outcome and latency independently of the app's own log.
async function once() {
  const started = Date.now();
  const entry: Record<string, unknown> = { at: new Date().toISOString() };
  try {
    const res = await fetch(`${BASE}/checkout`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-request-id": `syn-${Date.now()}` },
      body: JSON.stringify({ items: [{ sku: "sku-tee", qty: 1 }, { sku: "sku-mug", qty: 2 }] }),
    });
    const body: any = await res.json();
    // Correct confirmation = an order id, and a total of 20 + 2*12.
    entry.ok = res.ok && typeof body.orderId === "string" && body.total === 44;
    entry.status = res.status;
    entry.stage = body.stage ?? "confirmation";
    if (!res.ok) entry.error = body.error;
  } catch (err) {
    entry.ok = false;
    entry.status = 0;
    entry.error = String(err);
  }
  entry.latencyMs = Date.now() - started;
  appendFileSync("logs/synthetic.jsonl", JSON.stringify(entry) + "\n");
  console.log(entry.ok ? "OK  " : "FAIL", entry.status, `${entry.latencyMs}ms`, entry.error ?? "");
}

setInterval(once, INTERVAL_MS);
once();
