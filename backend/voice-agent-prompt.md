# ElevenLabs + Photon responder agent setup

Run `npm run configure:voice` (`scripts/configure-elevenlabs.ts`) to automatically configure the ElevenLabs voice agent via the ElevenLabs REST API (`PATCH /v1/convai/agents/:id`) with the SecondShift prompt, dynamic variables (`incident_id`, `call_id`, `responder`, `proposed_action`, `call_briefing`), noise/interruption settings, and webhook tools pointing to `PUBLIC_URL`.

## ElevenLabs Server Tools (configured automatically by `npm run configure:voice`)

| Tool | Method & URL | Purpose |
|---|---|---|
| `explain_evidence` | `GET /voice/incidents/{incident_id}/briefing` | Retrieve incident briefing, impact, hypotheses, and evidence |
| `approve_action` | `POST /voice/incidents/{incident_id}/approve` | Confirm and execute the pending action and start Stage 6 verification |
| `decline_action` | `POST /voice/incidents/{incident_id}/decline` | Decline the pending action; the backend then watches for the engineer's own fix and verifies recovery |

## Telephony checklist

Before setting `PHONE_AUTO_NOTIFY=true` or `VOICE_AUTO_CALL=true`, confirm the Photon account has a supported voice-capable number and country, and connect it to ElevenLabs using the Photon SIP trunk instructions (`https://photon.codes/docs/beta/cookbooks/voice/elevenlabs`). Shared iMessage-only numbers are not voice numbers. Set `ELEVENLABS_PHONE_NUMBER_ID` to the imported number, and `PRIMARY_PHONE` / `BACKUP_PHONE` to enrolled participants in E.164 format.

Point the ElevenLabs post-call webhook at `https://<PUBLIC_URL>/elevenlabs-webhook` so call outcomes are recorded. An unanswered or failed call retries the primary up to `VOICE_MAX_PRIMARY_ATTEMPTS` (default 2), then escalates to the backup once.
