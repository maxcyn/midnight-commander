#!/usr/bin/env bash
# Usage: scripts/run-scenario.sh recommendation|payment
# Breaks the demo app, opens an incident, waits for the CREAO investigation, prints the outcome.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; source .env; source ../demo-app/.env; set +a

scenario="${1:-}"
case "$scenario" in
  recommendation) faults='{"recommendation":true,"payment":false}';;
  payment)        faults='{"recommendation":false,"payment":true}';;
  *) echo "usage: $0 recommendation|payment"; exit 1;;
esac
auth=(-H "Authorization: Bearer $TOOL_TOKEN" -H 'content-type: application/json')
dev=(-H "Authorization: Bearer $DEV_TOKEN" -H 'content-type: application/json')

echo "1. Reset demo app and inject the '$scenario' fault"
curl -s -X POST localhost:4000/dev/reset "${dev[@]}" >/dev/null
curl -s -X POST localhost:4000/dev/faults "${dev[@]}" -d "$faults" >/dev/null

echo "2. Let failures reach Sentry (30s)"
sleep 30

echo "3. Open an incident (what a Sentry alert would do)"
issue="test-$scenario-$(date +%s)"
id=$(curl -s -X POST localhost:3000/debug/alert "${auth[@]}" -d "{\"issue_id\":\"$issue\"}" | python3 -c "import sys,json;print(json.load(sys.stdin)['incidentId'])")
echo "   incident #$id"

echo "4. Waiting for CREAO to investigate (up to 4 min)"
for i in $(seq 1 48); do
  status=$(curl -s -H "Authorization: Bearer $TOOL_TOKEN" localhost:3000/incidents/$id | python3 -c "import sys,json;print(json.load(sys.stdin)['incident']['status'])")
  [ "$status" != "investigating" ] && [ "$status" != "open" ] && break
  sleep 5
done

curl -s -H "Authorization: Bearer $TOOL_TOKEN" localhost:3000/incidents/$id | python3 -c "
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
echo "Reset when done:  curl -s -X POST localhost:4000/dev/reset -H \"Authorization: Bearer \$DEV_TOKEN\""
