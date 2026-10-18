# SecondShift

SecondShift is a controlled incident-response demo for one checkout service. It correlates real app telemetry, asks CREAO to investigate, gives an enrolled responder a phone/dashboard decision, applies one bounded feature-flag mitigation, and only reports recovery after measured functional checks and fresh successful Sentry traces.

## Local setup

Use a current Node.js release with the built-in `node:sqlite` module. Install dependencies in both project folders:

```powershell
cd backend
npm install
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
cd ..\demo-app
npm install
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
```

Set unique random values for `TOOL_TOKEN`, `WEBHOOK_SECRET`, `DASHBOARD_TOKEN`, `DEBUG_TOKEN`, and `VOICE_TOOL_TOKEN` in `backend/.env`. Set separate values for `DEV_TOKEN`, `ACTION_TOKEN`, and `PROBE_TOKEN` in `demo-app/.env`. Copy the demo app's `PROBE_TOKEN` to backend `DEMO_PROBE_TOKEN`, and its `ACTION_TOKEN` to backend `DEMO_ACTION_TOKEN`. These are separate permissions: CREAO receives only `TOOL_TOKEN`; the checkout app's test runner alone receives `DEV_TOKEN`; the backend alone receives the action token.

Set the same Sentry project values in the app and backend:

- `demo-app/.env`: `SENTRY_DSN`, `SENTRY_ENVIRONMENT=demo`, `RELEASE`
- `backend/.env`: `SENTRY_BASE_URL`, `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, `SENTRY_PROJECT`, `SENTRY_WEBHOOK_SECRET`

Run each process in its own terminal:

```powershell
cd demo-app
npm run dev
```

```powershell
cd backend
npm run dev
```

Open `http://localhost:4000/` for checkout, `http://localhost:4000/dev.html` for test-only fault controls, and `http://localhost:3000/dashboard` for the incident desk. Run `npm run synthetic` in `demo-app` to emit continuous checkouts. It writes its independent result log to `demo-app/logs/synthetic.jsonl`.

## Integrations

### Sentry

Instrumented checkout requests send errors, structured logs, and checkout/dependency spans. Enable Logs in the Sentry project and configure complete trace sampling for this small demo, subject to quota. Create an alert action pointing to `https://<PUBLIC_URL>/sentry-webhook`, configure its signing secret in `SENTRY_WEBHOOK_SECRET`, and include a stable Sentry issue identifier. Webhook bodies are saved before acknowledgement; duplicate deliveries are ignored and queued deliveries are retried after backend restart.

The backend investigator adapter queries errors, logs, and spans. Confirm the account's Explore datasets, field names, permissions, and region through the configured Sentry organization. Recovery requires at least ten successful synthetic checkouts spanning 30 seconds and ten matching successful checkout traces after the action. If Sentry is delayed or unavailable, the incident stays unresolved; the timeline reports functional-only checks rather than a false recovery.

### CREAO

Create a CREAO agent using [agent-prompt.md](./agent-prompt.md), with an `incident_id` input and connected HTTP tools. Set `BACKEND_URL` (the public HTTPS tunnel without a trailing slash) and `BACKEND_TOKEN` (`TOOL_TOKEN`) in CREAO secrets. Configure the backend callback URL using `PUBLIC_URL` and `WEBHOOK_SECRET`.

The adapter currently calls CREAO's `/api/v1/runs` interface. Confirm the Trigger API, tool credentials, and callback payload shape in the hackathon account before relying on it. A harmless tool-call check is `GET /tools/ping`; do not promote the agent's recommendation directly into an action.

### ElevenLabs and Photon (SIP Trunk)

Connect your Photon number to an ElevenLabs voice agent via SIP trunking (`https://photon.codes/docs/beta/cookbooks/voice/elevenlabs`). Set `ELEVENLABS_API_KEY`, `ELEVENLABS_AGENT_ID`, `ELEVENLABS_PHONE_NUMBER_ID`, and enrolled `PRIMARY_PHONE`/`BACKUP_PHONE` values in E.164 form in `backend/.env`.

Run `npm run configure:voice` (`scripts/configure-elevenlabs.ts`) to automatically configure the ElevenLabs agent prompt, dynamic variables, noise/turn settings, and Server Tools pointing to `PUBLIC_URL`. `VOICE_AUTO_CALL` / `PHONE_AUTO_NOTIFY` default to `false` so setup cannot trigger unintentional calls; trigger a live call explicitly via `POST /incidents/:id/call` (`{"live":true}`) or the dashboard's **Call primary** button.

## Demo sequence

1. Confirm a healthy checkout at `http://localhost:4000/`.
2. Start synthetic traffic and turn on only the recommendation fault at `/dev.html`.
3. Let Sentry receive telemetry; its signed webhook creates an incident and triggers CREAO. Alternatively, use the backend's authenticated `POST /debug/alert` endpoint to test the app flow without an alert rule; include the synthetic traffic's `run_id` so functional and Sentry recovery evidence can be correlated to that incident. `scripts/run-scenario.sh` does this automatically.
4. Review the evidence, investigation, pending action, and phone-call record in the dashboard. CREAO's `POST /tools/submit_investigation` must cite source IDs previously retrieved through incident-scoped tools.
5. A configured responder approves the exact pending action in the dashboard or on the ElevenLabs call (`approve_action`, explicit confirmation required). The backend rechecks the recommendation and payment probes and current feature configuration before the single idempotent mutation.
6. Keep synthetic traffic running. Recovery requires the functional/trace thresholds above. Payment failures, mixed dependency failures, stale evidence, rejected actions, and incomplete telemetry remain unresolved and escalate.
7. A verified human-guided intervention produces a versioned draft runbook and fixed evaluation results. Only the primary responder can separately authorise an evaluated version. Matching recurrence can then run that bounded action only after a fresh backend check confirms applicability. Runbooks can be suspended.

## API boundaries

- `TOOL_TOKEN`: CREAO's read-only evidence/configuration/probe/runbook tools and structured submission.
- `DEBUG_TOKEN`: separate operator-only access to `/debug/*` test endpoints.
- `DASHBOARD_TOKEN`: dashboard access. Set `X-Responder` to the configured primary/backup name; only the active owner or escalated backup may approve actions. The primary alone can authorise or suspend runbooks.
- `VOICE_TOOL_TOKEN` (or `TOOL_TOKEN`): ElevenLabs voice tools under `/voice/incidents/:id/*`. Approval requires an enrolled responder and explicit confirmation; set `VOICE_APPROVAL_CODE` to also require a spoken code.
- `DEMO_PROBE_TOKEN`: backend-only read-only configuration, dependency probes, and synthetic request history.
- `DEMO_ACTION_TOKEN`: backend-only explicit mitigation.
- `DEV_TOKEN`: test-runner-only fault injection/reset.

The demo app and responder backend are separate services. Never pass fault-injection credentials to CREAO or the voice agent. Do not expose the dashboard or dev controls directly to the public internet without an authenticated tunnel/network policy.

## Checks

The backend's `npm run selftest` runs isolated SQLite checks for incident deduplication/lifecycle, investigation decisions, and runbook refusal cases. The demo-app `npm run selftest` verifies healthy checkout, recommendation timeout and mitigation, payment counterexample, independent probes, and authorization boundaries; these app checks require the demo service to be running.

The following checks still require configured external accounts and cannot be verified by a local self-test: ingest/retrieve Sentry error+log+trace, CREAO saved-agent Trigger and connected-tool execution, and a real Photon/ElevenLabs phone call. Configure those accounts and complete the checks before presenting the integrations as live.
