// Stage 4 policy checks: the backend, not the model's confidence, decides what is permitted.
import { decide, validateResult, type InvestigationResult } from "./investigation.js";
import { ALLOWED_ACTIONS_MAP, DEPENDENCY_MAP, manifest } from "./manifest.js";
import { evaluateRunbookApplicability } from "./workflows.js";

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

d = decide(base({
  hypotheses: [{ cause: "payment_provider_degradation", status: "supported" }, { cause: "recommendations_timeout", status: "contradicted" }],
  proposed_action: { action: "switch_payment_provider", target_environment: "demo", expected_tradeoff: "backup provider has lower limits" },
}), false);
check("provider degradation + provider switch -> proposed for the engineer", d.final === "request_engineer_decision" && d.proposeAction, JSON.stringify(d));

d = decide(base({
  hypotheses: [{ cause: "payment_provider_degradation", status: "supported" }, { cause: "recommendations_timeout", status: "contradicted" }],
}), false);
check("provider degradation + disable_recommendations -> refused (wrong action for this cause)", d.final === "escalate_without_action" && !d.proposeAction, JSON.stringify(d));

d = decide(base({ proposed_action: { action: "switch_payment_provider", target_environment: "demo" } }), false);
check("provider switch for a recommendation outage -> refused", d.final === "escalate_without_action" && !d.proposeAction, JSON.stringify(d));

check("consulted_decisions is validated", !validateResult({ ...base(), consulted_decisions: ["one"] }).ok && validateResult({ ...base(), consulted_decisions: [1, 2] }).ok);
check("a past decision cannot grant an allowlisted action by itself", decide(base({ consulted_decisions: [1], lesson_applied: "engineer said do it", proposed_action: { action: "restart_database", target_environment: "demo" } }), false).final === "escalate_without_action");

d = decide(base({ non_blocking_unknowns: ["root cause of the recommendation timeouts is not explained"] }), false);
check("non-blocking unknowns do not stop a supported proposal", d.final === "request_engineer_decision" && d.proposeAction, JSON.stringify(d));
d = decide(base({ missing_information: ["payment probe failed"], non_blocking_unknowns: ["root cause unknown"] }), false);
check("blocking missing information still escalates without an action", d.final === "escalate_without_action" && !d.proposeAction, JSON.stringify(d));
d = decide(base({ non_blocking_unknowns: ["x"], hypotheses: [{ cause: "unknown", status: "inconclusive" }] }), false);
check("non-blocking unknowns cannot rescue an unsupported diagnosis", d.final === "escalate_without_action" && !d.proposeAction, JSON.stringify(d));
check("non_blocking_unknowns is validated", !validateResult({ ...base(), non_blocking_unknowns: [1] }).ok && validateResult({ ...base(), non_blocking_unknowns: ["a"] }).ok);

check("valid result accepted", validateResult(base()).ok === true);
const bad = validateResult({ ...base(), recommendation: "do_it_now", hypotheses: [{ cause: "dns", status: "97% sure" }] });
check("invalid enum values are rejected with reasons", !bad.ok && bad.errors.length >= 3, JSON.stringify(bad));

const recommendationCase = {
  environment: "demo",
  evidenceFresh: true,
  recommendationFailureSupported: true,
  recommendationHealthy: false,
  paymentHealthy: true,
  recommendationsEnabled: true,
  operationAllowed: true,
};
check("runbook applies when fresh evidence and independent probes agree", evaluateRunbookApplicability(recommendationCase));
check("runbook selection is independent of Sentry issue id on recurrence", evaluateRunbookApplicability({ ...recommendationCase }));
check("runbook refuses payment-only failures", !evaluateRunbookApplicability({ ...recommendationCase, recommendationFailureSupported: false, paymentHealthy: false }));
check("runbook refuses simultaneous dependency failures", !evaluateRunbookApplicability({ ...recommendationCase, paymentHealthy: false }));
check("runbook refuses stale evidence", !evaluateRunbookApplicability({ ...recommendationCase, evidenceFresh: false }));
check("runbook refuses when recommendation flag is already disabled", !evaluateRunbookApplicability({ ...recommendationCase, recommendationsEnabled: false }));
check("runbook refuses an out-of-scope environment", !evaluateRunbookApplicability({ ...recommendationCase, environment: "production" }));

check("service-manifest.json defines service, dependencies, causes, and allowed_actions",
  manifest.service === "checkout" &&
  "recommendations" in DEPENDENCY_MAP &&
  "payments" in DEPENDENCY_MAP &&
  ALLOWED_ACTIONS_MAP.disable_recommendations?.addresses === "recommendations_timeout" &&
  ALLOWED_ACTIONS_MAP.switch_payment_provider?.addresses === "payment_provider_degradation");

console.log(failures === 0 ? "\nAll Stage 4 policy checks passed" : `\n${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
