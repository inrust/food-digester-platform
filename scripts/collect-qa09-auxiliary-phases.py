"""Collect only owned initial/negative requests in serial batches of at most three."""
import argparse
import hashlib
import json
import math
import re
import sys
from datetime import datetime
from pathlib import Path

sys.dont_write_bytecode = True
# Explicit sibling location also works with Python -I and an unrelated cwd.
sys.path.insert(0, str(Path(__file__).resolve().parent))
import qa09_log_read as log_read

UUID = re.compile(r'^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$')
PHASE_FIELDS = ['lambdaRequestId', 'gatewayRequestId', 'gatewayExtendedRequestId',
                'operationId', 'phase', 'durationMs', 'outcome', 'errorCode',
                'startedAt', 'completedAt', 'coldStart', 'includesConnectionWait',
                'completionBoundary', 'processCpuUserUs', 'processCpuSystemUs',
                'processCpuScope', 'elapsedMs', 'status', 'event']
GATEWAY_FIELDS = ['requestId', 'extendedRequestId', 'integrationRequestId',
                  'requestTimeEpoch', 'httpMethod', 'status', 'integrationStatus',
                  'functionStatus', 'integrationLatency', 'responseLatency', 'errorResponseType']


class InvalidEvidence(Exception):
    pass


def require(value, code):
    if not value:
        raise InvalidEvidence(code)


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def timestamp(value):
    require(isinstance(value, str), 'AUX_TIME_INVALID')
    try:
        parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
        require(parsed.tzinfo is not None, 'AUX_TIME_INVALID')
        return int(parsed.timestamp() * 1000)
    except (ValueError, OverflowError):
        raise InvalidEvidence('AUX_TIME_INVALID') from None


def gateway_epoch(value):
    # API Gateway's JSON access-log template emits this field as decimal text.
    # Preserve the original scalar in evidence; parse only for comparisons.
    if isinstance(value, str):
        require(re.fullmatch(r'(?:0|[1-9][0-9]{0,15})', value) is not None, 'AUX_GATEWAY_TIME_INVALID')
        value = int(value)
    require(isinstance(value, (int, float)) and not isinstance(value, bool)
            and math.isfinite(value) and value == int(value)
            and 0 <= value <= 9007199254740991, 'AUX_GATEWAY_TIME_INVALID')
    return int(value)


def object_event(event):
    text = event['message']
    try:
        value = json.loads(text[text.find('{'):])
        return value if isinstance(value, dict) else {}
    except (ValueError, TypeError):
        return {}


def project(row, fields):
    result = {}
    for key in fields:
        if key not in row:
            continue
        value = row[key]
        require(value is None or isinstance(value, (str, int, float, bool)), 'AUX_EVENT_FIELD_INVALID')
        require(not isinstance(value, str) or len(value) <= 512, 'AUX_EVENT_FIELD_INVALID')
        require(not isinstance(value, (int, float)) or isinstance(value, bool) or math.isfinite(value), 'AUX_EVENT_FIELD_INVALID')
        result[key] = value
    return result


def collect(child_path, output, mode, expected_commit, parent_path=None):
    output = Path(output)
    require(not output.exists(), 'AUX_OUTPUT_EXISTS')
    require(mode in ['initial', 'negative'], 'AUX_MODE_INVALID')
    require(re.fullmatch(r'[a-f0-9]{40}', expected_commit or ''), 'AUX_COMMIT_INVALID')
    child = json.loads(Path(child_path).read_bytes())
    require(child.get('sourceCommit') == expected_commit and child.get('gate') == 'PASS', 'AUX_CHILD_INVALID')
    bindings = {'childSha256': digest(child_path), 'collectorSha256': digest(__file__)}
    if mode == 'initial':
        require(isinstance(child.get('prefix'), str) and re.fullmatch(r'qa09-[a-f0-9]{16}', child['prefix']), 'AUX_PREFIX_INVALID')
        require(parent_path is not None, 'AUX_PARENT_REQUIRED')
        parent = json.loads(Path(parent_path).read_bytes())
        require(parent.get('gate') == 'PASS' and parent.get('prefix') == child.get('prefix')
                and parent.get('sourceCommit') == expected_commit, 'AUX_PARENT_INVALID')
        bindings['parentSha256'] = digest(parent_path)
        require(all(isinstance(doc.get('checks'), list) and all(isinstance(r, dict) for r in doc['checks'])
                    for doc in [parent, child]), 'AUX_INITIAL_ROWS_INVALID')
        ids = []
        for row in parent['checks'] + child['checks']:
            rid = row.get('requestId') or row.get('gatewayRequestId')
            if isinstance(rid, str) and UUID.fullmatch(rid) and rid not in ids:
                ids.append(rid)
            if len(ids) == 8:
                break
        require(len(ids) == 8, 'AUX_EIGHT_INITIAL_REQUESTS_REQUIRED')
        start, end = timestamp(parent['startedAt']) - 2000, timestamp(parent['finishedAt']) + 120000
        require(0 < end - start < 3600000, 'AUX_TIME_WINDOW_INVALID')
    else:
        rows = child.get('rows', [])
        require(isinstance(rows, list) and all(isinstance(r, dict) for r in rows), 'AUX_NEGATIVE_ROWS_INVALID')
        ids = [row.get('gatewayRequestId') for row in rows]
        require(len(ids) == 12 and all(isinstance(rid, str) and UUID.fullmatch(rid) for rid in ids)
                and len(set(ids)) == 12, 'AUX_TWELVE_UNIQUE_NEGATIVE_REQUESTS_REQUIRED')
        for row in rows:
            timestamp(row.get('startedAt'))
            latency = row.get('latencyMs')
            require(isinstance(latency, (int, float)) and not isinstance(latency, bool)
                    and math.isfinite(latency) and latency >= 0, 'AUX_CLIENT_LATENCY_INVALID')
        start, end = timestamp(child['startedAt']) - 2000, timestamp(child['finishedAt']) + 120000
        require(0 < end - start < 600000, 'AUX_TIME_WINDOW_INVALID')

    reader = log_read.LogReader()
    records, pending, queries, batches = [], [], {'gateway': 0, 'lambda': 0}, []
    seen_invocations = set()

    def events(name, members, stage):
        require(1 <= len(members) <= 3 and len(set(members)) == len(members)
                and all(UUID.fullmatch(x) for x in members), 'AUX_QUERY_OWNERSHIP_INVALID')
        query = queries[name]
        queries[name] += 1
        group = '/aws/apigateway/fdp-test-admin-api-access' if name == 'gateway' else '/aws/lambda/fdp-test-api'
        batches.append({'group': name, 'query': query, 'stage': stage, 'members': members})
        for page in reader.pages(name, group, start, end, '%' + '|'.join(members) + '%', query):
            yield from page['events']
        if reader.error:
            raise InvalidEvidence(reader.error)

    failure = None
    try:
        for offset in range(0, len(ids), 3):
            batch = ids[offset:offset + 3]
            gateways = {rid: [] for rid in batch}
            phases = {rid: [] for rid in batch}
            pending = [{'requestId': rid, 'gateway': gateways[rid], 'events': phases[rid]} for rid in batch]
            for event in events('gateway', batch, 'gateway'):
                row = object_event(event)
                if isinstance(row.get('requestId'), str) and row['requestId'] in gateways:
                    gateways[row['requestId']].append(project(row, GATEWAY_FIELDS))
            for rid in batch:
                require(len(gateways[rid]) == 1, 'AUX_GATEWAY_NOT_UNIQUE')
                gateway_ms = gateway_epoch(gateways[rid][0].get('requestTimeEpoch'))
                require(start <= gateway_ms <= end, 'AUX_GATEWAY_TIME_MISMATCH')
            for event in events('lambda', batch, 'phase'):
                row = object_event(event)
                if not isinstance(row.get('gatewayRequestId'), str) or row['gatewayRequestId'] not in phases or row.get('event') not in ['data-path.phase.completed', 'admin.request.completed']:
                    continue
                require(isinstance(row.get('lambdaRequestId'), str) and UUID.fullmatch(row['lambdaRequestId']), 'AUX_INVOCATION_INVALID')
                phases[row['gatewayRequestId']].append(project(row, PHASE_FIELDS))
            owned, rejected = {}, set()
            for rid in batch:
                gateway, rows = gateways[rid][0], phases[rid]
                if mode == 'negative':
                    client = next(r for r in child['rows'] if r['gatewayRequestId'] == rid)
                    require(gateway.get('httpMethod') == 'GET' and str(gateway.get('status')) == '401', 'AUX_NEGATIVE_STATUS_INVALID')
                    sent = timestamp(client['startedAt'])
                    gateway_ms = gateway_epoch(gateway.get('requestTimeEpoch'))
                    require(sent - 2000 <= gateway_ms <= sent + client['latencyMs'] + 2000,
                            'AUX_GATEWAY_TIME_MISMATCH')
                    require(not client.get('gatewayExtendedRequestId') or client['gatewayExtendedRequestId'] == gateway.get('extendedRequestId'), 'AUX_EXTENDED_ID_MISMATCH')
                    if all(gateway.get(k) == '-' for k in ['integrationRequestId', 'integrationStatus', 'functionStatus']):
                        require(gateway.get('errorResponseType') == 'UNAUTHORIZED' and not rows, 'AUX_REJECTED_REQUEST_HAS_LAMBDA_EVENTS')
                        rejected.add(rid)
                        continue
                invocations = {r['lambdaRequestId'] for r in rows}
                require(len(invocations) == 1, 'AUX_INVOCATION_NOT_UNIQUE')
                invocation = next(iter(invocations))
                require(invocation not in seen_invocations and invocation not in owned.values(), 'AUX_INVOCATION_REUSED')
                complete = [r for r in rows if r['event'] == 'admin.request.completed']
                require(len(complete) == 1 and gateway.get('integrationRequestId') == invocation
                        and gateway.get('extendedRequestId') == complete[0].get('gatewayExtendedRequestId')
                        and str(gateway.get('status')) == str(complete[0].get('status')), 'AUX_GATEWAY_LAMBDA_MISMATCH')
                owned[rid] = invocation
            reports = {inv: [] for inv in owned.values()}
            for row in pending:
                row['platformReports'] = reports.get(owned.get(row['requestId']), [])
            if reports:
                for event in events('lambda', list(reports), 'report'):
                    text = event['message']
                    found = re.search(r'REPORT RequestId:\s*([a-f0-9-]{36})', text)
                    if not found or found.group(1) not in reports:
                        continue
                    report = {'lambdaRequestId': found.group(1)}
                    for label, key in [('Duration', 'durationMs'), ('Init Duration', 'initDurationMs'), ('Memory Size', 'memoryMiB'), ('Max Memory Used', 'maxMemoryMiB')]:
                        match = re.search(r'(?:^|\t)' + label + r':\s*([0-9.]+)\s*(?:ms|MB)', text)
                        if match:
                            try:
                                report[key] = float(match.group(1))
                            except ValueError:
                                raise InvalidEvidence('AUX_REPORT_INVALID') from None
                            require(math.isfinite(report[key]), 'AUX_EVENT_FIELD_INVALID')
                    reports[found.group(1)].append(report)
            for rid in batch:
                if rid in rejected:
                    records.append({'requestId': rid, 'lambdaRequestId': None, 'phases': [], 'completion': [],
                                    'platformReports': [], 'gateway': gateways[rid], 'boundary': 'COGNITO_AUTHORIZER_REJECTED_BEFORE_LAMBDA', 'exactOwnLambdaLogMatches': 0})
                    continue
                inv = owned[rid]
                require(len(reports[inv]) == 1, 'AUX_REPORT_NOT_UNIQUE')
                records.append({'requestId': rid, 'lambdaRequestId': inv,
                                'phases': [r for r in phases[rid] if r['event'] == 'data-path.phase.completed'],
                                'completion': [r for r in phases[rid] if r['event'] == 'admin.request.completed'],
                                'platformReports': reports[inv], 'gateway': gateways[rid]})
                seen_invocations.add(inv)
            pending = []
    except InvalidEvidence as error:
        failure = str(error)
    budget = reader.finish()
    failure = failure or budget['error']
    result = {'gate': 'PARTIAL' if failure else 'PASS', 'sourceCommit': expected_commit,
              'scope': 'OWN_FIRST_EIGHT_INITIALIZATION_REQUESTS_EXACT_INVOCATIONS' if mode == 'initial' else 'OWN_TWELVE_NEGATIVE_GET_EXACT_INVOCATIONS',
              'records': records, 'pendingRecords': pending, 'collectionError': failure,
              'requestIds': ids, 'readBatches': batches, 'logReadBudget': budget,
              'logReadErrors': dict(reader.group_errors), 'readerSha256': digest(log_read.__file__),
              'bindings': bindings, 'fullQa09Accepted': False, 'p95Accepted': False}
    if mode == 'initial':
        result['prefix'] = child['prefix']
    with output.open('x') as file:
        file.write(json.dumps(result, indent=2) + '\n')
    return result


def main():
    if sys.argv[1:] == ['--check-import']:
        print(json.dumps({'gate': 'PASS', 'modulePath': str(Path(log_read.__file__).resolve()), 'readerSha256': digest(log_read.__file__)}))
        return 0
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('child')
    parser.add_argument('output')
    parser.add_argument('--mode', choices=['initial', 'negative'], required=True)
    parser.add_argument('--expected-commit', required=True)
    parser.add_argument('--parent')
    args = parser.parse_args()
    try:
        result = collect(args.child, args.output, args.mode, args.expected_commit, args.parent)
    except (InvalidEvidence, ValueError, KeyError, TypeError, OSError) as error:
        code = str(error) if isinstance(error, InvalidEvidence) else 'AUX_INPUT_INVALID'
        print(json.dumps({'gate': 'BLOCKED', 'error': code}))
        return 1
    print(json.dumps({'gate': result['gate'], 'requests': len(result['records']), 'error': result['collectionError']}))
    return 0 if result['gate'] == 'PASS' else 1


if __name__ == '__main__':
    sys.exit(main())
