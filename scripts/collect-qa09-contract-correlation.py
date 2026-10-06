"""Read-only, bounded Gateway/Lambda correlation; persist only exact own IDs and safe fields."""
import datetime
import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path

source, output = map(Path, sys.argv[1:3])
raw = source.read_bytes()
receipt = json.loads(raw)
if not re.fullmatch(r'qa09-[a-f0-9]{16}', receipt.get('prefix', '')) or receipt.get('fullQa09Accepted') is not False:
    raise ValueError('OWN_RECEIPT_REQUIRED')
audit_mode = '--audit-get' in sys.argv[3:]
attempts = ([r for r in receipt['checks'] if r.get('method') == 'GET' and r.get('id', '').startswith('race:audit')] if audit_mode else receipt.get('remaining', {}).get('attempts', []))
if not attempts and not audit_mode:
    attempts = [r for r in receipt['checks'] if r.get('id', '').startswith('contract-race-')]
if not attempts:
    raise ValueError('CONTRACT_ATTEMPTS_REQUIRED')
clients = []
for attempt in attempts:
    observed = attempt.get('observation', attempt)
    request_id = observed.get('gatewayRequestId') or observed.get('clientRequestId') or attempt.get('clientRequestId')
    started = observed.get('startedAt') or attempt['startedAt']
    start_ms = int(datetime.datetime.fromisoformat(started.replace('Z', '+00:00')).timestamp() * 1000)
    clients.append({'method': observed.get('method', 'PATCH'), 'operationId': ('listAuditLogs' if observed.get('id') == 'race:audit-list' else 'getAuditLogDetail') if audit_mode else 'updateContract', 'id': attempt['id'], 'requestId': request_id, 'startedAt': started,
                    'startMs': start_ms, 'status': observed.get('status'),
                    'extendedRequestId': observed.get('gatewayExtendedRequestId'),
                    'latencyMs': observed.get('latencyMs'),
                    'responseReceived': observed.get('responseReceived', bool(observed.get('status')))})
start_ms = min(c['startMs'] for c in clients) - 2000
end_ms = max(c['startMs'] + max(c['latencyMs'] or 0, 30000) for c in clients) + 2000
ids = {c['requestId'] for c in clients if c['requestId']}
fields = {
    'gateway': ['requestId', 'extendedRequestId', 'requestTimeEpoch', 'resourcePath', 'httpMethod', 'status',
                'integrationStatus', 'functionStatus', 'integrationRequestId', 'integrationLatency',
                'responseLatency', 'errorResponseType'],
    'lambda': ['event', 'gatewayRequestId', 'gatewayExtendedRequestId', 'lambdaRequestId', 'operationId',
               'status', 'elapsedMs'],
}
rows = {}
for name, group in [('gateway', '/aws/apigateway/fdp-test-admin-api-access'),
                    ('lambda', '/aws/lambda/fdp-test-api')]:
    found, phases, error, token, pages = [], [], None, None, 0
    seen_tokens = set()
    while True:
        args = ['aws', 'logs', 'filter-log-events', '--log-group-name', group,
                '--start-time', str(start_ms), '--end-time', str(end_ms),
                '--profile', 'esgiot-readonly', '--region', 'ap-southeast-1',
                '--output', 'json', '--no-cli-pager', '--no-paginate']
        if token:
            args += ['--next-token', token]
        try:
            result = subprocess.run(args, capture_output=True, text=True, timeout=45)
        except subprocess.TimeoutExpired:
            error = 'LOG_READ_TIMEOUT'
            break
        if result.returncode:
            error = 'LOG_READ_FAILED'
            break
        page = json.loads(result.stdout)
        for event in page.get('events', []):
            message = event['message']
            try:
                value = json.loads(message[message.find('{'):])
            except (ValueError, TypeError):
                continue
            request_id = value.get('requestId') if name == 'gateway' else value.get('gatewayRequestId')
            if request_id not in ids:
                continue
            if name == 'lambda' and value.get('event') == 'data-path.phase.completed':
                phase_fields = ['gatewayRequestId', 'lambdaRequestId', 'operationId', 'phase', 'durationMs',
                                'outcome', 'errorCode', 'startedAt', 'completedAt', 'coldStart', 'includesConnectionWait']
                phases.append({k: value[k] for k in phase_fields if k in value})
            if name == 'lambda' and value.get('event') != 'admin.request.completed':
                continue
            row = {k: value[k] for k in fields[name] if k in value}
            if name == 'lambda' and isinstance(event.get('timestamp'), int):
                row['logTimestampMs'] = event['timestamp']
            found.append(row)
        pages += 1
        token = page.get('nextToken')
        if not token:
            break
        if token in seen_tokens or pages >= 20:
            error = 'LOG_PAGINATION_INCOMPLETE'
            break
        seen_tokens.add(token)
    rows[name] = {'rows': found, 'phases': phases, 'pages': pages, 'error': error}
linked = []
for client in clients:
    gateway = [g for g in rows['gateway']['rows'] if g.get('requestId') == client['requestId']]
    runtime = [l for l in rows['lambda']['rows'] if l.get('gatewayRequestId') == client['requestId']]
    exact = False
    if len(gateway) == 1 and len(runtime) == 1:
        g, l = gateway[0], runtime[0]
        exact = (g.get('extendedRequestId') == l.get('gatewayExtendedRequestId') and
                 g.get('integrationRequestId') == l.get('lambdaRequestId') and
                 str(g.get('integrationStatus')) == '200' and
                 str(g.get('functionStatus')) == str(l.get('status')) and
                 l.get('operationId') == client['operationId'] and g.get('httpMethod') == client['method'] and
                 client['startMs'] - 2000 <= int(g.get('requestTimeEpoch', 0)) <=
                 client['startMs'] + (client['latencyMs'] if client['latencyMs'] is not None else 30000) + 2000 and
                 (not client['extendedRequestId'] or g.get('extendedRequestId') == client['extendedRequestId']) and
                 (client['status'] is None or int(g.get('status', 0)) == client['status']) and
                 str(g.get('status')) == str(l.get('status')))
    linked.append({**client, 'gateway': gateway, 'lambda': runtime, 'exactLinked': exact,
                   'integrationThrottled': any(str(g.get('integrationStatus')) == '429' for g in gateway),
                   'phases': [p for p in rows['lambda']['phases'] if p.get('gatewayRequestId') == client['requestId']]})
expected_count = len(clients) if audit_mode else 6
complete = (len(linked) == expected_count and len(ids) == expected_count and expected_count > 0 and
            len({c['id'] for c in clients}) == expected_count and
            all(x['exactLinked'] and x['responseReceived'] for x in linked))
report = {'task': 'QA-09', 'scope': 'OWN_AUDIT_GET_GATEWAY_LAMBDA_REQUEST_CORRELATION' if audit_mode else 'OWN_CONTRACT_PATCH_GATEWAY_LAMBDA_REQUEST_CORRELATION',
          'collectorSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
          'sourceReceiptSha256': hashlib.sha256(raw).hexdigest(), 'sourceCommit': receipt.get('sourceCommit'),
          'prefix': receipt['prefix'], 'fullQa09Accepted': False,
          'startMs': start_ms, 'endMs': end_ms, 'records': linked,
          'logReadErrors': {k: v['error'] for k, v in rows.items() if v['error']},
          'exactLinkedCount': sum(x['exactLinked'] for x in linked),
          'missingHistoricalSiblingReceipt': not receipt.get('remaining', {}).get('attempts'),
          'gate': 'PASS' if complete and not any(v['error'] for v in rows.values()) else 'PARTIAL'}
output.write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps({k: v for k, v in report.items() if k != 'records'}))
