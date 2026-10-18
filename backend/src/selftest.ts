// Stage 3 checks, run against an in-memory database (DB_PATH=:memory:).
import { acknowledge, escalate, getIncident, incidentDetail, listIncidents, parseSentryAlert, processAlert, takeOver, transition } from "./incidents.js";

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  " + detail}`);
  if (!cond) failures++;
}
const alertBody = (issueId: string, title: string, eventId: string, env = "demo") => ({
  action: "triggered",
  data: { event: { issue_id: issueId, title, event_id: eventId, environment: env, tags: [["service", "checkout"]] } },
});
const send = (delivery: string, issueId: string, title: string, eventId: string) =>
  processAlert(delivery, parseSentryAlert(alertBody(issueId, title, eventId))!);

const REC = "Error: recommendation lookup timed out after 800ms";
const PAY = "Error: payment provider declined the charge";

let o = send("d1", "101", REC, "e1");
check("first alert opens an incident", o.outcome === "opened" && o.incidentId === 1, JSON.stringify(o));
check("incident has a named responder", getIncident(1).owner === "primary-engineer");

o = send("d1", "101", REC, "e1");
check("webhook retry is processed once", o.outcome === "duplicate_delivery" && listIncidents().length === 1);

o = send("d2", "101", REC, "e2");
send("d3", "101", REC, "e3");
check("repeated symptoms attach to the active incident", o.outcome === "attached" && listIncidents().length === 1 && getIncident(1).alert_count === 3);

o = send("d4", "202", PAY, "e4");
check("unrelated error is NOT merged, even if simultaneous", o.outcome === "opened" && o.incidentId === 2 && listIncidents().length === 2);

check("one coherent timeline per incident", incidentDetail(1)!.timeline.map((t: any) => t.action).join(",") ===
  "incident_opened,owner_assigned,recurring_alert_attached,recurring_alert_attached");

acknowledge(1, "primary-engineer");
acknowledge(1, "primary-engineer");
check("acknowledge is idempotent (one timeline entry)", incidentDetail(1)!.timeline.filter((t: any) => t.action === "acknowledged").length === 1);

escalate(1, "no answer");
check("escalated does not mean recovered", getIncident(1).escalation_state === "escalated_to_backup" && getIncident(1).status === "open");

let threw = false;
try { transition(1, "recovered", "test"); } catch { threw = true; }
check("cannot jump straight to recovered", threw && getIncident(1).status === "open");

for (const s of ["investigating", "awaiting_decision", "mitigating", "verifying", "recovered"] as const) transition(1, s, "test");
check("incident walks open -> recovered", getIncident(1).status === "recovered" && !!getIncident(1).recovered_at);

o = send("d5", "101", REC, "e5");
check("recurrence after recovery is a NEW incident linked to its predecessor",
  o.outcome === "opened_linked_to_previous" && getIncident(o.incidentId!).previous_incident_id === 1, JSON.stringify(o));
check("recovered incident is left untouched", getIncident(1).alert_count === 3);

takeOver(3, "primary-engineer");
check("take-over halts autonomous actions", getIncident(3).autonomy === "halted" && getIncident(3).owner === "primary-engineer");

console.log(failures === 0 ? "\nAll Stage 3 checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
