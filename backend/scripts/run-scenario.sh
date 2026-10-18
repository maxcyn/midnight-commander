#!/usr/bin/env bash
# Usage: scripts/run-scenario.sh recommendation|payment|provider
# Breaks the demo app, opens an incident, waits for the CREAO investigation, prints the outcome.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; source .env; source ../demo-app/.env; set +a

scenario="${1:-}"
case "$scenario" in
  recommendation) faults='{"recommendation":true,"payment":false}';;
  payment)        faults='{"recommendation":false,"payment":true}';;
  provider)       faults='{"recommendation":false,"payment":false,"providerDegradation":true}';;
  *) echo "usage: $0 recommendation|payment|provider"; exit 1;;
esac
debug=(-H "Authorization: Bearer ${DEBUG_TOKEN}" -H 'content-type: application/json')
dashboard=(-H "Authorization: Bearer ${DASHBOARD_TOKEN}" -H "X-Responder: ${PRIMARY_RESPONDER:-primary-engineer}")
dev=(-H "Authorization: Bearer ${DEV_TOKEN}" -H 'content-type: application/json')

echo "1. Reset demo app and inject the '$scenario' fault"
curl -s -X POST localhost:4000/dev/reset "${dev[@]}" >/dev/null
curl -s -X POST localhost:4000/dev/faults "${dev[@]}" -d "$faults" >/dev/null

echo "2. Let failures reach Sentry (30s)"
sleep 30

echo "3. Open an incident (what a Sentry alert would do)"
issue="test-$scenario-$(date +%s)"
run_id=$(curl -s -H "Authorization: Bearer ${PROBE_TOKEN}" "localhost:4000/requests?limit=1000" | python3 -c "import sys,json; rows=json.load(sys.stdin); ids=[r.get('runId') for r in rows if r.get('runId') and r.get('runId') != 'none']; print(ids[-1] if ids else '')")
if [ -z "$run_id" ]; then echo "no synthetic run_id found; start synthetic traffic before running this scenario"; exit 1; fi
id=$(curl -s -X POST localhost:3000/debug/alert "${debug[@]}" -d "{\"issue_id\":\"$issue\",\"run_id\":\"$run_id\"}" | python3 -c "import sys,json;print(json.load(sys.stdin)['incidentId'])")
echo "   incident #$id"

echo "4. Waiting for CREAO to investigate (up to 4 min)"
for i in $(seq 1 48); do
  status=$(curl -s "${dashboard[@]}" "localhost:3000/dashboard-api/incidents/$id" | python3 -c "import sys,json;print(json.load(sys.stdin)['incident']['status'])")
  [ "$status" != "investigating" ] && [ "$status" != "open" ] && break
  sleep 5
done

curl -s "${dashboard[@]}" "localhost:3000/dashboard-api/incidents/$id" | python3 -c "
import sys,json
d=json.load(sys.stdin); i=d['incident']
print(f\"\n=== Incident #{i['id']}: status={i['status']} owner={i['owner']} ===\")
for t in d['timeline']:
    det=json.loads(t['detail']) if t['detail'] else {}
    extra=''
    if t['action']=='investigation_submitted': extra=f\"  hypotheses={det.get('hypotheses')} agent_recommendation={det.get('recommendation')}\"
    elif t['action'].startswith('decision_'): extra=f\"  reasons={det.get('reasons')}\"
    elif t['action']=='action_proposed': extra=f\"  {det.get('action')} -> {det.get('environment')}\"
    print(f\"  {t['at'][11:19]} {t['actor']:7} {t['action']} [{t['result']}]{extra}\")
print('proposed actions:', [(a['action'],a['approval_state']) for a in d['proposedActions']] or 'none')
"
echo
echo "Reset when done: POST http://localhost:4000/dev/reset with DEV_TOKEN."
