"""Correlate only the current probe's request IDs; never persist other requests."""
import datetime
import json
import subprocess
import sys
from pathlib import Path

EVIDENCE = Path('docs/audit/evidence/qa-09-phased-deployment-2026-10-03')
phase = sys.argv[1]
if phase not in ['observability', 'capacity', 'immediate']:
    raise ValueError('INVALID_PHASE')
probe = json.loads((EVIDENCE / f'{phase}-http-probe.json').read_text())
request_ids = {r['gatewayRequestId'] for r in probe['requests'] if r['gatewayRequestId']}
started = datetime.datetime.fromisoformat(probe['startedAt'].replace('Z', '+00:00'))
start_ms = int(started.timestamp() * 1000) - 1000
rows = {}
fields = {
    'gateway': ['requestId', 'extendedRequestId', 'requestTimeEpoch', 'resourcePath',
                'httpMethod', 'status', 'integrationStatus', 'functionStatus',
                'integrationRequestId', 'integrationLatency', 'responseLatency', 'errorResponseType'],
    'lambda': ['event', 'gatewayRequestId', 'gatewayExtendedRequestId', 'lambdaRequestId',
               'operationId', 'status', 'elapsedMs'],
}
for name, group in [('gateway', '/aws/apigateway/fdp-test-admin-api-access'),
                    ('lambda', '/aws/lambda/fdp-test-api')]:
    result = subprocess.run(
        ['aws', 'logs', 'filter-log-events', '--log-group-name', group,
         '--start-time', str(start_ms), '--profile', 'esgiot-infra',
         '--region', 'ap-southeast-1', '--output', 'json', '--no-cli-pager'],
        capture_output=True, text=True, timeout=60,
    )
    if result.returncode:
        rows[name] = {'error': 'LOG_READ_FAILED', 'rows': []}
        continue
    found = []
    for event in json.loads(result.stdout)['events']:
        message = event['message']
        try:
            value = json.loads(message[message.find('{'):])
        except (ValueError, TypeError):
            continue
        request_id = value.get('requestId') if name == 'gateway' else value.get('gatewayRequestId')
        if request_id in request_ids:
            found.append({k: value[k] for k in fields[name] if k in value})
    rows[name] = {'rows': found}
linked = []
for request in probe['requests']:
    gateway = [g for g in rows['gateway']['rows'] if g.get('requestId') == request['gatewayRequestId']]
    runtime = [l for l in rows['lambda']['rows'] if l.get('gatewayRequestId') == request['gatewayRequestId']]
    exact = (len(gateway) == 1 and len(runtime) == 1 and
             gateway[0].get('integrationRequestId') == runtime[0].get('lambdaRequestId'))
    linked.append({
        'id': request['id'], 'httpStatus': request['status'],
        'gatewayRequestId': request['gatewayRequestId'], 'gateway': gateway, 'lambda': runtime,
        'exactLambdaLinked': exact,
        'throttledAtIntegration': any(g.get('integrationStatus') == '429' for g in gateway),
    })
complete = all(r['exactLambdaLinked'] or
               (len(r['gateway']) == 1 and r['throttledAtIntegration'] and not r['lambda'])
               for r in linked)
receipt = {
    'phase': phase, 'scope': 'OWN_HTTP_GATEWAY_LAMBDA_REQUEST_CORRELATION',
    'requestCount': len(linked), 'exactLinkedCount': sum(r['exactLambdaLinked'] for r in linked),
    'logReadErrors': {k: v['error'] for k, v in rows.items() if 'error' in v},
    'records': linked, 'gate': 'PASS' if linked and complete else 'PARTIAL',
}
(EVIDENCE / f'{phase}-request-correlation.json').write_text(json.dumps(receipt, indent=2) + '\n')
print({k: v for k, v in receipt.items() if k != 'records'})
