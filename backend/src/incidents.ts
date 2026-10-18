import { db } from "./db.js";

export type Status = "open" | "investigating" | "awaiting_decision" | "mitigating" | "verifying" | "recovered";

// Forward path, plus going back to awaiting_decision / investigating when something fails.
const TRANSITIONS: Record<Status, Status[]> = {
  open: ["investigating", "awaiting_decision"],
  investigating: ["awaiting_decision", "mitigating"],
  awaiting_decision: ["investigating", "mitigating"],
  mitigating: ["verifying", "awaiting_decision"],
  verifying: ["recovered", "awaiting_decision", "mitigating"],
  recovered: [],
};

const now = () => new Date().toISOString();

export function addTimeline(incidentId: number, actor: string, action: string, detail?: unknown, result = "ok") {
  db.prepare(`INSERT INTO timeline_events (incident_id, at, actor, action, result, detail) VALUES (?,?,?,?,?,?)`)
    .run(incidentId, now(), actor, action, result, detail === undefined ? null : JSON.stringify(detail));
}

function touch(id: number) {
  db.prepare(`UPDATE incidents SET updated_at = ? WHERE id = ?`).run(now(), id);
}

export function addEvidence(incidentId: number, source: string, sourceId: string, observedAt: string, content: unknown) {
  db.prepare(`INSERT OR IGNORE INTO evidence (incident_id, source, source_id, observed_at, content) VALUES (?,?,?,?,?)`)
    .run(incidentId, source, sourceId, observedAt, JSON.stringify(content));
}

// ---- Alert intake --------------------------------------------------------
export interface ParsedAlert {
  sentryIssueId: string;
  environment: string;
  title: string;
  eventId: string;
  observedAt: string;
  service: string;
  runId?: string;
  raw: unknown;
}

// Sentry's webhook shape varies by alert type; read the fields defensively.
export function parseSentryAlert(body: any): ParsedAlert | null {
  const ev = body?.data?.event ?? body?.data?.issue ?? {};
  const issueId = ev.issue_id ?? body?.data?.issue?.id ?? ev.groupID;
  if (issueId === undefined || issueId === null) return null;
  const tags: unknown[] = Array.isArray(ev.tags) ? ev.tags : [];
  const tag = (key: string) => {
    const row = tags.find((item: any) => Array.isArray(item) ? item[0] === key : item?.key === key);
    return Array.isArray(row) ? row[1] : (row as any)?.value;
  };
  return {
    sentryIssueId: String(issueId),
    environment: String(ev.environment ?? tag("environment") ?? "unknown"),
    title: String(ev.title ?? body?.data?.issue?.title ?? "Sentry alert"),
    eventId: String(ev.event_id ?? ev.id ?? `no-event-${Date.now()}`),
    observedAt: String(ev.datetime ?? ev.timestamp ?? now()),
    service: tag("service") ?? "checkout",
    runId: tag("run_id") ? String(tag("run_id")) : undefined,
    raw: body,
  };
}

export interface AlertOutcome {
  outcome: "duplicate_delivery" | "attached" | "opened" | "opened_linked_to_previous";
  incidentId?: number;
}

export function processAlert(deliveryId: string, alert: ParsedAlert): AlertOutcome {
  db.exec("BEGIN IMMEDIATE");
  try {
    // 1. Webhook retry: the same delivery is processed exactly once.
    const seen = db.prepare(`INSERT OR IGNORE INTO webhook_deliveries (delivery_id, received_at) VALUES (?,?)`)
      .run(deliveryId, now());
    if (seen.changes === 0) {
      db.exec("COMMIT");
      return { outcome: "duplicate_delivery" };
    }

    // 2. Repeated symptom: same Sentry issue + environment attaches to the active incident.
    const active = db.prepare(
      `SELECT id FROM incidents WHERE sentry_issue_id = ? AND environment = ? AND status != 'recovered' ORDER BY id DESC LIMIT 1`,
    ).get(alert.sentryIssueId, alert.environment) as { id: number } | undefined;

    let result: AlertOutcome;
    if (active) {
      db.prepare(`UPDATE incidents SET alert_count = alert_count + 1, updated_at = ?, run_id = COALESCE(run_id, ?) WHERE id = ?`)
        .run(now(), alert.runId ?? null, active.id);
      addEvidence(active.id, "sentry.alert", alert.eventId, alert.observedAt, { title: alert.title, deliveryId, run_id: alert.runId });
      addTimeline(active.id, "sentry", "recurring_alert_attached", { eventId: alert.eventId, deliveryId });
      result = { outcome: "attached", incidentId: active.id };
    } else {
      // 3. New incident. A recurrence after recovery is new, but linked to its predecessor.
      const prev = db.prepare(
        `SELECT id FROM incidents WHERE sentry_issue_id = ? AND environment = ? AND status = 'recovered' ORDER BY id DESC LIMIT 1`,
      ).get(alert.sentryIssueId, alert.environment) as { id: number } | undefined;
      const svc = db.prepare(`SELECT * FROM services WHERE name = ?`).get(alert.service) as any
        ?? db.prepare(`SELECT * FROM services WHERE name = 'checkout'`).get() as any;
      const info = db.prepare(
        `INSERT INTO incidents (service, environment, title, sentry_issue_id, run_id, previous_incident_id, owner, opened_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      ).run(svc.name, alert.environment, alert.title, alert.sentryIssueId, alert.runId ?? null, prev?.id ?? null, svc.primary_responder, now(), now());
      const id = Number(info.lastInsertRowid);
      addEvidence(id, "sentry.alert", alert.eventId, alert.observedAt, { title: alert.title, deliveryId, run_id: alert.runId });
      addTimeline(id, "sentry", "incident_opened", { title: alert.title, previousIncident: prev?.id ?? null });
      addTimeline(id, "system", "owner_assigned", { owner: svc.primary_responder, backup: svc.backup_responder });
      result = { outcome: prev ? "opened_linked_to_previous" : "opened", incidentId: id };
    }
    db.prepare(`UPDATE webhook_deliveries SET incident_id = ? WHERE delivery_id = ?`).run(result.incidentId ?? null, deliveryId);
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

// ---- State changes -------------------------------------------------------
export function getIncident(id: number) {
  return db.prepare(`SELECT * FROM incidents WHERE id = ?`).get(id) as any | undefined;
}

export function transition(id: number, to: Status, actor: string, detail?: unknown) {
  const inc = getIncident(id);
  if (!inc) throw new Error(`incident ${id} not found`);
  if (!TRANSITIONS[inc.status as Status].includes(to)) {
    throw new Error(`cannot move incident ${id} from ${inc.status} to ${to}`);
  }
  db.prepare(`UPDATE incidents SET status = ?, updated_at = ?, recovered_at = ? WHERE id = ?`)
    .run(to, now(), to === "recovered" ? now() : inc.recovered_at, id);
  addTimeline(id, actor, `status_${to}`, detail);
}

export function acknowledge(id: number, by: string) {
  const inc = getIncident(id);
  if (!inc) throw new Error(`incident ${id} not found`);
  if (!isConfiguredResponder(inc, by)) throw new Error(`${by} is not an authorised responder for incident ${id}`);
  if (inc.ack_state === "acknowledged") return; // idempotent
  db.prepare(`UPDATE incidents SET ack_state = 'acknowledged', acknowledged_by = ? WHERE id = ?`).run(by, id);
  touch(id);
  addTimeline(id, by, "acknowledged");
}

export function escalate(id: number, reason: string) {
  const inc = getIncident(id);
  if (!inc) throw new Error(`incident ${id} not found`);
  const svc = db.prepare(`SELECT backup_responder FROM services WHERE name = ?`).get(inc.service) as any;
  db.prepare(`UPDATE incidents SET escalation_state = 'escalated_to_backup', updated_at = ? WHERE id = ?`).run(now(), id);
  // Escalation changes who is told, never the incident status.
  addTimeline(id, "system", "escalated", { to: svc.backup_responder, reason });
}

// "I'll handle it": the human takes ownership and the system stops acting on its own.
export function takeOver(id: number, by: string) {
  const inc = getIncident(id);
  if (!inc) throw new Error(`incident ${id} not found`);
  if (!isConfiguredResponder(inc, by)) throw new Error(`${by} is not an authorised responder for incident ${id}`);
  db.prepare(`UPDATE incidents SET owner = ?, autonomy = 'halted', updated_at = ? WHERE id = ?`).run(by, now(), id);
  addTimeline(id, by, "took_over", { autonomy: "halted" });
}

function isConfiguredResponder(incident: any, person: string) {
  const primary = process.env.PRIMARY_RESPONDER ?? "primary-engineer";
  const backup = process.env.BACKUP_RESPONDER ?? "backup-engineer";
  return person === primary || (person === backup &&
    (incident.owner === backup || incident.escalation_state === "escalated_to_backup"));
}

export function listIncidents() {
  return db.prepare(`SELECT * FROM incidents ORDER BY id DESC`).all();
}

export function incidentDetail(id: number) {
  const incident = getIncident(id);
  if (!incident) return undefined;
  return {
    incident,
    evidence: db.prepare(`SELECT * FROM evidence WHERE incident_id = ? ORDER BY observed_at`).all(id),
    timeline: db.prepare(`SELECT * FROM timeline_events WHERE incident_id = ? ORDER BY id`).all(id),
    proposedActions: db.prepare(`SELECT * FROM proposed_actions WHERE incident_id = ? ORDER BY id`).all(id),
    investigations: db.prepare(`SELECT id, run_id, status, started_at, finished_at, result, decision FROM investigations WHERE incident_id = ? ORDER BY id`).all(id),
    phoneCalls: db.prepare(`SELECT id, responder, phone_number, status, briefing, created_at, updated_at, outcome FROM phone_calls WHERE incident_id = ? ORDER BY id`).all(id),
    calls: db.prepare(`SELECT * FROM calls WHERE incident_id = ? ORDER BY id`).all(id),
    executions: db.prepare(`SELECT * FROM action_executions WHERE incident_id = ? ORDER BY id`).all(id),
    retrospective: db.prepare(`SELECT * FROM retrospectives WHERE incident_id = ?`).get(id) ?? null,
    decisions: db.prepare(`SELECT * FROM decision_feedback WHERE incident_id = ? ORDER BY id`).all(id),
  };
}
