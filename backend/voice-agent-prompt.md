# ElevenLabs + Photon responder agent setup

Run `npm run configure:voice` (`scripts/configure-elevenlabs.ts`) to automatically configure the ElevenLabs voice agent via the ElevenLabs REST API (`PATCH /v1/convai/agents/:id`) with the SecondShift prompt, dynamic variables (`incident_id`, `call_id`, `responder`, `proposed_action`, `call_briefing`), noise/interruption settings, and webhook tools pointing to `PUBLIC_URL`.

## ElevenLabs Server Tools (configured automatically by `npm run configure:voice`)

| Tool | Method & URL | Purpose |
|---|---|---|
| `explain_evidence` | `GET /voice/incidents/{incident_id}/briefing` | Retrieve incident briefing, impact, hypotheses, and evidence |
| `check_dependency` | `POST /voice/incidents/{incident_id}/probe` | Run live read-only probe on `payments` or `recommendations` |
| `approve_action` | `POST /voice/incidents/{incident_id}/approve` | Confirm and execute `disable_recommendations` and start Stage 6 verification |
| `take_over` | `POST /voice/incidents/{incident_id}/take-over` | Transfer ownership to responder and halt autonomous actions |
| `check_status` | `GET /voice/incidents/{incident_id}/status` | Retrieve current incident and recovery verification status |

---

# Legacy Retell responder agent setup

Configure a Retell voice agent with the following prompt and custom functions. Keep the CREAO investigator and Retell voice agent separate: CREAO investigates; this agent reads and relays the shared incident record and waits for the responder's decision.

## Prompt

You are SecondShift, the phone interface for an incident-response system. The current incident context is provided in `{{incident_briefing}}`; its identifier is `{{incident_id}}`. Investigation may still be in progress.

Start by reading the briefing plainly. Never say that a service is recovered unless `get_incident_status` reports `recovered`. An answered phone call is not an acknowledgement or an approval.

Use `get_incident_briefing` for the exact current proposal and action identifiers. Use `get_incident_evidence` when asked to explain evidence, and `check_dependency` for a fresh read-only health check. If the responder asks what happened after an action, use `get_incident_status`.

Only call `acknowledge_incident` after the responder explicitly acknowledges the incident. Only call `take_over_incident` after the responder explicitly says they will handle it; this halts further autonomous actions.

For an operational action, read the exact pending action and tradeoff to the responder. Ask for an explicit yes/no on that specific action and environment. If they approve, ask for the separate responder PIN without repeating it aloud, then call `approve_incident_action` with that action's numeric ID and the PIN. Never infer approval from silence, an acknowledgement, a request for evidence, or an answer to a different question. If the responder explicitly declines, call `decline_incident_action` with that action's numeric ID and report that no action was taken.

Use concise spoken language. If evidence is missing, contradictory, or unavailable, say so and do not invent a cause, confidence percentage, or recovery. If a tool fails, explain the failure and direct the responder to the dashboard.

## Custom functions

Set the function request method to `POST`, leave **Payload: args only** off so the signed `call` context is included, and configure:

- `Authorization: Bearer <VOICE_TOOL_TOKEN>`
- `Content-Type: application/json`
- HTTPS URLs under `https://<PUBLIC_URL>/voice/...`

Retell supplies a signed request body containing `call.call_id`; the backend checks its signature and requires that call to match an answered call registered for the incident. Do not ask the model to supply or guess a call ID.

| Function | URL | Arguments |
|---|---|---|
| `get_incident_briefing` | `/voice/briefing` | `{}` |
| `get_incident_evidence` | `/voice/evidence` | `{}` |
| `get_incident_status` | `/voice/status` | `{}` |
| `check_dependency` | `/voice/probe` | `{"dependency":"recommendations"}` or `{"dependency":"payments"}` |
| `acknowledge_incident` | `/voice/acknowledge` | `{}` |
| `approve_incident_action` | `/voice/approve` | `{"action_id":123,"pin":"<spoken privately by the responder>"}` |
| `decline_incident_action` | `/voice/decline` | `{"action_id":123}` |
| `take_over_incident` | `/voice/take-over` | `{}` |

Configure the Retell agent webhook URL as `https://<PUBLIC_URL>/retell-webhook`. Enable `call_started`, `call_ended`, and `call_analyzed` events. Use a Retell API key that can verify webhooks. The backend accepts only signed requests with timestamps no older than five minutes.

## Telephony checklist

Before setting `PHONE_AUTO_NOTIFY=true`, confirm the Photon account has a supported voice-capable number and country, connect it to Retell using the Photon/Retell SIP instructions for that account, and set the resulting Retell-owned/imported E.164 caller ID in `RETELL_FROM_NUMBER`. Shared iMessage-only numbers are not voice numbers. Set `PRIMARY_PHONE` and `BACKUP_PHONE` to enrolled participants in E.164 format. The system attempts the primary once, then escalates to the backup once after a no-answer or provider failure.

The backend's create-call request uses Retell's documented `/v2/create-phone-call` API. A live Photon test call still requires the account-side SIP/number configuration and cannot be inferred from these environment variables.
