// Stage 5 checks: voice briefing, tool operations, approval binding, bounded retry & backup escalation.
import { db } from "./db.js";
import { addEvidence, getIncident, incidentDetail, parseSentryAlert, processAlert, takeOver, transition } from "./incidents.js";
import { submitInvestigation } from "./investigation.js";
import {
  approveProposedAction,
  getVoiceBriefing,
  initiateCall,
  notifyResponder,
  recordCallOutcome,
  voiceDeclineAction,
} from "./voice.js";

process.env.FIX_WATCH_INTERVAL_MS = "3600000"; // no background fix-watching during unit tests
let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  " + detail}`);
  if (!cond) failures++;
}

const openIncident = (delivery: string, issueId: string, title = "Error: recommendation lookup timed out after 800ms") => {
  const alert = parseSentryAlert({
    data: { event: { issue_id: issueId, title, event_id: `ev-${delivery}`, environment: "demo", tags: [["service", "checkout"]] } },
  })!;
  const out = processAlert(delivery, alert);
  const id = out.incidentId!;
  transition(id, "investigating", "system");
  db.prepare(`INSERT INTO investigations (incident_id, started_at, status) VALUES (?, ?, 'running')`).run(id, new Date().toISOString());
  return id;
};

// ---- 1. Investigation submission prepares briefing & initiates call ------
const inc1 = openIncident("v-d1", "v-101");
const nowIso = new Date().toISOString();
addEvidence(inc1, "sentry.error", "err-1", nowIso, { title: "504 timeout" });
addEvidence(inc1, "demo.probe", "probe-pay-1", nowIso, { healthy: true, latencyMs: 60 });

const sub = submitInvestigation({
  incident_id: inc1,
  impact: { summary: "100% of checkouts failing with 504 at recommendations", measured_from: ["err-1"] },
  hypotheses: [
    {
      cause: "recommendations_timeout",
      status: "supported",
      supporting_evidence: [{ source: "sentry.error", source_id: "err-1", observed_at: nowIso, note: "504 timeout" }],
    },
    {
      cause: "payment_failure",
      status: "contradicted",
      conflicting_evidence: [{ source: "demo.probe", source_id: "probe-pay-1", observed_at: nowIso, note: "healthy 60ms" }],
    },
  ],
  missing_information: [],
  applicable_runbook: null,
  proposed_action: { action: "disable_recommendations", target_environment: "demo", expected_tradeoff: "no product suggestions" },
  recommendation: "request_engineer_decision",
  call_briefing: "Checkout requests are failing. Recommendation timeouts are the leading cause. I propose disabling recommendations; purchases could continue without product suggestions.",
});

check("investigation submission succeeds and proposes action", sub.accepted && sub.applied && !!sub.proposedActionId, JSON.stringify(sub));
let detail1 = incidentDetail(inc1)!;
check("call is initiated from the incident record", detail1.calls.length === 1 && detail1.calls[0].outcome === "initiated", JSON.stringify(detail1.calls));
check("briefing includes incident id and options", detail1.calls[0].briefing.includes(`incident ${inc1}`) && detail1.calls[0].briefing.includes("Recommendation timeouts"));

// ---- 2. Answering or acknowledging a call is NOT approval ----------------
const briefing = getVoiceBriefing(inc1);
detail1 = incidentDetail(inc1)!;
const pendingAction = () => detail1.proposedActions[0];
check("explain_evidence marks call answered and returns hypotheses", detail1.calls[0].outcome === "answered" && briefing.hypotheses.length === 2);
check("answering call does NOT approve the pending action", pendingAction().approval_state === "pending" && getIncident(inc1).status === "awaiting_decision");

await recordCallOutcome(detail1.calls[0].id, "acknowledged");
detail1 = incidentDetail(inc1)!;
check("acknowledging call acknowledges incident but does NOT approve action", getIncident(inc1).ack_state === "acknowledged" && pendingAction().approval_state === "pending");

// ---- 3. Duplicate error events do NOT trigger repeated calls -------------
processAlert("v-d2", parseSentryAlert({ data: { event: { issue_id: "v-101", title: "Error", event_id: "ev-2", environment: "demo" } } })!);
const dupCall = await initiateCall(inc1);
check("active call suppresses duplicate call attempts", dupCall.skipped === true && incidentDetail(inc1)!.calls.length === 1);

// ---- 4. Bound operational approval checks --------------------------------
let r = approveProposedAction({ incidentId: inc1, action: "disable_recommendations", responder: "random-stranger", confirmed: true });
check("unenrolled caller cannot approve", !r.approved && r.reason.includes("not an enrolled responder"), JSON.stringify(r));

r = approveProposedAction({ incidentId: inc1, action: "disable_recommendations", responder: "primary-engineer", confirmed: false });
check("unconfirmed call cannot approve", !r.approved && r.reason.includes("explicit confirmation"), JSON.stringify(r));

r = approveProposedAction({ incidentId: inc1, action: "restart_database", responder: "primary-engineer", confirmed: true });
check("wrong action name cannot approve", !r.approved && r.reason.includes("disable_recommendations"), JSON.stringify(r));

process.env.VOICE_APPROVAL_CODE = "4321";
r = approveProposedAction({ incidentId: inc1, action: "disable_recommendations", responder: "primary-engineer", confirmed: true, verificationCode: "0000" });
check("wrong verification code is rejected", !r.approved && r.reason.includes("verification code"), JSON.stringify(r));

r = approveProposedAction({ incidentId: inc1, action: "disable_recommendations", responder: "primary-engineer", confirmed: true, verificationCode: "4321" });
delete process.env.VOICE_APPROVAL_CODE;
check("enrolled + confirmed + verified approval succeeds and moves to mitigating", r.approved && getIncident(inc1).status === "mitigating", JSON.stringify(r));
detail1 = incidentDetail(inc1)!;
check("call outcome and proposed_action state are marked approved", detail1.calls[0].outcome === "approved" && detail1.proposedActions[0].approval_state === "approved");

// ---- 5. Unanswered call bounded retry -> backup escalation ---------------
const inc2 = openIncident("v-d3", "v-202");
transition(inc2, "awaiting_decision", "system");
await initiateCall(inc2, { live: false });
let calls2 = incidentDetail(inc2)!.calls;
check("incident 2 starts with primary attempt 1", calls2.length === 1 && calls2[0].responder === "primary-engineer" && calls2[0].attempt === 1);

await recordCallOutcome(calls2[0].id, "unanswered");
calls2 = incidentDetail(inc2)!.calls;
check("first unanswered call retries primary (attempt 2)", calls2.length === 2 && calls2[1].responder === "primary-engineer" && calls2[1].attempt === 2);

await recordCallOutcome(calls2[1].id, "unanswered");
calls2 = incidentDetail(inc2)!.calls;
check(
  "second unanswered call escalates to backup responder",
  calls2.length === 3 && calls2[2].responder === "backup-engineer" && getIncident(inc2).escalation_state === "escalated_to_backup",
  JSON.stringify(calls2),
);

// ---- 5b. Calls are de-duplicated per responder; notifying needs a valid number ----
const incB = openIncident("v-d5", "v-404");
transition(incB, "awaiting_decision", "system");
await initiateCall(incB, { responder: "primary-engineer", live: false });
const backupCall = await initiateCall(incB, { responder: "backup-engineer", live: false });
check("an active primary call does not suppress a call to the backup", backupCall.skipped === false && incidentDetail(incB)!.calls.length === 2);
const savedBackupPhone = process.env.BACKUP_PHONE;
delete process.env.BACKUP_PHONE;
check("notifying without a configured number is refused", (() => { try { void notifyResponder(incB, "backup"); return false; } catch { return true; } })());
process.env.BACKUP_PHONE = "12345";
check("notifying a non-E.164 number is refused", (() => { try { void notifyResponder(incB, "backup"); return false; } catch { return true; } })());
if (savedBackupPhone === undefined) delete process.env.BACKUP_PHONE; else process.env.BACKUP_PHONE = savedBackupPhone;

// ---- 6. Declining by voice -----------------------------------------------
const inc3 = openIncident("v-d4", "v-303");
transition(inc3, "awaiting_decision", "system");
const act3 = Number(db.prepare(`INSERT INTO proposed_actions (incident_id, action, target_environment, parameters, expires_at, created_at) VALUES (?,?,?,?,?,?)`)
  .run(inc3, "disable_recommendations", "demo", "{}", new Date(Date.now() + 600_000).toISOString(), new Date().toISOString()).lastInsertRowid);
check("unenrolled caller cannot decline", (() => { try { voiceDeclineAction({ incidentId: inc3, responder: "random-stranger" }); return false; } catch { return true; } })() && incidentDetail(inc3)!.proposedActions[0].approval_state === "pending");
check("declining the wrong action name is refused", (() => { try { voiceDeclineAction({ incidentId: inc3, responder: "primary-engineer", action: "switch_payment_provider" }); return false; } catch { return true; } })());
const dec = voiceDeclineAction({ incidentId: inc3, responder: "primary-engineer", action: "disable_recommendations" });
check("decline needs no reason, changes nothing, and says so", dec.declined && /nothing was changed/.test(dec.spokenSummary) && incidentDetail(inc3)!.proposedActions[0].approval_state === "rejected" && getIncident(inc3).status === "awaiting_decision");
check("declining records a lesson with no reason", (db.prepare(`SELECT reason, action FROM decision_feedback WHERE incident_id = ?`).get(inc3) as any)?.reason === null);
check("declining twice is refused (nothing pending)", (() => { try { voiceDeclineAction({ incidentId: inc3, responder: "primary-engineer" }); return false; } catch { return true; } })());
check("declining is not approval", incidentDetail(inc3)!.timeline.some((t: any) => t.action === "action_declined") && !incidentDetail(inc3)!.timeline.some((t: any) => t.action === "action_approved"));

// ---- 7. Dashboard take-over halts autonomous calls -----------------------
takeOver(inc2, "backup-engineer");
check("take-over halts autonomy and transfers ownership to backup", getIncident(inc2).autonomy === "halted" && getIncident(inc2).owner === "backup-engineer");
const afterTakeoverCall = await initiateCall(inc2, { live: false });
check("no new autonomous calls after human take-over", afterTakeoverCall.skipped === true);

console.log(failures === 0 ? "\nAll Stage 5 voice checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
