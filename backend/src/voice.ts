import { db } from "./db.js";
import { acknowledge, addEvidence, addTimeline, escalate, getIncident, takeOver, transition } from "./incidents.js";
import { declineAction } from "./workflows.js";

export type CallOutcome = "initiated" | "answered" | "acknowledged" | "approved" | "failed" | "unanswered";

const now = () => new Date().toISOString();
const MAX_PRIMARY_ATTEMPTS = Number(process.env.VOICE_MAX_PRIMARY_ATTEMPTS ?? 2);

function getService(serviceName: string) {
  return (
    (db.prepare(`SELECT * FROM services WHERE name = ?`).get(serviceName) as any) ??
    (db.prepare(`SELECT * FROM services WHERE name = 'checkout'`).get() as any)
  );
}

function phoneForResponder(serviceName: string, responder: string): string {
  const svc = getService(serviceName);
  if (responder === svc?.backup_responder) return process.env.BACKUP_PHONE ?? "+10000000002";
  return process.env.PRIMARY_PHONE ?? "+10000000001";
}

export function isEnrolledResponder(serviceName: string, responder: string): boolean {
  const svc = getService(serviceName);
  if (!svc) return false;
  return responder === svc.primary_responder || responder === svc.backup_responder;
}

export function buildBriefing(incidentId: number) {
  const inc = getIncident(incidentId);
  if (!inc) throw new Error(`incident ${incidentId} not found`);

  const inv = db
    .prepare(`SELECT * FROM investigations WHERE incident_id = ? ORDER BY id DESC LIMIT 1`)
    .get(incidentId) as any | undefined;
  const pendingAction = db
    .prepare(`SELECT * FROM proposed_actions WHERE incident_id = ? AND approval_state = 'pending' ORDER BY id DESC LIMIT 1`)
    .get(incidentId) as any | undefined;

  const parsedResult = inv?.result ? JSON.parse(inv.result) : null;
  let briefing: string;
  if (parsedResult?.call_briefing) {
    const base = String(parsedResult.call_briefing).trim();
    const prefix = base.toLowerCase().startsWith("secondshift") ? "" : `SecondShift here about incident ${incidentId}. `;
    const suffix = pendingAction
      ? " Would you like the evidence, approve this action, or take over?"
      : " Would you like the evidence, check a dependency, or take over?";
    briefing = `${prefix}${base}${base.endsWith("?") ? "" : suffix}`;
  } else {
    briefing = `SecondShift here about incident ${incidentId} on ${inc.service} (${inc.environment}). ${inc.title}. Automated diagnosis did not finish in time, so no changes were made. Would you like me to check payments or recommendations live, or will you take over?`;
  }

  return {
    incidentId,
    briefing,
    proposedAction: pendingAction
      ? {
          id: pendingAction.id,
          action: pendingAction.action,
          targetEnvironment: pendingAction.target_environment,
          expiresAt: pendingAction.expires_at,
        }
      : null,
    investigation: parsedResult,
  };
}

export interface InitiateCallOptions {
  responder?: string;
  attempt?: number;
  live?: boolean;
}

export async function initiateCall(incidentId: number, opts: InitiateCallOptions = {}) {
  const inc = getIncident(incidentId);
  if (!inc) throw new Error(`incident ${incidentId} not found`);
  if (inc.status === "recovered") return { skipped: true as const, reason: "incident already recovered" };
  if (inc.autonomy === "halted") return { skipped: true as const, reason: "human has taken over (autonomy halted)" };

  const svc = getService(inc.service);
  const responder = opts.responder ?? inc.owner ?? svc.primary_responder;
  const attempt = opts.attempt ?? 1;

  const shouldDialLive = opts.live ?? process.env.VOICE_AUTO_CALL === "true";

  const activeCall = db
    .prepare(
      `SELECT * FROM calls WHERE incident_id = ? AND outcome IN ('initiated', 'answered', 'acknowledged', 'approved') ORDER BY id DESC LIMIT 1`,
    )
    .get(incidentId) as any | undefined;
  if (activeCall) {
    // If an un-dialed (dry-run) call record already exists and caller now requests a live dial, dial it now.
    if (shouldDialLive && !activeCall.conversation_id && activeCall.outcome === "initiated") {
      try {
        const { briefing, proposedAction } = buildBriefing(incidentId);
        const dial = await dialElevenLabs({
          callId: activeCall.id,
          incidentId,
          responder: activeCall.responder,
          toNumber: activeCall.phone_number,
          briefing,
          proposedAction: proposedAction?.action ?? "none",
        });
        db.prepare(`UPDATE calls SET conversation_id = ?, sip_call_id = ?, updated_at = ? WHERE id = ?`).run(
          dial.conversation_id ?? null,
          dial.sip_call_id ?? null,
          now(),
          activeCall.id,
        );
        addTimeline(incidentId, "system", "call_dialed_live", {
          callId: activeCall.id,
          conversationId: dial.conversation_id,
          sipCallId: dial.sip_call_id,
        });
        return { skipped: false as const, call: getCall(activeCall.id) };
      } catch (err) {
        addTimeline(incidentId, "system", "call_dial_failed", { callId: activeCall.id, error: String(err) }, "error");
        await recordCallOutcome(activeCall.id, "failed", { error: String(err), live: true });
        return { skipped: false as const, call: getCall(activeCall.id) };
      }
    }
    return { skipped: true as const, reason: "call already active or handled", call: activeCall };
  }

  const { briefing, proposedAction } = buildBriefing(incidentId);
  const phone = phoneForResponder(inc.service, responder);
  const ts = now();

  const info = db
    .prepare(
      `INSERT INTO calls (incident_id, responder, phone_number, attempt, outcome, briefing, proposed_action_id, started_at, updated_at)
       VALUES (?, ?, ?, ?, 'initiated', ?, ?, ?, ?)`,
    )
    .run(incidentId, responder, phone, attempt, briefing, proposedAction?.id ?? null, ts, ts);
  const callId = Number(info.lastInsertRowid);
  db.prepare(
    `INSERT INTO phone_calls (incident_id, responder, phone_number, status, briefing, created_at, updated_at)
     VALUES (?, ?, ?, 'initiated', ?, ?, ?)`,
  ).run(incidentId, responder, phone, briefing, ts, ts);

  addTimeline(incidentId, "system", "call_initiated", {
    callId,
    responder,
    attempt,
    proposedActionId: proposedAction?.id ?? null,
  });

  if (shouldDialLive) {
    try {
      const dial = await dialElevenLabs({
        callId,
        incidentId,
        responder,
        toNumber: phone,
        briefing,
        proposedAction: proposedAction?.action ?? "none",
      });
      db.prepare(`UPDATE calls SET conversation_id = ?, sip_call_id = ?, updated_at = ? WHERE id = ?`).run(
        dial.conversation_id ?? null,
        dial.sip_call_id ?? null,
        now(),
        callId,
      );
      db.prepare(`UPDATE phone_calls SET retell_call_id = ?, updated_at = ? WHERE incident_id = ? AND responder = ?`).run(
        dial.conversation_id ?? null,
        now(),
        incidentId,
        responder,
      );
    } catch (err) {
      addTimeline(incidentId, "system", "call_dial_failed", { callId, error: String(err) }, "error");
      await recordCallOutcome(callId, "failed", { error: String(err), live: shouldDialLive });
      return { skipped: false as const, call: getCall(callId) };
    }
  }

  return { skipped: false as const, call: getCall(callId) };
}

async function dialElevenLabs(params: {
  callId: number;
  incidentId: number;
  responder: string;
  toNumber: string;
  briefing: string;
  proposedAction: string;
}) {
  const apiKey = process.env.ELEVENLABS_API_KEY;
  const agentId = process.env.ELEVENLABS_AGENT_ID;
  const phoneNumberId = process.env.ELEVENLABS_PHONE_NUMBER_ID;
  if (!apiKey || !agentId || !phoneNumberId) {
    throw new Error("ELEVENLABS_API_KEY, ELEVENLABS_AGENT_ID, and ELEVENLABS_PHONE_NUMBER_ID must be set");
  }

  const res = await fetch("https://api.elevenlabs.io/v1/convai/sip-trunk/outbound-call", {
    method: "POST",
    headers: {
      "xi-api-key": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      agent_id: agentId,
      agent_phone_number_id: phoneNumberId,
      to_number: params.toNumber,
      conversation_initiation_client_data: {
        dynamic_variables: {
          incident_id: String(params.incidentId),
          call_id: String(params.callId),
          responder: params.responder,
          proposed_action: params.proposedAction,
          call_briefing: params.briefing,
        },
        conversation_config_override: {
          agent: {
            first_message: params.briefing,
          },
        },
      },
    }),
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, any>;
  if (!res.ok || body.success === false) {
    throw new Error(`ElevenLabs outbound-call ${res.status}: ${JSON.stringify(body)}`);
  }
  return body as { success: boolean; message: string; conversation_id: string | null; sip_call_id: string | null };
}

export function getCall(callId: number) {
  return db.prepare(`SELECT * FROM calls WHERE id = ?`).get(callId) as any | undefined;
}

export function getLatestCallForIncident(incidentId: number) {
  return db.prepare(`SELECT * FROM calls WHERE incident_id = ? ORDER BY id DESC LIMIT 1`).get(incidentId) as any | undefined;
}

function markCallAnsweredIfInitiated(incidentId: number) {
  const call = getLatestCallForIncident(incidentId);
  if (call && call.outcome === "initiated") {
    db.prepare(`UPDATE calls SET outcome = 'answered', updated_at = ? WHERE id = ?`).run(now(), call.id);
    db.prepare(`UPDATE phone_calls SET status = 'answered', updated_at = ? WHERE incident_id = ? AND status = 'initiated'`).run(now(), incidentId);
    addTimeline(incidentId, call.responder, "call_answered", { callId: call.id });
  }
}

export async function recordCallOutcome(
  callId: number,
  outcome: CallOutcome,
  detail?: { error?: string; reason?: string; live?: boolean },
) {
  const call = getCall(callId);
  if (!call) throw new Error(`call ${callId} not found`);

  const ended = ["approved", "failed", "unanswered"].includes(outcome) ? now() : call.ended_at;
  db.prepare(`UPDATE calls SET outcome = ?, updated_at = ?, ended_at = ? WHERE id = ?`).run(outcome, now(), ended, callId);
  db.prepare(`UPDATE phone_calls SET status = ?, outcome = ?, updated_at = ? WHERE incident_id = ? AND responder = ?`).run(
    outcome,
    detail?.reason ?? detail?.error ?? null,
    now(),
    call.incident_id,
    call.responder,
  );
  addTimeline(
    call.incident_id,
    call.responder,
    `call_${outcome}`,
    { callId, attempt: call.attempt, ...(detail ?? {}) },
    outcome === "failed" || outcome === "unanswered" ? "degraded" : "ok",
  );

  if (outcome === "acknowledged") {
    acknowledge(call.incident_id, call.responder);
  }

  // Bounded retry + backup escalation when a call is unanswered or fails.
  if (outcome === "unanswered" || outcome === "failed") {
    const inc = getIncident(call.incident_id);
    if (!inc || inc.status === "recovered" || inc.autonomy === "halted") return getCall(callId);
    const svc = getService(inc.service);

    if (call.responder === svc.primary_responder && call.attempt < MAX_PRIMARY_ATTEMPTS) {
      await initiateCall(call.incident_id, {
        responder: svc.primary_responder,
        attempt: call.attempt + 1,
        live: detail?.live ?? false,
      });
    } else if (call.responder === svc.primary_responder) {
      escalate(call.incident_id, `primary responder ${outcome} after ${call.attempt} attempt(s)`);
      await initiateCall(call.incident_id, {
        responder: svc.backup_responder,
        attempt: 1,
        live: detail?.live ?? false,
      });
    } else {
      addTimeline(call.incident_id, "system", "backup_responder_unreachable", { callId, responder: call.responder }, "error");
    }
  }

  return getCall(callId);
}

// ---- Voice agent operations (Stage 5 table in plan.md) -------------------

// 1. "Explain the evidence" -> Retrieve the incident briefing & evidence
export function getVoiceBriefing(incidentId: number) {
  markCallAnsweredIfInitiated(incidentId);
  const inc = getIncident(incidentId);
  if (!inc) throw new Error(`incident ${incidentId} not found`);
  const b = buildBriefing(incidentId);
  const evidence = db.prepare(`SELECT source, source_id, observed_at, content FROM evidence WHERE incident_id = ? ORDER BY observed_at`).all(incidentId) as any[];
  return {
    incidentId: inc.id,
    status: inc.status,
    service: inc.service,
    environment: inc.environment,
    owner: inc.owner,
    ackState: inc.ack_state,
    briefing: b.briefing,
    proposedAction: b.proposedAction,
    impact: b.investigation?.impact ?? null,
    hypotheses: b.investigation?.hypotheses ?? [],
    missingInformation: b.investigation?.missing_information ?? [],
    evidence: evidence.map((e) => ({
      source: e.source,
      sourceId: e.source_id,
      observedAt: e.observed_at,
      content: JSON.parse(e.content),
    })),
  };
}

// 2. "Check payments" -> Request a read-only live dependency check
export async function runVoiceProbe(
  incidentId: number,
  dependency: "recommendations" | "payments",
  fetcher?: (dep: "recommendations" | "payments") => Promise<{ healthy: boolean; latencyMs: number; error?: string; at?: string }>,
) {
  markCallAnsweredIfInitiated(incidentId);
  const inc = getIncident(incidentId);
  if (!inc) throw new Error(`incident ${incidentId} not found`);
  if (!["recommendations", "payments"].includes(dependency)) {
    throw new Error("dependency must be recommendations or payments");
  }

  const defaultFetcher = async (dep: "recommendations" | "payments") => {
    const base = process.env.DEMO_APP_URL ?? "http://localhost:4000";
    const r = await fetch(`${base}/probe/${dep}`, {
      headers: { Authorization: `Bearer ${process.env.DEMO_PROBE_TOKEN}` },
    });
    if (!r.ok) throw new Error(`probe HTTP ${r.status}`);
    return (await r.json()) as { healthy: boolean; latencyMs: number; error?: string; at?: string };
  };

  const probeResult = await (fetcher ?? defaultFetcher)(dependency);
  const observedAt = probeResult.at ?? now();
  addEvidence(incidentId, `voice.probe.${dependency}`, `probe-${Date.now()}`, observedAt, probeResult);
  addTimeline(incidentId, "voice-agent", `probe_${dependency}`, probeResult, probeResult.healthy ? "ok" : "degraded");

  return {
    incidentId,
    dependency,
    healthy: probeResult.healthy,
    latencyMs: probeResult.latencyMs,
    error: probeResult.error ?? null,
    observedAt,
    spokenSummary: probeResult.healthy
      ? `Live check: ${dependency} is healthy (${probeResult.latencyMs}ms).`
      : `Live check: ${dependency} is failing (${probeResult.error ?? "unhealthy"}, ${probeResult.latencyMs}ms).`,
  };
}

// 3. "Disable recommendations" -> Confirm the specific pending action
export interface ApprovalInput {
  incidentId: number;
  action: string;
  responder: string;
  confirmed?: boolean;
  verificationCode?: string;
}

export function approveProposedAction(input: ApprovalInput) {
  markCallAnsweredIfInitiated(input.incidentId);
  const inc = getIncident(input.incidentId);
  if (!inc) throw new Error(`incident ${input.incidentId} not found`);

  if (inc.autonomy === "halted") {
    return { approved: false as const, reason: "autonomous actions are halted because a responder took over" };
  }
  if (inc.status !== "awaiting_decision") {
    return { approved: false as const, reason: `incident is in status '${inc.status}', not 'awaiting_decision'` };
  }
  if (!isEnrolledResponder(inc.service, input.responder)) {
    return { approved: false as const, reason: `responder '${input.responder}' is not an enrolled responder for ${inc.service}` };
  }
  if (input.confirmed !== true) {
    return { approved: false as const, reason: "explicit confirmation (confirmed=true) is required before approving an operational action" };
  }

  const requiredCode = process.env.VOICE_APPROVAL_CODE;
  if (requiredCode && input.verificationCode !== requiredCode) {
    addTimeline(input.incidentId, input.responder, "approval_verification_failed", { action: input.action }, "error");
    return { approved: false as const, reason: "verification code did not match" };
  }

  const pending = db
    .prepare(`SELECT * FROM proposed_actions WHERE incident_id = ? AND approval_state = 'pending' ORDER BY id DESC LIMIT 1`)
    .get(input.incidentId) as any | undefined;
  if (!pending) {
    return { approved: false as const, reason: "no pending proposed action for this incident" };
  }
  if (pending.action !== input.action) {
    return { approved: false as const, reason: `pending action is '${pending.action}', not '${input.action}'` };
  }
  if (Date.parse(pending.expires_at) <= Date.now()) {
    db.prepare(`UPDATE proposed_actions SET approval_state = 'expired' WHERE id = ?`).run(pending.id);
    addTimeline(input.incidentId, "system", "proposed_action_expired", { actionId: pending.id, action: pending.action }, "degraded");
    return { approved: false as const, reason: "proposed action has expired" };
  }

  db.prepare(`UPDATE proposed_actions SET approval_state = 'approved', approved_by = ? WHERE id = ?`).run(input.responder, pending.id);
  acknowledge(input.incidentId, input.responder);

  const call = getLatestCallForIncident(input.incidentId);
  if (call) {
    db.prepare(`UPDATE calls SET outcome = 'approved', updated_at = ?, ended_at = ? WHERE id = ?`).run(now(), now(), call.id);
    db.prepare(`UPDATE phone_calls SET status = 'approved', outcome = ?, updated_at = ? WHERE incident_id = ?`).run(
      `approved ${pending.action}`,
      now(),
      input.incidentId,
    );
  }

  addTimeline(input.incidentId, input.responder, "action_approved", {
    actionId: pending.id,
    action: pending.action,
    targetEnvironment: pending.target_environment,
  });
  transition(input.incidentId, "mitigating", input.responder, { actionId: pending.id, action: pending.action });

  return {
    approved: true as const,
    actionId: pending.id,
    action: pending.action,
    targetEnvironment: pending.target_environment,
    incidentStatus: "mitigating",
    spokenSummary: `Approved ${pending.action} for incident ${input.incidentId} in ${pending.target_environment}. Executing mitigation now.`,
  };
}

// 4. "I'll handle it" -> Transfer control and stop new autonomous actions
// "No, don't do that": decline the pending proposal. No reason is needed; the backend snapshots the incident's own
// evidence and then watches for the engineer's fix, so the engineer only has to make the change.
export function voiceDeclineAction(input: { incidentId: number; responder: string; action?: string; reason?: string }) {
  markCallAnsweredIfInitiated(input.incidentId);
  const inc = getIncident(input.incidentId);
  if (!inc) throw new Error(`incident ${input.incidentId} not found`);
  if (!isEnrolledResponder(inc.service, input.responder)) {
    throw new Error(`responder '${input.responder}' is not an enrolled responder for ${inc.service}`);
  }
  const pending = db
    .prepare(`SELECT id, action FROM proposed_actions WHERE incident_id = ? AND approval_state = 'pending' ORDER BY id DESC LIMIT 1`)
    .get(input.incidentId) as { id: number; action: string } | undefined;
  if (!pending) throw new Error("no pending proposed action for this incident");
  if (input.action && pending.action !== input.action) throw new Error(`pending action is '${pending.action}', not '${input.action}'`);

  acknowledge(input.incidentId, input.responder);
  const out = declineAction(input.incidentId, pending.id, input.responder, input.reason);
  const call = getLatestCallForIncident(input.incidentId);
  if (call && call.outcome !== "approved") {
    db.prepare(`UPDATE calls SET outcome = 'acknowledged', updated_at = ?, ended_at = ? WHERE id = ?`).run(now(), now(), call.id);
  }
  return {
    declined: true as const,
    actionId: pending.id,
    action: pending.action,
    status: out.status,
    spokenSummary: `Understood. I will not run ${pending.action.replaceAll("_", " ")}; nothing was changed. Make your fix and I will verify recovery.`,
  };
}

export function voiceTakeOver(incidentId: number, responder: string) {
  markCallAnsweredIfInitiated(incidentId);
  const inc = getIncident(incidentId);
  if (!inc) throw new Error(`incident ${incidentId} not found`);
  if (!isEnrolledResponder(inc.service, responder)) {
    throw new Error(`responder '${responder}' is not an enrolled responder for ${inc.service}`);
  }

  db.prepare(`UPDATE proposed_actions SET approval_state = 'cancelled_by_takeover' WHERE incident_id = ? AND approval_state = 'pending'`).run(incidentId);
  acknowledge(incidentId, responder);
  takeOver(incidentId, responder);

  const call = getLatestCallForIncident(incidentId);
  if (call && call.outcome !== "approved") {
    db.prepare(`UPDATE calls SET outcome = 'acknowledged', updated_at = ?, ended_at = ? WHERE id = ?`).run(now(), now(), call.id);
  }

  return {
    ok: true as const,
    incidentId,
    owner: responder,
    autonomy: "halted",
    spokenSummary: `Understood. Ownership of incident ${incidentId} is transferred to ${responder} and autonomous actions are halted.`,
  };
}

// 5. "Did it work?" -> Retrieve verification status
export function getVoiceStatus(incidentId: number) {
  markCallAnsweredIfInitiated(incidentId);
  const inc = getIncident(incidentId);
  if (!inc) throw new Error(`incident ${incidentId} not found`);
  const latestAction = db
    .prepare(`SELECT * FROM proposed_actions WHERE incident_id = ? ORDER BY id DESC LIMIT 1`)
    .get(incidentId) as any | undefined;
  const recentTimeline = db
    .prepare(`SELECT at, actor, action, result, detail FROM timeline_events WHERE incident_id = ? ORDER BY id DESC LIMIT 5`)
    .all(incidentId) as any[];

  let spokenSummary = `Incident ${incidentId} is currently ${inc.status}.`;
  if (inc.status === "recovered") {
    spokenSummary = `Incident ${incidentId} has recovered at ${inc.recovered_at}. Checkout requests are succeeding.`;
  } else if (inc.status === "verifying") {
    spokenSummary = `Mitigation was applied for incident ${incidentId}; verification checks and telemetry confirmation are currently in progress.`;
  } else if (inc.status === "mitigating") {
    spokenSummary = `Mitigation (${latestAction?.action ?? "action"}) is currently being executed for incident ${incidentId}.`;
  } else if (inc.status === "awaiting_decision") {
    spokenSummary = latestAction && latestAction.approval_state === "pending"
      ? `Incident ${incidentId} is awaiting your decision on ${latestAction.action}.`
      : `Incident ${incidentId} is awaiting engineer action.`;
  }

  return {
    incidentId: inc.id,
    status: inc.status,
    ackState: inc.ack_state,
    acknowledgedBy: inc.acknowledged_by,
    escalationState: inc.escalation_state,
    owner: inc.owner,
    autonomy: inc.autonomy,
    recoveredAt: inc.recovered_at,
    latestAction: latestAction
      ? { id: latestAction.id, action: latestAction.action, approvalState: latestAction.approval_state, approvedBy: latestAction.approved_by }
      : null,
    recentTimeline: recentTimeline.map((t) => ({
      at: t.at,
      actor: t.actor,
      action: t.action,
      result: t.result,
      detail: t.detail ? JSON.parse(t.detail) : null,
    })),
    spokenSummary,
  };
}
