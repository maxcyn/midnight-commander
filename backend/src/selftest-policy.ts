// Stage 4 policy checks: the backend, not the model's confidence, decides what is permitted.
import { decide, validateResult, type InvestigationResult } from "./investigation.js";

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  " + detail}`);
  if (!cond) failures++;
}

const base = (over: Partial<InvestigationResult> = {}): InvestigationResult => ({
  incident_id: 1,
  impact: { summary: "checkout failing", measured_from: ["sentry"] },
  hypotheses: [
    { cause: "recommendations_timeout", status: "supported" },
    { cause: "payment_failure", status: "contradicted" },
  ],
  missing_information: [],
  applicable_runbook: null,
  proposed_action: { action: "disable_recommendations", target_environment: "demo", expected_tradeoff: "no suggestions" },
  recommendation: "request_engineer_decision",
  call_briefing: "Checkout is failing...",
  ...over,
});

let d = decide(base(), false);
check("evidence + no authorised runbook -> engineer decision, action proposed", d.final === "request_engineer_decision" && d.proposeAction, JSON.stringify(d));

d = decide(base({ recommendation: "permit_runbook", applicable_runbook: { id: "rb1", version: 1, preconditions_met: true } }), true);
check("authorised runbook with satisfied conditions -> permitted", d.final === "permit_runbook", JSON.stringify(d));

d = decide(base({ recommendation: "permit_runbook", applicable_runbook: { id: "rb1", version: 1, preconditions_met: true } }), false);
check("agent claims runbook but it is NOT authorised -> engineer decision", d.final === "request_engineer_decision", JSON.stringify(d));

d = decide(base({ recommendation: "permit_runbook", applicable_runbook: { id: "rb1", version: 1, preconditions_met: false } }), true);
check("authorised but preconditions not met -> engineer decision", d.final === "request_engineer_decision", JSON.stringify(d));

d = decide(base({
  hypotheses: [{ cause: "recommendations_timeout", status: "contradicted" }, { cause: "payment_failure", status: "supported" }],
}), false);
check("payment failure + recommendation action -> rejected, escalate (the counterexample)", d.final === "escalate_without_action" && !d.proposeAction, JSON.stringify(d));

d = decide(base({ hypotheses: [{ cause: "recommendations_timeout", status: "supported" }, { cause: "payment_failure", status: "supported" }] }), false);
check("both dependencies failing -> escalate, no single-mitigation claim", d.final === "escalate_without_action" && !d.proposeAction, JSON.stringify(d));

d = decide(base({ hypotheses: [{ cause: "unknown", status: "inconclusive" }], missing_information: ["no logs"], proposed_action: null }), false);
check("missing/inconclusive evidence -> escalate without changing the app", d.final === "escalate_without_action" && !d.proposeAction, JSON.stringify(d));

d = decide(base({ recommendation: "escalate_without_action" }), true);
check("never more permissive than the agent's own recommendation", d.final === "escalate_without_action", JSON.stringify(d));

d = decide(base({ proposed_action: { action: "restart_database", target_environment: "demo" } }), false);
check("action outside the allowlist is refused", d.final === "escalate_without_action" && !d.proposeAction, JSON.stringify(d));

d = decide(base({ proposed_action: null }), false);
check("supported cause but no proposable action -> engineer decides, nothing proposed", d.final === "request_engineer_decision" && !d.proposeAction, JSON.stringify(d));

check("valid result accepted", validateResult(base()).ok === true);
const bad = validateResult({ ...base(), recommendation: "do_it_now", hypotheses: [{ cause: "dns", status: "97% sure" }] });
check("invalid enum values are rejected with reasons", !bad.ok && bad.errors.length >= 3, JSON.stringify(bad));

console.log(failures === 0 ? "\nAll Stage 4 policy checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
