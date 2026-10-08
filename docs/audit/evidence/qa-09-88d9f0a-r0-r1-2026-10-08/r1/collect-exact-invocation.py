"""Read-only, bounded Gateway/Lambda correlation; persist only exact own IDs and safe fields."""
import datetime
import hashlib
import json
import math
import re
import subprocess
import sys
from pathlib import Path

source, output, prior_file = map(Path, sys.argv[1:4])
raw = source.read_bytes()
receipt = json.loads(raw)
if not re.fullmatch(r'qa09-[a-f0-9]{16}', receipt.get('prefix', '')) or receipt.get('fullQa09Accepted') is not False:
    raise ValueError('OWN_RECEIPT_REQUIRED')
audit_mode = '--audit-get' in sys.argv[4:]
sampling = '--cold-sampling' in sys.argv[4:]
if any(x not in ['--audit-get', '--cold-sampling'] for x in sys.argv[4:]):
    raise ValueError('INVALID_CORRELATION_MODE')
if sampling and receipt.get('cold409Sampling', {}).get('gate') != 'PASS':
    raise ValueError('COLD_SAMPLING_BUSINESS_REQUIRED')
ledger = receipt.get('cold409Sampling' if sampling else 'remaining', {})
prefix_id = 'cold:audit' if sampling else 'race:audit'
attempts = ([r for r in receipt['checks'] if r.get('method') == 'GET' and r.get('id', '').startswith(prefix_id)] if audit_mode else ledger.get('attempts', []))
if not attempts and not audit_mode and not sampling:
    attempts = [r for r in receipt['checks'] if r.get('id', '').startswith('contract-race-')]
if not attempts:
    raise ValueError('CONTRACT_ATTEMPTS_REQUIRED')
clients = []
for attempt in attempts:
    observed = attempt.get('observation', attempt)
    request_id = observed.get('gatewayRequestId') or observed.get('clientRequestId') or attempt.get('clientRequestId')
    started = observed.get('startedAt') or attempt['startedAt']
    start_ms = int(datetime.datetime.fromisoformat(started.replace('Z', '+00:00')).timestamp() * 1000)
    clients.append({'method': observed.get('method', 'PATCH'), 'operationId': ('listAuditLogs' if (observed.get('id', '').endswith(':list') if sampling else observed.get('id') == 'race:audit-list') else 'getAuditLogDetail') if audit_mode else 'updateContract', 'id': attempt['id'], 'requestId': request_id, 'startedAt': started,
                    'startMs': start_ms, 'status': observed.get('status'),
                    'extendedRequestId': observed.get('gatewayExtendedRequestId'),
                    'latencyMs': observed.get('latencyMs'),
                    'responseReceived': observed.get('responseReceived', bool(observed.get('status'))),
                    'clientTransport': {k: v for k, v in observed.get('clientTransport', {}).items() if k in ['socketAcquisitionMs', 'dnsMs', 'tcpMs', 'tlsMs', 'requestSentAtMs', 'headersAtMs', 'responseWaitMs', 'firstBodyAtMs', 'bodyEndAtMs', 'bodyReadMs', 'jsonParseMs'] and (v is None or isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) and v >= 0)} | {'source': 'NODE_HTTPS_SOCKET_EVENTS' if observed.get('clientTransport', {}).get('source') == 'NODE_HTTPS_SOCKET_EVENTS' else 'NOT_AVAILABLE', 'reusedSocket': observed.get('clientTransport', {}).get('reusedSocket') is True}})
prior_bytes = prior_file.read_bytes()
prior = json.loads(prior_bytes)
if prior.get('sourceReceiptSha256') != hashlib.sha256(raw).hexdigest() or prior.get('prefix') != receipt['prefix'] or prior.get('sourceCommit') != receipt.get('sourceCommit'):
    raise ValueError('PRIOR_GATEWAY_BINDING_REQUIRED')
invocations = []
for c in clients:
    own = [r for r in prior['records'] if r.get('requestId') == c['requestId']]
    if len(own) != 1 or len(own[0].get('gateway', [])) != 1:
        raise ValueError('UNIQUE_GATEWAY_REQUIRED')
    g = own[0]['gateway'][0]
    if g.get('requestId') != c['requestId'] or str(g.get('integrationStatus')) != '200' or int(g.get('status', 0)) != c['status'] or g.get('httpMethod') != c['method'] or not c['startMs'] - 2000 <= int(g.get('requestTimeEpoch', 0)) <= c['startMs'] + c['latencyMs'] + 2000:
        raise ValueError('GATEWAY_TIME_STATUS_REQUIRED')
    if not re.fullmatch(r'[a-f0-9-]{36}', g.get('integrationRequestId', '')):
        raise ValueError('EXACT_INVOCATION_REQUIRED')
    invocations.append(g['integrationRequestId'])
if len(set(invocations)) != len(clients) or len(clients) > 19:
    raise ValueError('BOUNDED_UNIQUE_INVOCATIONS_REQUIRED')
pattern = '%' + '|'.join(invocations) + '%'
if len(pattern) > 1024:
    raise ValueError('BOUNDED_FILTER_REQUIRED')
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
platform_reports = []
for name, group in [('gateway', '/aws/apigateway/fdp-test-admin-api-access'),
                    ('lambda', '/aws/lambda/fdp-test-api')]:
    found, phases, error, token, pages = [], [], None, None, 0
    seen_tokens = set()
    while True:
        args = ['aws', 'logs', 'filter-log-events', '--log-group-name', group,
                '--start-time', str(start_ms), '--end-time', str(end_ms),
                '--profile', 'esgiot-readonly', '--region', 'ap-southeast-1',
                '--output', 'json', '--no-cli-pager', '--no-paginate']
        if name == 'lambda':
            args += ['--filter-pattern', pattern]
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
            if name == 'lambda':
                report = re.search(r'REPORT RequestId:\s*([a-f0-9-]{36})', message)
                if report:
                    metrics = {}
                    for label, key in [('Duration', 'durationMs'), ('Billed Duration', 'billedDurationMs'), ('Memory Size', 'memoryMiB'), ('Max Memory Used', 'maxMemoryMiB'), ('Init Duration', 'initDurationMs')]:
                        found_metric = re.search(r'(?:^|\t)' + label + r':\s*([0-9.]+)\s*(?:ms|MB)', message)
                        if found_metric:
                            metrics[key] = float(found_metric.group(1))
                    platform_reports.append({'lambdaRequestId': report.group(1), **metrics})
            try:
                value = json.loads(message[message.find('{'):])
            except (ValueError, TypeError):
                continue
            request_id = value.get('requestId') if name == 'gateway' else value.get('gatewayRequestId')
            if request_id not in ids:
                continue
            if name == 'lambda' and value.get('event') == 'data-path.phase.completed':
                phase_fields = ['gatewayRequestId', 'lambdaRequestId', 'operationId', 'phase', 'durationMs',
                                'outcome', 'errorCode', 'startedAt', 'completedAt', 'coldStart', 'includesConnectionWait', 'processCpuUserUs', 'processCpuSystemUs', 'processCpuScope']
                phase = {k: value[k] for k in phase_fields if k in value}
                if value.get('completionBoundary') in ['DRIVER_DISPATCH', 'CALL_RETURNED', 'OPERATION_SETTLED', 'OPERATION_FAILED']:
                    phase['completionBoundary'] = value['completionBoundary']
                phases.append(phase)
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
    own_reports = [p for p in platform_reports if len(runtime) == 1 and p['lambdaRequestId'] == runtime[0].get('lambdaRequestId')]
    linked.append({**client, 'platformReports': own_reports, 'gateway': gateway, 'lambda': runtime, 'exactLinked': exact,
                   'integrationThrottled': any(str(g.get('integrationStatus')) == '429' for g in gateway),
                   'phases': [p for p in rows['lambda']['phases'] if p.get('gatewayRequestId') == client['requestId']]})
expected_count = len(clients) if audit_mode or sampling else 6
complete = (len(linked) == expected_count and len(ids) == expected_count and expected_count > 0 and
            len({c['id'] for c in clients}) == expected_count and
            all(x['exactLinked'] and x['responseReceived'] for x in linked))
report = {'task': 'QA-09', 'sampling': sampling, 'scope': ('OWN_COLD409_AUDIT_GET_GATEWAY_LAMBDA_REQUEST_CORRELATION' if audit_mode else 'OWN_COLD409_PATCH_GATEWAY_LAMBDA_REQUEST_CORRELATION') if sampling else ('OWN_AUDIT_GET_GATEWAY_LAMBDA_REQUEST_CORRELATION' if audit_mode else 'OWN_CONTRACT_PATCH_GATEWAY_LAMBDA_REQUEST_CORRELATION'),
          'collectorSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
          'originalCollectorSha256': hashlib.sha256(Path('scripts/collect-qa09-contract-correlation.py').read_bytes()).hexdigest(),
          'readOptimization': {'scope': 'OWN_EXACT_GATEWAY_INTEGRATION_INVOCATIONS_ONLY', 'priorGatewayReceiptSha256': hashlib.sha256(prior_bytes).hexdigest(), 'invocationIds': invocations},
          'sourceReceiptSha256': hashlib.sha256(raw).hexdigest(), 'sourceCommit': receipt.get('sourceCommit'),
          'prefix': receipt['prefix'], 'fullQa09Accepted': False,
          'startMs': start_ms, 'endMs': end_ms, 'records': linked,
          'logReadErrors': {k: v['error'] for k, v in rows.items() if v['error']},
          'exactLinkedCount': sum(x['exactLinked'] for x in linked),
          'missingHistoricalSiblingReceipt': not ledger.get('attempts'),
          'gate': 'PASS' if complete and not any(v['error'] for v in rows.values()) else 'PARTIAL'}
output.write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps({k: v for k, v in report.items() if k != 'records'}))
