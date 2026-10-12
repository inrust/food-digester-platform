"""Controlled CLI/clock fixtures. Never contacts AWS."""
import hashlib
import json
import re
import runpy
import subprocess
import sys
import tempfile
from datetime import datetime
from pathlib import Path

sys.dont_write_bytecode = True
script = Path(__file__).with_name('collect-qa09-auxiliary-phases.py')
module = runpy.run_path(str(script))
reader_module = module['log_read']
mode, case = sys.argv[1:3]
count = 8 if mode == 'initial' else 12
ids = ['20000000-0000-4000-8000-' + str(i).zfill(12) for i in range(count)]
invs = ['30000000-0000-4000-8000-' + str(i).zfill(12) for i in range(count)]
if case == 'invocation-reuse':
    invs[1] = invs[0]
sha = 'a' * 40
stamp = '2026-10-12T00:00:00.000Z'
epoch = int(datetime.fromisoformat(stamp.replace('Z', '+00:00')).timestamp() * 1000)
calls, clock = [], [0]
reader_module.time.monotonic = lambda: clock[0]
pages_per_query = 5 if case == 'call-limit' else 21 if case == 'page-limit' else 2
secret = 'PRIVATE_AUX_SENTINEL'


def cli(args, **kw):
    assert args[:3] == ['aws', 'logs', 'filter-log-events']
    assert kw['env']['AWS_MAX_ATTEMPTS'] == '1' and 0 < kw['timeout'] <= 15
    assert '--no-paginate' in args and '--limit' in args
    group = args[args.index('--log-group-name') + 1]
    pattern = args[args.index('--filter-pattern') + 1]
    members = re.findall(r'[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}', pattern)
    assert pattern == '%' + '|'.join(members) + '%' and 1 <= len(members) <= 3
    page = 1 if '--next-token' not in args else int(args[args.index('--next-token') + 1].split('-')[-1])
    calls.append({'group': group, 'members': members, 'page': page})
    if (case == 'timeout' and len(calls) == 7) or (case == 'report-timeout' and len(calls) == 6):
        raise subprocess.TimeoutExpired(args, kw['timeout'], stderr=secret)
    if case == 'deadline' and len(calls) == 7:
        clock[0] = 120
    if case in ['denied', 'expired', 'throttled', 'unknown']:
        error = {'denied': 'AccessDenied', 'expired': 'Token has expired and refresh failed', 'throttled': 'ThrottlingException', 'unknown': 'UnexpectedFailure'}[case]
        return subprocess.CompletedProcess(args, 1, secret, error + ' ' + secret)
    if case == 'unavailable':
        raise FileNotFoundError(secret)
    if case == 'malformed':
        return subprocess.CompletedProcess(args, 0, secret, '')
    if case == 'repeat':
        # A constant legal next token repeats on page two.
        return subprocess.CompletedProcess(args, 0, json.dumps({'events': [], 'nextToken': 'token-1'}), '')
    events = []
    if page == 1:
        for i, rid in enumerate(ids):
            rejected = mode == 'negative' and case in ['rejected', 'rejected-leak', 'gateway-rejected-string']
            if '/apigateway/' in group and rid in members:
                value = {'requestId': rid, 'extendedRequestId': 'ext-' + rid,
                         'integrationRequestId': '-' if rejected else invs[i],
                         'requestTimeEpoch': epoch, 'httpMethod': 'GET',
                         'status': 401 if mode == 'negative' else 200,
                         'integrationStatus': '-' if rejected else 200,
                         'functionStatus': '-' if rejected else 401 if mode == 'negative' else 200,
                         'errorResponseType': 'UNAUTHORIZED' if rejected else None,
                         'password': secret}
                gateway_values = {
                    'gateway-string': str(epoch), 'gateway-rejected-string': str(epoch),
                    'gateway-whitespace': ' ' + str(epoch), 'gateway-exponent': str(epoch) + 'e0',
                    'gateway-fraction-string': str(epoch) + '.0', 'gateway-leading-zero': '0' + str(epoch),
                    'gateway-unsafe-string': '9007199254740992', 'gateway-bool': True,
                    'gateway-number-fraction': epoch + 0.5, 'gateway-null': None,
                    'gateway-empty': '', 'gateway-unicode': '１２３', 'gateway-malformed': 'NaN',
                    'gateway-negative': -1, 'gateway-string-outside': str(epoch + 999999)
                }
                if case in gateway_values:
                    value['requestTimeEpoch'] = gateway_values[case]
                if case == 'gateway-time':
                    value['requestTimeEpoch'] = epoch + 999999
                if case == 'gateway-status':
                    value['status'] = 200
                if case == 'extended-id':
                    value['extendedRequestId'] = 'foreign'
                events.append({'message': json.dumps(value)})
                if case == 'duplicate-gateway':
                    events.append(events[-1])
            elif '/lambda/' in group and rid in members and (not rejected or case == 'rejected-leak'):
                common = {'gatewayRequestId': rid, 'lambdaRequestId': invs[i],
                          'gatewayExtendedRequestId': 'ext-' + rid, 'operationId': 'listCustomers',
                          'status': 401 if mode == 'negative' else 200, 'password': secret}
                if case == 'invalid-invocation':
                    common['lambdaRequestId'] = 'invalid'
                if case == 'gateway-lambda':
                    common['gatewayExtendedRequestId'] = 'foreign'
                duration = {'password': secret} if case == 'nested-field' else 1
                events.extend([{'message': json.dumps({**common, 'event': 'admin.request.completed', 'elapsedMs': 12})},
                               {'message': json.dumps({**common, 'event': 'data-path.phase.completed', 'phase': 'auth', 'durationMs': duration})}])
                if case == 'duplicate-completion':
                    events.append(events[-2])
            elif '/lambda/' in group and invs[i] in members and case != 'missing-report':
                duration = '1.2.3' if case == 'report-invalid-number' else '12'
                events.append({'message': 'REPORT RequestId: ' + invs[i] + '\tDuration: ' + duration + ' ms\tMemory Size: 512 MB\t' + secret})
                if case == 'duplicate-report':
                    events.append(events[-1])
        # Responses may contain unrelated rows despite the filter: strip them.
        foreign = {'requestId': 'f' * 36, 'gatewayRequestId': 'foreign', 'lambdaRequestId': invs[0], 'event': 'admin.request.completed', 'password': secret}
        events += [{'message': json.dumps(foreign)}]
    response = {'events': events}
    if page < pages_per_query:
        response['nextToken'] = 'token-' + str(page + 1)
    return subprocess.CompletedProcess(args, 0, json.dumps(response), '')


reader_module.subprocess.run = cli
with tempfile.TemporaryDirectory(prefix='qa09-auxiliary-test-') as folder:
    folder = Path(folder)
    child_path, parent_path, output = [folder / name for name in ['child.json', 'parent.json', 'output.json']]
    parent = {'gate': 'PASS', 'sourceCommit': sha, 'prefix': 'qa09-1234567890abcdef',
              'startedAt': stamp, 'finishedAt': '2026-10-12T00:00:01.000Z',
              'checks': [{'requestId': rid} for rid in ids]}
    child = {**parent, 'checks': [], 'rows': [{'gatewayRequestId': rid, 'gatewayExtendedRequestId': 'ext-' + rid,
                                            'startedAt': stamp, 'latencyMs': 100} for rid in ids]}
    expected = {
        'timeout': 'LOG_READ_TIMEOUT', 'report-timeout': 'LOG_READ_TIMEOUT', 'deadline': 'LOG_TOTAL_DEADLINE_EXCEEDED',
        'denied': 'LOG_ACCESS_DENIED', 'expired': 'LOG_SSO_EXPIRED', 'throttled': 'LOG_THROTTLED',
        'unknown': 'LOG_READ_FAILED', 'unavailable': 'LOG_CLI_UNAVAILABLE',
        'malformed': 'LOG_INVALID_RESPONSE', 'repeat': 'LOG_PAGINATION_INCOMPLETE',
        'page-limit': 'LOG_PAGINATION_INCOMPLETE', 'call-limit': 'LOG_CALL_LIMIT',
        'duplicate-gateway': 'AUX_GATEWAY_NOT_UNIQUE', 'invalid-invocation': 'AUX_INVOCATION_INVALID',
        'invocation-reuse': 'AUX_INVOCATION_REUSED',
        'nested-field': 'AUX_EVENT_FIELD_INVALID',
        'gateway-lambda': 'AUX_GATEWAY_LAMBDA_MISMATCH', 'duplicate-completion': 'AUX_GATEWAY_LAMBDA_MISMATCH',
        'missing-report': 'AUX_REPORT_NOT_UNIQUE', 'duplicate-report': 'AUX_REPORT_NOT_UNIQUE',
        'report-invalid-number': 'AUX_REPORT_INVALID', 'invalid-prefix': 'AUX_PREFIX_INVALID',
        'gateway-time': 'AUX_GATEWAY_TIME_MISMATCH', 'gateway-status': 'AUX_NEGATIVE_STATUS_INVALID',
        'extended-id': 'AUX_EXTENDED_ID_MISMATCH', 'rejected-leak': 'AUX_REJECTED_REQUEST_HAS_LAMBDA_EVENTS',
        'duplicate-id': 'AUX_TWELVE_UNIQUE_NEGATIVE_REQUESTS_REQUIRED',
        'short-initial': 'AUX_EIGHT_INITIAL_REQUESTS_REQUIRED', 'source-drift': 'AUX_CHILD_INVALID',
        'parent-drift': 'AUX_PARENT_INVALID', 'output-exists': 'AUX_OUTPUT_EXISTS',
        'latency-invalid': 'AUX_CLIENT_LATENCY_INVALID', 'time-invalid': 'AUX_TIME_INVALID'
    }.get(case)
    if case in ['gateway-whitespace', 'gateway-exponent', 'gateway-fraction-string',
                'gateway-leading-zero', 'gateway-unsafe-string', 'gateway-bool',
                'gateway-number-fraction', 'gateway-null', 'gateway-empty',
                'gateway-unicode', 'gateway-malformed', 'gateway-negative']:
        expected = 'AUX_GATEWAY_TIME_INVALID'
    if case == 'gateway-string-outside':
        expected = 'AUX_GATEWAY_TIME_MISMATCH'
    if case == 'duplicate-id':
        child['rows'][-1]['gatewayRequestId'] = ids[0]
    if case == 'short-initial':
        parent['checks'] = parent['checks'][:-1]
    if case == 'source-drift':
        child['sourceCommit'] = 'b' * 40
    if case == 'parent-drift':
        parent['prefix'] = 'qa09-0000000000000000'
    if case == 'invalid-prefix':
        child['prefix'] = parent['prefix'] = 'invalid'
    if case == 'latency-invalid':
        child['rows'][0]['latencyMs'] = True
    if case == 'time-invalid':
        child['rows'][0]['startedAt'] = '2026-10-12T00:00:00'
    if case == 'output-exists':
        output.write_text('preserve-original')
    parent_path.write_text(json.dumps(parent)); child_path.write_text(json.dumps(child))
    try:
        result = module['collect'](child_path, output, mode, sha, parent_path if mode == 'initial' else None)
    except module['InvalidEvidence'] as error:
        assert str(error) == expected and not calls
        assert not output.exists() or output.read_text() == 'preserve-original'
        result = {'gate': 'BLOCKED', 'collectionError': str(error), 'records': []}
    else:
        assert result['gate'] == ('PARTIAL' if expected else 'PASS'), (result['gate'], case)
        assert result['collectionError'] == expected, (result['collectionError'], expected)
        assert secret not in output.read_text()
        assert len(result['logReadBudget']['attempts']) <= 40 and result['logReadBudget']['totalDeadlineMs'] == 120000
        assert all(1 <= len(b['members']) <= 3 for b in result['readBatches'])
        if not expected:
            assert len(result['records']) == count
            assert len(calls) == (18 if mode == 'initial' else 16 if case in ['rejected', 'gateway-rejected-string'] else 24)
            if case in ['rejected', 'gateway-rejected-string']:
                assert all(r['lambdaRequestId'] is None and r['exactOwnLambdaLogMatches'] == 0 for r in result['records'])
        if case in ['timeout', 'deadline']:
            assert len(calls) == 7 and len(result['records']) == 3
        if case == 'report-timeout':
            assert len(calls) == 6 and not result['records']
            assert len(result['pendingRecords']) == 3
            assert all(len(row['platformReports']) == 1 for row in result['pendingRecords'])
        if case == 'call-limit':
            assert len(calls) == 40 and len(result['records']) == 6
        if case == 'page-limit':
            assert len(calls) == 20
    receipt = {'gate': 'PASS', 'mode': mode, 'case': case, 'awsCalls': 0,
               'cliCalls': len(calls), 'completedRecords': len(result['records']),
               'inputBytes': {'child': child_path.read_text(), 'parent': parent_path.read_text()},
               'result': result, 'collectorSha256': hashlib.sha256(script.read_bytes()).hexdigest()}
    print(json.dumps(receipt))
