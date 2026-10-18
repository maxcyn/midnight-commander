import { db } from "./db.js";

export const METRICS_LABEL = "Controlled demo measurements: one synthetic checkout service, injected faults, seconds-long thresholds. Not a production reliability claim.";

const average = (values: number[]) => values.length ? Math.round(values.reduce((sum, value) => sum + value, 0) / values.length) : null;
const durations = (pairs: [string | null, string][]) => pairs.flatMap(([end, start]) => {
  const ms = end ? Date.parse(end) - Date.parse(start) : NaN;
  return Number.isFinite(ms) && ms >= 0 ? [ms] : [];
});
const count = (sql: string) => (db.prepare(sql).get() as { count: number }).count;

export function computeMetrics() {
  const incidents = db.prepare(
    `SELECT i.opened_at, i.recovered_at, i.alert_count,
       (SELECT t.at FROM timeline_events t WHERE t.incident_id = i.id AND t.action = 'acknowledged' ORDER BY t.id LIMIT 1) AS acknowledged_at
     FROM incidents i`,
  ).all() as { opened_at: string; recovered_at: string | null; acknowledged_at: string | null; alert_count: number }[];

  // Correct runbook selections and refusals come from the latest evaluated version's labelled cases.
  const latest = db.prepare(`SELECT runbook_id, version, evaluation FROM runbook_versions WHERE evaluation IS NOT NULL ORDER BY id DESC LIMIT 1`)
    .get() as { runbook_id: string; version: number; evaluation: string } | undefined;
  const cases = latest ? JSON.parse(latest.evaluation) as { expected: boolean; passed: boolean; suite?: string }[] : [];
  const tally = (expected: boolean) => ({
    correct: cases.filter((c) => c.expected === expected && c.passed).length,
    total: cases.filter((c) => c.expected === expected).length,
  });

  return {
    label: METRICS_LABEL,
    averageAlertToAcknowledgementMs: average(durations(incidents.map((i) => [i.acknowledged_at, i.opened_at]))),
    averageAlertToVerifiedRecoveryMs: average(durations(incidents.map((i) => [i.recovered_at, i.opened_at]))),
    humanActionDecisions: count(`SELECT COUNT(*) AS count FROM timeline_events WHERE action IN ('action_approved','action_declined')`),
    authorisedRunbookExecutions: count(`SELECT COUNT(*) AS count FROM action_executions WHERE actor LIKE 'runbook:%'`),
    runbookEvaluation: latest && {
      runbook: `${latest.runbook_id} v${latest.version}`,
      correctSelections: tally(true),
      correctRefusals: tally(false),
      heldOutPassed: cases.filter((c) => c.suite === "held_out" && c.passed).length,
      heldOutTotal: cases.filter((c) => c.suite === "held_out").length,
    },
    // Live runs where an authorised runbook was proposed but fresh checks said it did not apply.
    liveRunbookRefusals: count(`SELECT COUNT(*) AS count FROM timeline_events WHERE action = 'runbook_not_applicable'`),
    // An action that changed nothing (flag was already off) or never restored service was not needed or did not work.
    // Learning loop: declines recorded with a reason, and proposals that consulted an earlier decision.
    declinedProposals: count(`SELECT COUNT(*) AS count FROM decision_feedback WHERE decision = 'declined'`),
    declinesWithReason: count(`SELECT COUNT(*) AS count FROM decision_feedback WHERE decision = 'declined' AND reason IS NOT NULL`),
    investigationsThatConsultedADecision: count(`SELECT COUNT(*) AS count FROM timeline_events WHERE action = 'past_decisions_consulted'`),
    unnecessaryActions: count(`SELECT COUNT(*) AS count FROM action_executions WHERE json_extract(result, '$.changed') = 0`),
    unsuccessfulActions: count(`SELECT COUNT(*) AS count FROM action_executions WHERE status IN ('failed','verification_incomplete')`),
    repeatAlertsAttached: incidents.reduce((sum, i) => sum + Math.max(0, i.alert_count - 1), 0),
    webhookRetriesSuppressed: count(`SELECT COALESCE(SUM(retry_count), 0) AS count FROM webhook_retries`),
  };
}
