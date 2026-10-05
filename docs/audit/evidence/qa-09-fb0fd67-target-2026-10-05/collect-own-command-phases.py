"""Read fixed metadata for this run's twenty Commands; no raw logs or resource writes."""
import datetime, json, math, pathlib, re, subprocess
BASE = pathlib.Path(__file__).parent
probes = json.loads((BASE / 'normal.json.probes.json').read_text())
version = json.loads((BASE / 'application-version.json').read_text())
prefix = probes['prefix']
assert re.fullmatch(r'qa09-[a-f0-9]{16}', prefix)
assert version['gate'] == 'PASS' and version['sourceCommit'] == probes['sourceCommit']
commands = {prefix.upper() + '-CMD-' + str(i) for i in range(20)}
assert {r['commandId'] for r in probes['performance']['commands']} == commands
fn = [r for r in version['lambdaArtifacts'] if r['name'] == 'fdp-test-command-publisher' and r['matches']]
assert len(fn) == 1
start = int(datetime.datetime.fromisoformat(probes['startedAt'].replace('Z', '+00:00')).timestamp() * 1000)
end = int(datetime.datetime.fromisoformat(probes['finishedAt'].replace('Z', '+00:00')).timestamp() * 1000) + 300000
assert 0 < end - start <= 6 * 3600000

def aws(args):
    out = subprocess.check_output(['aws', *args, '--profile', 'esgiot-readonly', '--region', 'ap-southeast-1', '--output', 'json', '--no-cli-pager'], timeout=60)
    return json.loads(out)

assert aws(['sts', 'get-caller-identity'])['Account'] == '065986019555'
reads = []
fields = ['event', 'phase', 'durationMs', 'lambdaRequestId', 'coldStart', 'outcome', 'errorCode', 'commandId', 'sqsMessageId', 'ageAtWorkerStartMs', 'clock']
events = {'command.phase.completed', 'command.notification.received', 'command.notification.consumed'}
phases = {'db-validation', 'db-lease', 'db-attempt', 'iot-publish', 'db-finalize', 'db-secret', 'iot-endpoint', 'sqs-consumption', 'scheduled-scan'}

def fetch(field, ids):
    if not ids:
        return []
    assert len(ids) <= 40 and all(re.fullmatch(r'[A-Za-z0-9-]{1,128}', x) for x in ids)
    if len(ids) > 10:
        ordered = sorted(ids)
        return [row for offset in range(0, len(ordered), 10) for row in fetch(field, set(ordered[offset:offset + 10]))]
    pattern = '{ ' + ' || '.join('($.' + field + ' = "' + x + '")' for x in sorted(ids)) + ' }'
    assert len(pattern) <= 1024
    rows, token = [], None
    for page in range(20):
        args = ['logs', 'filter-log-events', '--log-group-name', '/aws/lambda/' + fn[0]['name'], '--start-time', str(start), '--end-time', str(end), '--filter-pattern', pattern, '--limit', '10000', '--no-paginate']
        if token:
            args += ['--next-token', token]
        assert len(reads) < 20, 'TOTAL_LOG_READ_LIMIT_REACHED'
        response = aws(args)
        reads.append({'field': field, 'page': page, 'identifierCount': len(ids), 'eventCount': len(response.get('events', []))})
        for event in response.get('events', []):
            try:
                raw = event['message']; row = json.loads(raw[raw.index('{'):])
            except (ValueError, KeyError):
                continue
            if row.get('event') not in events or (row.get('phase') and row['phase'] not in phases):
                continue
            projected = {'observedAtMs': event['timestamp']}
            for key in fields:
                val = row.get(key)
                if isinstance(val, bool) or isinstance(val, (int, float)) and math.isfinite(val) and val >= 0:
                    projected[key] = val
                elif isinstance(val, str) and re.fullmatch(r'[A-Za-z0-9_.-]{1,128}', val):
                    projected[key] = val
            rows.append(projected)
        next_token = response.get('nextToken')
        if not next_token or next_token == token:
            break
        assert page < 19, 'LOG_PAGE_LIMIT_REACHED'
        token = next_token
    return rows

own = [r for r in fetch('commandId', commands) if r.get('commandId') in commands]
requests = {r['lambdaRequestId'] for r in own if re.fullmatch(r'[a-f0-9-]{36}', r.get('lambdaRequestId', ''))}
sqs_ids = {r['sqsMessageId'] for r in own if r.get('event') == 'command.notification.consumed'}
related = [r for r in fetch('lambdaRequestId', requests) if r.get('commandId') in commands or not r.get('commandId') and (r.get('phase') in {'sqs-consumption', 'db-secret', 'iot-endpoint'} or r.get('sqsMessageId') in sqs_ids)]
rows = sorted({json.dumps(r, sort_keys=True): r for r in own + related}.values(), key=lambda r: r['observedAtMs'])
coverage = []
for command in sorted(commands):
    stages = {r.get('phase') for r in rows if r.get('commandId') == command and r.get('outcome') == 'PASS'}
    consumed = [r for r in rows if r.get('commandId') == command and r['event'] == 'command.notification.consumed' and r.get('outcome') == 'PUBLISHED']
    complete = {'db-validation', 'db-lease', 'db-attempt', 'iot-publish', 'db-finalize'} <= stages and any(any(s.get('lambdaRequestId') == c.get('lambdaRequestId') and s.get('phase') == 'sqs-consumption' and s.get('outcome') == 'PASS' for s in rows) for c in consumed)
    coverage.append({'commandId': command, 'phases': sorted(stages), 'publishedConsumptionObserved': bool(consumed), 'complete': complete})
stats = {}
for phase in sorted(phases):
    vals = sorted(r['durationMs'] for r in rows if r.get('phase') == phase and r.get('outcome') == 'PASS' and isinstance(r.get('durationMs'), (int, float)))
    if vals:
        stats[phase] = {'samples': len(vals), 'p95Ms': vals[math.ceil(len(vals) * .95) - 1], 'maxMs': max(vals)}
receipt = {'task': 'QA-09', 'sourceCommit': probes['sourceCommit'], 'prefix': prefix, 'scope': 'OWN_TWENTY_COMMAND_WORKER_PHASE_METADATA_ONLY', 'logGroup': '/aws/lambda/' + fn[0]['name'], 'windowStartMs': start, 'windowEndMs': end, 'reads': reads, 'rows': rows, 'coverage': coverage, 'phaseStats': stats, 'rawLogsArchived': False, 'iamOrKmsChanged': False, 'sqsConsumptionIsInvocationBatchScope': True, 'coldStartObserved': any(r.get('coldStart') is True for r in rows), 'gate': 'PASS_SCOPED_COMMAND_PHASES' if all(r['complete'] for r in coverage) else 'NO_RECEIPT', 'fullQa09Accepted': False}
(BASE / 'command-phases.json').write_text(json.dumps(receipt, indent=2) + '\n')
print(json.dumps({'gate': receipt['gate'], 'rows': len(rows), 'completeCommands': sum(r['complete'] for r in coverage), 'coldStartObserved': receipt['coldStartObserved']}))
raise SystemExit(0 if receipt['gate'] == 'PASS_SCOPED_COMMAND_PHASES' else 1)
