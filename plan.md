Stage 0 — Confirm scope and unblock integrations
Product: SecondShift, a plug-and-play incident-response agent and workflow-learning platform powered by CREAO, Sentry, and Photon + ElevenLabs.
MVP: one checkout service defined via a declarative `service-manifest.json`, two failure causes (including a masked shared-pool degradation), two bounded mitigations, one primary engineer, one backup contact, and one conversational phone integration—packaged so any software project can clone the CREAO agent template, attach its own `service-manifest.json`, and plug in its `.env` keys.
Component	Responsibility
Service manifest (`service-manifest.json`)	Declares the target application's dependencies, read-only probes, supported causes, and allowlisted idempotent actions (mounted in CREAO's Files tab and enforced by the backend)
Demo application	Produces controlled failures and accepts explicit feature-flag and provider-switch mitigations
Sentry	Error detection, Logs, and Tracing
CREAO	Plug-and-play investigation agent (reads `service-manifest.json` + backend tools), runbook selection, and decline-feedback learning
Backend	Manifest-driven incident state, permissions, action execution, evaluation, and verification
Photon + ElevenLabs	Telephone connection and spoken interaction (auto-provisioned via `npm run configure:voice`)
Database + dashboard	Shared incident history, evidence, decisions, and evaluation results


Before substantial development, run three integration checks:
1. Sentry: ingest an error, a structured log, and a trace; retrieve evidence programmatically.
2. CREAO: trigger a saved agent and make it call a harmless backend tool.
3. Photon: make a real test call through ElevenLabs.
CREAO documents reusable agents and connected-tool execution, but confirm the exact API Trigger interface and custom-tool setup in your hackathon account. Don’t build around an assumed endpoint. CREAO
Photon’s documented ElevenLabs SIP setup (https://photon.codes/docs/beta/cookbooks/voice/elevenlabs) requires an eligible voice-capable number; shared iMessage lines do not support Voice. Confirm the receiving country is supported before choosing your demo phone. photon.codes
Done when: each integration works independently, or its specific blocker is identified.
Stage 1 — Build a reproducibly breakable application
Use a small Node.js/TypeScript service with simulated payments. The frontend only needs a basket, checkout button, and order result.
Checkout performs:
1. Basket validation.
2. Optional recommendation lookup.
3. Simulated payment.
4. Order confirmation.
Add private development controls:
Control	Effect
Recommendations enabled	Checkout calls the recommendation dependency
Recommendation fault	Dependency exceeds its timeout
Payment fault	Simulated payment fails
Reset	Returns the test environment to a known state
Provider degradation	Primary payment provider slows and saturates the connection pool it shares with the recommendation client, so recommendation lookups time out too


Intentionally let a recommendation timeout break checkout. Two mitigations exist: disabling recommendations (fixes a genuine recommendation outage) and switching to the backup payment provider (fixes provider degradation).
Build authenticated action endpoints that set an explicit target state: recommendations flag to false, payment provider to backup. Avoid “toggle” operations, which could reverse the action if retried.
Provider degradation is the hidden root cause for the learning demo: the visible errors are recommendation timeouts, and the recommendation probe also times out because of the shared pool. Disabling recommendations does not restore checkout in this case, because the payment path is still degraded. The only independent clue is an elevated payment latency reading on the read-only payment probe.
Run synthetic requests continuously, keeping request timestamps, outcomes, and latency.
Important correction: if recommendations fail before payment is reached, missing payment errors do not prove payments are healthy. Use an independent dependency probe if the agent needs that evidence.
Keep the responder backend separate from the faulty application. Fault-injection settings are visible to the test runner, not the investigating agent.
Done when: recommendations can break checkout, disabling them restores checkout, the same action does not repair a payment failure, and switching providers restores checkout under provider degradation where disabling recommendations does not.
Stage 2 — Add real Sentry observability
Instrument actual requests and failures rather than uploading fabricated incident summaries.
Signal	Implementation	Purpose
Errors	Capture failed checkout exceptions	Alert trigger
Traces	Checkout span with recommendation and payment spans	Locate failed or slow execution
Structured logs	Dependency outcomes, feature changes, mitigation outcomes	Explain context and actions
Attributes	Service, environment, release, request ID, opaque run ID	Correlate and isolate evidence


Use complete trace sampling for this small controlled demo, subject to quota. Explicitly enable structured Logs; ordinary console output should not be assumed to appear in Sentry.
Build a backend adapter that queries Sentry and returns evidence with timestamps and source identifiers. Sentry documents Explore queries for logs and spans, plus trace retrieval; validate the available fields and permissions in your account. Sentry Docs
Configure an alert action webhook. Your endpoint should validate the delivery, save it, acknowledge promptly, and queue processing.
Done when: a real synthetic failure triggers the backend and the agent can retrieve the associated logs and trace.
Stage 3 — Build the incident record and ownership layer
Borrow Rootly’s idea of one shared incident record, but keep implementation small.
Store:
Record	Essential contents
Service	Name, dependencies, primary responder, backup responder
Incident	Service, environment, status, severity, timestamps
Evidence	Source, observation time, content/reference
Timeline event	Actor, action, timestamp, result
Proposed action	Exact target, parameters, expiry, approval state
Runbook version	Conditions, operation, verification, evaluation results
Decision feedback	Incident, action, approve or decline, engineer's stated reason, the diagnosis the system gave, and what actually fixed it


Start with a manually configured owner and backup. A complete rotation calendar is unnecessary.
Handle two different duplication problems:
- Webhook retry: process the same delivery once.
- Repeated symptoms: attach recurring events from the same Sentry issue and environment to an active incident instead of calling repeatedly.
Do not merge unrelated errors merely because they occur close together. A new recurrence after recovery gets a new incident linked to its predecessor.
Use incident states such as:
open → investigating → awaiting_decision → mitigating → verifying → recovered
Track acknowledgement, escalation, and ownership separately. “Escalated” does not mean the service has recovered.
Done when: repeated alerts produce one active incident and one coherent timeline, with a named responder.
Stage 4 — Implement evidence-based CREAO investigation (Plug-and-Play Manifest)
Define the target service's architecture declaratively in `service-manifest.json` (also attached in CREAO's **Files** tab and served at `GET /tools/service_manifest`) so the CREAO agent template is reusable across any software project without rewriting backend policy code.
Give CREAO narrowly defined tools:
- Retrieve the service manifest (`/tools/service_manifest` or attached `service-manifest.json` in CREAO Files).
- Retrieve Sentry evidence (`/tools/sentry_evidence`).
- Read legitimate feature configuration and recent changes (`/tools/feature_config`).
- Run read-only dependency probes declared in the manifest (`/tools/probe`).
- Retrieve unified past incidents, engineer decisions (both approved and declined-then-fixed), raw evidence snapshots, verified resolutions, `incidents.md`, and any pre-authorised runbooks (`/tools/past_decisions`).
- Submit a structured investigation result (`/tools/submit_investigation`).
The result should contain:
- Observed impact and its measurement source.
- Leading hypothesis.
- Supporting and conflicting evidence.
- Missing information.
- Applicable runbook, if any.
- Proposed action and expected tradeoff.
Avoid displaying invented probabilities such as “97% confident.” Use evidence-backed descriptions such as supported, inconclusive, or contradicted.
The result also states which past decisions it consulted and how they changed the proposal.
The backend—not an LLM confidence score—checks whether an action is permitted. The allowlist now holds two actions, each tied to the cause it addresses. A past decline informs the proposal but never grants permission, and a lesson cannot add an action to the allowlist.
Finding	Response
Relevant failure evidence, but no authorised runbook	Request an engineer’s decision
Tested, authorised runbook with satisfied conditions	Permit its bounded operation
Missing or contradictory evidence	Escalate without changing the app
Investigation exceeds its time budget	Contact the engineer with what is known


For urgent incidents, notification must not wait indefinitely for diagnosis. The call can say that investigation is ongoing.
Done when: CREAO distinguishes recommendation failure from payment failure without seeing the injected scenario label, and a stored decline measurably changes its next proposal for matching evidence.
Risk to test early: on a first provider-degradation incident the agent may find the payment latency clue unaided and propose the right action. The “wrong first” incident depends on the evidence genuinely pointing at recommendations, so run it before building the rest and adjust what the probe exposes if needed. Do not script a wrong answer.
Stage 5 — Add the Photon phone interaction
Use Photon 2.0 + ElevenLabs, following the documented SIP integration. ElevenLabs handles the spoken conversation; Photon connects it to the phone network. photon.codes
Prepare a short briefing before calling:
“SecondShift here about incident 104. Checkout requests are failing. Recommendation timeouts are the leading cause. I propose disabling recommendations; purchases could continue without product suggestions. Would you like the evidence, approve this action, or take over?”

The voice agent can:
Spoken request	Backend operation
“Explain the evidence”	Retrieve the incident briefing
“Check payments”	Request a read-only investigation
“Disable recommendations”	Confirm the specific pending action
“I’ll handle it”	Transfer control and stop new autonomous actions
“Did it work?”	Retrieve verification status


Keep CREAO as the investigator; the voice agent speaks from the same incident record.
Declining is a first-class outcome. The voice agent asks why and records the engineer's reason against the exact action, and “I’ll fix it myself” records what they did.
Record call outcomes separately: initiated, answered, acknowledged, approved, failed, or unanswered. Answering a call is not approval. Bind any approval to the exact action, incident, authorised responder, and expiry. For the demo, use an enrolled participant and a simple verification step before accepting an operational approval.
If unanswered, follow a bounded retry policy and notify the configured backup. Do not repeatedly call for every error event.
Done when: the engineer can understand, approve or decline, and obtain status without opening Slack.
Stage 6 — Execute mitigation and verify recovery
The backend performs the action only after checking:
- Current incident state.
- Approval or pre-authorised runbook scope.
- Fresh applicability evidence.
- Exact target environment.
- Whether the operation already executed.
Record the previous flag or provider value and the action result. Allow only one active mutation per incident. The switch-provider action has its own applicability checks: elevated payment latency is confirmed now, the primary provider is still selected, and the backup is reachable.
Verification combines:
1. Synthetic checkout results.
2. Correct order-confirmation behaviour.
3. Fresh Sentry telemetry.
4. A defined observation window.
For example, a demo-specific recovery rule could require ten successful synthetic checkouts across at least 30 seconds, plus matching successful post-action traces. This is a demonstration threshold, not a production reliability guarantee.
If Sentry data is delayed, display “functional checks passed; telemetry confirmation pending.” Silence or absent errors alone is insufficient.
If mitigation fails, stop and escalate. Do not repeatedly retry the same ineffective action or automatically re-enable a known failing dependency.
Done when: success is supported by measured results, and failed mitigation never becomes a false “resolved” incident.
Stage 7 — Unified Incident Memory (`decision_feedback` + `incidents.md`) and Pre-Authorised Runbooks
Every verified incident resolution—whether the engineer **approved** the proposed action OR **declined** it and fixed the application themselves—is recorded into the unified `decision_feedback` store and automatically synced to `backend/incidents.md` with:
- Incident evidence snapshot (raw dependency probe latencies, configuration, and failing stage).
- What was proposed and whether the engineer approved or declined it.
- What action actually restored service, recorded only after Stage 6 recovery verification passes.
When a new incident occurs, CREAO calls `/tools/past_decisions` to check if a similar incident happened before:
- If a matching incident exists and its runbook is **authorised** (pre-approved for automation), the backend verifies fresh probes and executes the action automatically.
- If a matching incident exists and is **not** pre-authorised for automation, CREAO proposes that same verified fix and calls the engineer on the phone to approve it.
- If no matching incident exists, CREAO evaluates the fresh evidence from first principles, proposes a bounded mitigation, and calls the engineer.
Use a lifecycle for automated runbooks:
draft → evaluated → authorised → suspended
Passing tests and permission to run automatically are separate decisions. Approval of one incident does not authorise all future executions.
Evaluate both the applicability decision and the resulting action:
Test	Required behaviour
Recommendation timeout	Select procedure; restore checkout
Matching recurrence with different IDs	Still select correctly
Payment failure only	Reject procedure
Both dependencies failing	Do not claim full recovery; escalate unresolved failure
Missing or stale evidence	Abstain
Feature already disabled	Recognise no further mitigation from the same action
Action rejected or ineffective	Record failure and escalate
Provider degradation with recommendation timeouts	Reject the disable-recommendations procedure; select the provider switch
Past decline for the same evidence pattern	Do not re-propose the declined action


A learned lesson is also versioned and evaluated before it influences proposals. It must not suppress the correct action for a genuine recommendation outage, so the recommendation-timeout case is re-run against it. Lessons can be suspended like runbooks.
Use isolated test instances and credentials. Evaluation events must not trigger live paging.
Keep fixed tests and held-out variations that the generating agent cannot rewrite. Otherwise the system could produce a procedure and conveniently weak tests for itself.
Done when: the dashboard shows a generated runbook, its evidence, and measured pass/fail results—including refusal cases.
Stage 8 — Add the retrospective and readable dashboard
Borrow the useful coordination features without building a full Rootly replacement:
- Incident overview: impact, owner, acknowledgement, current status.
- Evidence panel: linked logs, traces, competing explanations.
- Timeline: alerts, investigation, calls, approval, action, verification.
- Runbook panel: version, scope, authorisation, evaluation results.
- Lessons panel: declined actions, the stated reason, and which later proposals consulted them.
- Retrospective: what happened, what restored service, unresolved work.
Generate a follow-up item for the permanent fix—for example, making checkout tolerate recommendation outages.
Label the outcome accurately: “Checkout recovered; recommendations remain disabled.” This is mitigation, not a repaired recommendation service.
Log your own agent/tool failures in Sentry too. Show at least one genuine example of observability helping you improve the hack itself, such as a duplicate webhook causing duplicate work that you diagnosed and fixed.
Done when: a reviewer can reconstruct why the system acted and what remains broken.
Stage 9 — Validate and present the complete story
The demo is one scenario run twice: the same masked provider degradation, before and after the system has learned from a refusal.
Step	What it shows
Healthy baseline	The app genuinely works before injection
Incident 1	Real Sentry evidence points at recommendation timeouts; with no lesson, the system proposes disabling recommendations
Engineer declines	The engineer refuses by phone and says why (payment provider degradation, shared pool); the reason is stored against the action
Engineer fixes it	The engineer handles it, and the system records what was done
Incident 2	The same masked pattern returns; the system consults the stored decline, proposes the provider switch, and does not re-propose the declined action
Approval and verification	The engineer approves, the backend switches providers, and recovery is measured
Show the two incidents side by side: the first proposal was wrong and was refused, the second was right because of that refusal.

Measure:
- Wrong proposals in incident 1 versus incident 2.
- Time from alert to a correct proposal.
- Whether the lesson was consulted, and which decline it came from.
- Alert-to-verified-recovery time for incident 2.
- Unnecessary actions (expected: none, since the declined action never ran).
Label all results as controlled demo measurements.
Scope priority: finish the real failure → Sentry → CREAO → phone approval → verified recovery path first. Then the decline-feedback loop and the second action, since the demo depends on them. Package the service definition in `service-manifest.json` so the CREAO agent and ElevenLabs voice setup (`npm run configure:voice`) are plug-and-play for any application. Runbook generation and evaluation are optional for this demo. Add dashboard polish last.
Defer full scheduling, multi-party conference calls, automatic code deployment, broad infrastructure actions, and multi-channel support.
Final positioning: SecondShift combines familiar incident-management essentials with a focused, plug-and-play experiment: can any engineering team clone a CREAO investigator template, drop in a `service-manifest.json` of read-only probes and bounded mitigations, and turn human interventions—including refusals—into tested, verified incident response over a live phone call? That is the claim your implementation and demo should prove.