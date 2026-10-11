"""Read-only, bounded Gateway/Lambda correlation; persist only exact own IDs and safe fields."""
import datetime
import hashlib
import json
import math
import re
import sys
from pathlib import Path
sys.dont_write_bytecode = True
sys.path.insert(0, str(Path(__file__).resolve().parent))
from qa09_observer_cost import project_observer, exact_observers
from qa09_log_read import LogReader, EXACT_BATCH_SIZE

source, output = map(Path, sys.argv[1:3])
if output.exists():
    raise ValueError('OUTPUT_ALREADY_EXISTS')
flags = sys.argv[3:]
exact_file = None
if '--exact-from' in flags:
    i = flags.index('--exact-from')
    if i + 1 >= len(flags):
        raise ValueError('EXACT_PRIOR_RECEIPT_REQUIRED')
    exact_file = Path(flags[i + 1])
    flags = flags[:i] + flags[i + 2:]
expected_prior_hash = None
if '--exact-sha256' in flags:
    i = flags.index('--exact-sha256')
    if not exact_file or i + 1 >= len(flags) or not re.fullmatch(r'[a-f0-9]{64}', flags[i + 1]):
        raise ValueError('EXACT_EXPECTED_HASH_REQUIRED')
    expected_prior_hash = flags[i + 1]
    flags = flags[:i] + flags[i + 2:]
raw = source.read_bytes()
receipt = json.loads(raw)
if not re.fullmatch(r'qa09-[a-f0-9]{16}', receipt.get('prefix', '')) or receipt.get('fullQa09Accepted') is not False:
    raise ValueError('OWN_RECEIPT_REQUIRED')
audit_mode = '--audit-get' in flags
sampling = '--cold-sampling' in flags
observer_required = '--observer-cost' in flags
owned_required = '--owned-boundaries' in flags
if owned_required and not observer_required:
    raise ValueError('OWNED_REQUIRES_OBSERVER')
if any(x not in ['--audit-get', '--cold-sampling', '--observer-cost', '--owned-boundaries'] for x in flags):
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
read_optimization = None
pattern = None
if exact_file:
    prior_bytes = exact_file.read_bytes()
    if expected_prior_hash and hashlib.sha256(prior_bytes).hexdigest() != expected_prior_hash:
        raise ValueError('PRIOR_RECEIPT_BYTES_DRIFT')
    prior = json.loads(prior_bytes)
    if (prior.get('sourceReceiptSha256') != hashlib.sha256(raw).hexdigest()
            or prior.get('prefix') != receipt['prefix'] or prior.get('sourceCommit') != receipt.get('sourceCommit')):
        raise ValueError('PRIOR_GATEWAY_BINDING_REQUIRED')
    invocations = []
    for c in clients:
        own = [r for r in prior['records'] if r.get('requestId') == c['requestId']]
        if len(own) != 1 or len(own[0].get('gateway', [])) != 1:
            raise ValueError('UNIQUE_GATEWAY_REQUIRED')
        g = own[0]['gateway'][0]
        latency = c['latencyMs'] if c['latencyMs'] is not None else 30000
        if (g.get('requestId') != c['requestId'] or str(g.get('integrationStatus')) != '200'
                or (c['status'] is not None and str(g.get('status')) != str(c['status']))
                or g.get('httpMethod') != c['method']
                or (c['extendedRequestId'] and g.get('extendedRequestId') != c['extendedRequestId'])
                or not c['startMs'] - 2000 <= int(g.get('requestTimeEpoch', 0)) <= c['startMs'] + latency + 2000):
            raise ValueError('GATEWAY_TIME_STATUS_REQUIRED')
        if not re.fullmatch(r'[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}', g.get('integrationRequestId', '')):
            raise ValueError('EXACT_INVOCATION_REQUIRED')
        invocations.append(g['integrationRequestId'])
    if len(set(invocations)) != len(clients) or not 0 < len(clients) <= 19:
        raise ValueError('BOUNDED_UNIQUE_INVOCATIONS_REQUIRED')
    pattern = '%' + '|'.join(invocations) + '%'
    if len(pattern) > 1024:
        raise ValueError('BOUNDED_FILTER_REQUIRED')
    read_optimization = {'scope': 'OWN_EXACT_GATEWAY_INTEGRATION_INVOCATIONS_ONLY',
                         'priorGatewayReceiptSha256': hashlib.sha256(prior_bytes).hexdigest(),
                         'invocationIds': invocations, 'expectedPriorReceiptSha256': expected_prior_hash}
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
observer_candidates = []
observer_rejected = 0
reader = LogReader()
for name, group in [('gateway', '/aws/apigateway/fdp-test-admin-api-access'),
                    ('lambda', '/aws/lambda/fdp-test-api')]:
    found, phases, ownership = [], [], []
    queries = [None]
    if name == 'lambda' and exact_file:
        queries = [invocations[i:i + EXACT_BATCH_SIZE] for i in range(0, len(invocations), EXACT_BATCH_SIZE)]
    for query, batch in enumerate(queries):
        batch_invocations = set(batch) if batch else None
        batch_ids = {c['requestId'] for c, inv in zip(clients, invocations) if inv in batch_invocations} if batch else ids
        query_pattern = '%' + '|'.join(batch) + '%' if batch else None
        for page in reader.pages(name, group, start_ms, end_ms, query_pattern, query):
            for event in page.get('events', []):
                message = event['message']
                if name == 'lambda':
                    report = re.search(r'REPORT RequestId:\s*([a-f0-9-]{36})', message)
                    if report and (batch_invocations is None or report.group(1) in batch_invocations):
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
                if not isinstance(value, dict):
                    continue
                request_id = value.get('requestId') if name == 'gateway' else value.get('gatewayRequestId')
                if not isinstance(request_id, str) or request_id not in batch_ids:
                    continue
                if name == 'lambda' and value.get('event') == 'data-path.contract-load.observer-cost':
                    projected = project_observer(value)
                    if projected is not None and type(event.get('timestamp')) is int:
                        observer_candidates.append({**projected, 'logTimestampMs': event['timestamp']})
                    else:
                        observer_rejected += 1
                if name == 'lambda' and value.get('event') == 'data-path.phase.completed':
                    phase_fields = ['gatewayRequestId', 'lambdaRequestId', 'operationId', 'phase', 'durationMs',
                                    'outcome', 'errorCode', 'startedAt', 'completedAt', 'coldStart', 'includesConnectionWait']
                    phase = {k: value[k] for k in phase_fields if k in value}
                    if value.get('completionBoundary') in ['DRIVER_DISPATCH', 'CALL_RETURNED', 'MODEL_EXTENSION_ENTERED', 'OPERATION_SETTLED', 'OPERATION_FAILED', 'PG_DISPATCH', 'PG_SETTLED', 'MICROTASK_CHECKPOINT', 'ADAPTER_CALL_RETURNED', 'PG_CALL_RETURNED', 'MODEL_EXTENSION_RESUMED']:
                        phase['completionBoundary'] = value['completionBoundary']
                    if value.get('processCpuScope') == 'PROCESS_ALL_THREADS':
                        phase['processCpuScope'] = 'PROCESS_ALL_THREADS'
                        for key in ['processCpuUserUs', 'processCpuSystemUs']:
                            metric = value.get(key)
                            if type(metric) is int and 0 <= metric <= 9007199254740991:
                                phase[key] = metric
                    phases.append(phase)
                if name == 'lambda' and value.get('event') == 'data-path.contract-load.ownership':
                    if (all(type(value.get(k)) is int and 0 <= value[k] <= 9007199254740991 for k in ['modelEntries', 'driverDispatches'])
                            and type(value.get('transactional')) is bool):
                        own = {k: value[k] for k in ['gatewayRequestId', 'lambdaRequestId', 'operationId', 'modelEntries', 'driverDispatches', 'transactional'] if k in value}
                        if value.get('detailEnabled') is True and all(type(value.get(k)) is int and 0 <= value[k] <= 9007199254740991 for k in ['pgQueries','pgSettlements']):
                            own.update(detailEnabled=True, pgQueries=value['pgQueries'], pgSettlements=value['pgSettlements'])
                        if (value.get('publicBoundariesEnabled') is True and type(value.get('modelResumeObserved')) is bool
                                and all(type(value.get(k)) is int and 0 <= value[k] <= 9007199254740991 for k in ['driverReturns', 'pgReturns', 'modelResumes'])):
                            own.update(publicBoundariesEnabled=True, modelResumeObserved=value['modelResumeObserved'],
                                       **{k: value[k] for k in ['driverReturns', 'pgReturns', 'modelResumes']})
                        ownership.append(own)
                if name == 'lambda' and value.get('event') != 'admin.request.completed':
                    continue
                row = {k: value[k] for k in fields[name] if k in value}
                if name == 'lambda' and isinstance(event.get('timestamp'), int):
                    row['logTimestampMs'] = event['timestamp']
                found.append(row)
        if reader.error:
            break
    rows[name] = {'rows': found, 'phases': phases, 'ownership': ownership,
                  'pages': sum(a['result'] == 'PASS' for a in reader.attempts if a['group'] == name),
                  'error': reader.group_errors.get(name)}
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
    observer_rows = exact_observers(observer_candidates, gateway, runtime, client, start_ms, end_ms)
    observer_gate = 'PASS' if exact and len(observer_rows) == 1 and observer_rows[0]['status'] == 'COMPLETE' and (not owned_required or observer_rows[0]['schemaVersion'] == 2) else 'NOT_OBSERVED' if not observer_rows else 'FAIL'
    linked.append({**client, 'platformReports': own_reports, 'gateway': gateway, 'lambda': runtime, 'exactLinked': exact,
                   'integrationThrottled': any(str(g.get('integrationStatus')) == '429' for g in gateway),
                   'phases': [p for p in rows['lambda']['phases'] if p.get('gatewayRequestId') == client['requestId']],
                   'contractLoadOwnership': [p for p in rows['lambda']['ownership'] if p.get('gatewayRequestId') == client['requestId']],
                   'contractObserverCost': observer_rows, 'observerCostGate': observer_gate})
read_budget = reader.finish()
expected_count = len(clients) if audit_mode or sampling else 6
complete = (len(linked) == expected_count and len(ids) == expected_count and expected_count > 0 and
            len({c['id'] for c in clients}) == expected_count and
            all(x['exactLinked'] and x['responseReceived'] for x in linked) and
            (not observer_required or (observer_rejected == 0 and all(x['observerCostGate'] == 'PASS' for x in linked))))
report = {'task': 'QA-09', 'sampling': sampling, 'scope': ('OWN_COLD409_AUDIT_GET_GATEWAY_LAMBDA_REQUEST_CORRELATION' if audit_mode else 'OWN_COLD409_PATCH_GATEWAY_LAMBDA_REQUEST_CORRELATION') if sampling else ('OWN_AUDIT_GET_GATEWAY_LAMBDA_REQUEST_CORRELATION' if audit_mode else 'OWN_CONTRACT_PATCH_GATEWAY_LAMBDA_REQUEST_CORRELATION'),
          'collectorSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
          'sourceReceiptSha256': hashlib.sha256(raw).hexdigest(), 'sourceCommit': receipt.get('sourceCommit'),
          'prefix': receipt['prefix'], 'fullQa09Accepted': False,
          'startMs': start_ms, 'endMs': end_ms, 'records': linked,
          'logReadErrors': dict(reader.group_errors),
          'logReadBudget': read_budget,
          'readerSha256': hashlib.sha256(Path(__file__).with_name('qa09_log_read.py').read_bytes()).hexdigest(),
          'exactLinkedCount': sum(x['exactLinked'] for x in linked),
          'ownedBoundariesRequired': owned_required, 'observerCostRequired': observer_required, 'observerCostRejected': observer_rejected,
          'observerProjectorSha256': hashlib.sha256(Path(__file__).with_name('qa09_observer_cost.py').read_bytes()).hexdigest(),
          'missingHistoricalSiblingReceipt': not ledger.get('attempts'),
          'gate': 'PASS' if complete and not reader.error else 'PARTIAL'}
if read_optimization:
    report['readOptimization'] = read_optimization
output.write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps({k: v for k, v in report.items() if k != 'records'}))
