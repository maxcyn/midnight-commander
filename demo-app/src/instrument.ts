import * as Sentry from "@sentry/node";

// Loaded first (see package.json scripts) so Sentry is ready before the app code runs.
Sentry.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.SENTRY_ENVIRONMENT ?? "demo",
  release: process.env.RELEASE ?? "checkout@demo-1",
  tracesSampleRate: 1.0, // small controlled demo: keep every trace (subject to quota)
  enableLogs: true, // structured logs; plain console output is NOT sent
  // The default Dedupe integration drops an error identical to the previous one, which hides
  // exactly the repeated failures an incident investigation needs to count.
  integrations: (defaults) => defaults.filter((i) => i.name !== "Dedupe"),
  initialScope: { tags: { service: "checkout" } },
});
