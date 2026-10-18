// Usage: npm run demo-report [-- out.md]
// Builds the Stage 9 write-up from what is actually in the database: measurements, each incident's
// timeline, runbook versions with evaluation results. Run it after a demo as the backup record.
import { writeFileSync } from "node:fs";
import { db } from "../src/db.js";
import { computeMetrics } from "../src/metrics.js";

const ms = (v: number | null) => v === null ? "not measured" : v >= 1000 ? `${(v / 1000).toFixed(1)}s` : `${v}ms`;
const m = computeMetrics();
const out: string[] = ["# SecondShift demo report", "", `> ${m.label}`, "", `Generated ${new Date().toISOString()}`, "", "## Measurements", ""];
out.push(`| Measure | Value |`, `|---|---|`,
  `| Alert to acknowledgement (average) | ${ms(m.averageAlertToAcknowledgementMs)} |`,
  `| Alert to verified recovery (average) | ${ms(m.averageAlertToVerifiedRecoveryMs)} |`,
  `| Human action decisions | ${m.humanActionDecisions} |`,
  `| Executions by an authorised runbook (no human) | ${m.authorisedRunbookExecutions} |`,
  `| Correct runbook selections (evaluation) | ${m.runbookEvaluation ? `${m.runbookEvaluation.correctSelections.correct}/${m.runbookEvaluation.correctSelections.total}` : "no runbook yet"} |`,
  `| Correct runbook refusals (evaluation) | ${m.runbookEvaluation ? `${m.runbookEvaluation.correctRefusals.correct}/${m.runbookEvaluation.correctRefusals.total}` : "no runbook yet"} |`,
  `| Held-out cases passed | ${m.runbookEvaluation ? `${m.runbookEvaluation.heldOutPassed}/${m.runbookEvaluation.heldOutTotal}` : "no runbook yet"} |`,
  `| Live runbook refusals | ${m.liveRunbookRefusals} |`,
  `| Unnecessary actions (changed nothing) | ${m.unnecessaryActions} |`,
  `| Unsuccessful actions (failed or unverified) | ${m.unsuccessfulActions} |`,
  `| Duplicate or repeat alerts attached instead of paging | ${m.repeatAlertsAttached} |`,
  `| Webhook retries suppressed | ${m.webhookRetriesSuppressed} |`, "");

out.push("## Incidents", "");
const incidents = db.prepare(`SELECT * FROM incidents ORDER BY id`).all() as any[];
if (!incidents.length) out.push("_No incidents recorded._", "");
for (const i of incidents) {
  out.push(`### Incident #${i.id}: ${i.title}`, "", `Status **${i.status}** · owner ${i.owner} · escalation ${i.escalation_state}${i.previous_incident_id ? ` · recurrence of #${i.previous_incident_id}` : ""}`, "");
  const retro = db.prepare(`SELECT * FROM retrospectives WHERE incident_id = ?`).get(i.id) as any;
  if (retro) out.push(`**Outcome:** ${retro.summary}  `, `**Still broken / follow-up:** ${retro.unresolved_work}`, "");
  else out.push(`**Outcome:** not recovered (status ${i.status}).`, "");
  out.push("| Time | Actor | Event | Result |", "|---|---|---|---|");
  for (const t of db.prepare(`SELECT * FROM timeline_events WHERE incident_id = ? ORDER BY id`).all(i.id) as any[]) {
    out.push(`| ${String(t.at).slice(11, 19)} | ${t.actor} | ${t.action} | ${t.result} |`);
  }
  out.push("");
}

out.push("## Runbooks", "");
const runbooks = db.prepare(`SELECT * FROM runbook_versions ORDER BY id`).all() as any[];
if (!runbooks.length) out.push("_No runbook generated yet._", "");
for (const r of runbooks) {
  out.push(`### ${r.runbook_id} v${r.version}: ${r.lifecycle}`, "");
  for (const e of (r.evaluation ? JSON.parse(r.evaluation) : []) as any[]) {
    out.push(`- ${e.passed ? "PASS" : "FAIL"} [${e.suite ?? "fixed"}] ${e.name} (expected ${e.expected ? "select" : "refuse"})`);
  }
  out.push("");
}
out.push("## Caveats", "",
  "- Thresholds (10 checkouts over 30s) are demonstration values, not production reliability guarantees.",
  "- Evaluation cases are fixed backend code; the runbook generator cannot edit them.",
  "- Recommendations remain disabled after recovery: this is mitigation, not a repair of the recommendation service.", "");

const file = process.argv[2];
if (file) { writeFileSync(file, out.join("\n")); console.log(`wrote ${file}`); } else console.log(out.join("\n"));
