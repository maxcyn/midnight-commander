// Read-only adapter over Sentry's Explore/Events API. Returns evidence with timestamps and source ids.
function env(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

// The org lives in Sentry's EU region, so the default host is de.sentry.io.
const base = () => process.env.SENTRY_BASE_URL ?? "https://de.sentry.io";

async function query(dataset: "errors" | "logs" | "spans", fields: string[], opts: { minutes: number; query?: string; limit?: number }) {
  const params = new URLSearchParams({
    project: env("SENTRY_PROJECT"),
    dataset,
    statsPeriod: `${Math.max(1, Math.ceil(opts.minutes))}m`,
    per_page: String(opts.limit ?? 50),
    sort: "-timestamp",
  });
  for (const f of fields) params.append("field", f);
  if (opts.query) params.set("query", opts.query);
  const res = await fetch(`${base()}/api/0/organizations/${env("SENTRY_ORG")}/events/?${params}`, {
    headers: { Authorization: `Bearer ${env("SENTRY_AUTH_TOKEN")}` },
    signal: AbortSignal.timeout(10_000),
  });
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Sentry ${dataset} query ${res.status}: ${JSON.stringify(body).slice(0, 300)}`);
  return (body.data ?? []) as Record<string, any>[];
}

export interface Evidence {
  source: "sentry.error" | "sentry.log" | "sentry.span";
  sourceId: string;
  observedAt: string;
  summary: string;
  attributes: Record<string, unknown>;
}

export interface EvidenceBundle {
  window: { minutes: number; retrievedAt: string };
  counts: { errors: number; logs: number; spans: number };
  errors: Evidence[];
  logs: Evidence[];
  spans: Evidence[];
}

const LOG_FIELDS = ["timestamp", "timestamp_precise", "severity", "message", "trace", "dependency", "request_id", "run_id", "failed_stage", "latency_ms"];
const SPAN_FIELDS = ["id", "timestamp", "span.op", "span.description", "span.duration", "span.status", "trace", "run_id"];
const SPAN_OPS = "span.op:[checkout,dependency.recommendations,dependency.payment]";

export async function getEvidence(minutes = 15, runId?: string): Promise<EvidenceBundle> {
  const run = runId ? `run_id:${runId} ` : "";
  // Failures are queried separately from the recent sample: steady healthy traffic would otherwise
  // push the few failures out of a fixed-size window.
  const [errors, failLogs, recentLogs, failSpans, recentSpans] = await Promise.all([
    query("errors", ["id", "timestamp", "title", "trace", "failed_stage", "request_id", "run_id"], { minutes, query: runId ? `run_id:${runId}` : undefined }),
    query("logs", LOG_FIELDS, { minutes, query: `${run}severity:[error,warn,fatal]`, limit: 40 }),
    query("logs", LOG_FIELDS, { minutes, query: run.trim() || undefined, limit: 30 }),
    query("spans", SPAN_FIELDS, { minutes, query: `${run}${SPAN_OPS} !span.status:ok`, limit: 40 }),
    query("spans", SPAN_FIELDS, { minutes, query: `${run}${SPAN_OPS}`, limit: 30 }),
  ]);
  const dedupe = <T extends Record<string, any>>(rows: T[], key: (r: T) => string) => [...new Map(rows.map((r) => [key(r), r])).values()];
  const logs = dedupe([...failLogs, ...recentLogs], (r) => `${r.trace}:${r.timestamp_precise}`).sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));
  const spans = dedupe([...failSpans, ...recentSpans], (r) => r.id).sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)));
  return {
    window: { minutes, retrievedAt: new Date().toISOString() },
    counts: { errors: errors.length, logs: logs.length, spans: spans.length },
    errors: errors.map((r) => ({
      source: "sentry.error", sourceId: r.id, observedAt: r.timestamp, summary: r.title,
      attributes: { trace: r.trace, failed_stage: r.failed_stage, request_id: r.request_id, run_id: r.run_id },
    })),
    logs: logs.map((r) => ({
      source: "sentry.log", sourceId: `${r.trace ?? "no-trace"}:${r.timestamp_precise}`, observedAt: r.timestamp, summary: `[${r.severity}] ${r.message}`,
      attributes: { trace: r.trace, dependency: r.dependency, request_id: r.request_id, run_id: r.run_id, failed_stage: r.failed_stage, latency_ms: r.latency_ms },
    })),
    spans: spans.map((r) => ({
      source: "sentry.span", sourceId: r.id, observedAt: r.timestamp, summary: `${r["span.op"]} ${r["span.description"]} ${Math.round(r["span.duration"])}ms status=${r["span.status"]}`,
      attributes: { trace: r.trace, run_id: r.run_id, op: r["span.op"], durationMs: r["span.duration"], status: r["span.status"] },
    })),
  };
}
