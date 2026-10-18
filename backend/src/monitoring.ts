import { randomUUID } from "node:crypto";

export async function reportBackendError(error: unknown, context: { operation: string; incidentId?: number }) {
  const failure = error instanceof Error ? error : new Error(String(error));
  const safeMessage = failure.message
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]")
    .replace(/\b(?:capi|sk|tok|whsec)_[A-Za-z0-9_-]+/gi, "[REDACTED]")
    .replace(/([?&](?:token|key|secret)=)[^&\s]+/gi, "$1[REDACTED]")
    .slice(0, 500);
  console.error(`[backend-error] ${context.operation}: ${safeMessage}`);
  const dsn = process.env.SENTRY_DSN;
  if (!dsn) {
    console.error("[backend-error] SENTRY_DSN is not configured; error was written to stderr only");
    return;
  }

  try {
    const parsed = new URL(dsn);
    const pathParts = parsed.pathname.split("/").filter(Boolean);
    const projectId = pathParts[pathParts.length - 1];
    if (!parsed.username || !projectId || !["http:", "https:"].includes(parsed.protocol)) {
      throw new Error("SENTRY_DSN is not a valid public Sentry DSN");
    }
    const eventId = randomUUID().replaceAll("-", "");
    const timestamp = new Date().toISOString();
    const envelope = [
      JSON.stringify({ event_id: eventId, sent_at: timestamp, dsn }),
      JSON.stringify({ type: "event" }),
      JSON.stringify({
        event_id: eventId,
        timestamp,
        platform: "node",
        level: "error",
        logger: "secondshift.backend",
        environment: process.env.SENTRY_ENVIRONMENT ?? "demo",
        message: `${context.operation}: ${safeMessage}`,
        tags: {
          service: "secondshift-backend",
          operation: context.operation,
          ...(context.incidentId === undefined ? {} : { incident_id: String(context.incidentId) }),
        },
        exception: { values: [{ type: failure.name, value: safeMessage }] },
      }),
      "",
    ].join("\n");
    const response = await fetch(
      `${parsed.protocol}//${parsed.host}/api/${encodeURIComponent(projectId)}/envelope/?sentry_key=${encodeURIComponent(parsed.username)}&sentry_version=7&sentry_client=secondshift-backend%2F1`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-sentry-envelope" },
        body: envelope,
        signal: AbortSignal.timeout(3_000),
      },
    );
    if (!response.ok) console.error(`[backend-error] Sentry ingest returned HTTP ${response.status}`);
  } catch (reportingError) {
    const message = reportingError instanceof Error ? reportingError.message : String(reportingError);
    console.error(`[backend-error] Sentry error reporting failed: ${message}`);
  }
}
