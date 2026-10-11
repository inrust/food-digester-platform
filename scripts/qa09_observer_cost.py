"""Exact observer-event projection only; no AWS calls and no arbitrary payload persistence."""
import json
import math

EVENT = 'data-path.contract-load.observer-cost'
STATUSES = ['COMPLETE', 'TRUNCATED', 'PROBE_FAILED', 'FOREIGN_SCOPE', 'REENTRANT', 'OUTPUT_FAILED',
            'OWNERSHIP_INVALID', 'DUPLICATE_PUBLIC_CALL', 'MISSING_BOUNDARY', 'AMBIGUOUS']
NAMES = ['driver-prefix', 'public-call', 'driver-return-tail', 'after-model']
COUNTERS = ['intervalRecords', 'publicCalls', 'overflow', 'nestedOutputs', 'foreignOutputs', 'probeFailures',
            'outsideOutputs', 'ambiguousOutputs', 'unresolvedOutputs']


def metric(v):
    return type(v) in (int, float) and math.isfinite(v) and 0 <= v <= 9007199254740991


def project_observer(value):
    if (value.get('event') != EVENT or value.get('schemaVersion') != 1 or type(value.get('schemaVersion')) is not int
            or value.get('publicOutcome') not in ['NOT_OBSERVED', 'RETURNED', 'THREW']
            or value.get('status') not in STATUSES or value.get('cpuSubtractionAllowed') is not False
            or value.get('compilerOnlyAttribution') is not False or value.get('processCpuScope') != 'PROCESS_ALL_THREADS'
            or not all(type(value.get(k)) is int and metric(value[k]) for k in COUNTERS)
            or value['intervalRecords'] > 64 or not isinstance(value.get('segments'), list)
            or len(value['segments']) > 4):
        return None
    segments = []
    for row in value['segments']:
        if (not isinstance(row, dict) or row.get('name') not in NAMES
                or not all(metric(row.get(k)) for k in ['wallUs', 'outputWallUs', 'outputProcessCpuUs'])
                or row['outputWallUs'] > row['wallUs']):
            return None
        residual = row.get('unattributedWallUs')
        if value['status'] == 'COMPLETE':
            if not metric(residual) or abs(residual - (row['wallUs'] - row['outputWallUs'])) > 0.001:
                return None
        elif residual is not None:
            return None
        segments.append({k: row[k] for k in ['name', 'wallUs', 'outputWallUs', 'outputProcessCpuUs', 'unattributedWallUs']})
    names = [r['name'] for r in segments]
    if (len(set(names)) != len(names) or names != sorted(names, key=NAMES.index)
            or value['status'] == 'COMPLETE' and (names != NAMES or value['publicCalls'] != 1 or value['publicOutcome'] != 'RETURNED'
              or any(value[k] != 0 for k in ['overflow', 'nestedOutputs', 'foreignOutputs', 'probeFailures', 'ambiguousOutputs', 'unresolvedOutputs']))):
        return None
    result = {k: value[k] for k in ['event', 'schemaVersion', 'gatewayRequestId', 'lambdaRequestId', 'operationId',
                                   'status', 'publicOutcome', 'processCpuScope', 'cpuSubtractionAllowed', 'compilerOnlyAttribution'] + COUNTERS if k in value}
    result['segments'] = segments
    return result if len(json.dumps(result, separators=(',', ':')).encode()) <= 4096 else None


def exact_observers(candidates, gateway, runtime, client, start_ms, end_ms):
    own = []
    if len(gateway) != 1 or len(runtime) != 1:
        return own
    invocation = gateway[0].get('integrationRequestId')
    lower = max(start_ms, client['startMs'] - 2000)
    upper = min(end_ms, client['startMs'] + max(client.get('latencyMs') or 30000, 30000) + 2000)
    for row in candidates:
        if (row.get('gatewayRequestId') == client['requestId'] and row.get('lambdaRequestId') == invocation
                and runtime[0].get('lambdaRequestId') == invocation and row.get('operationId') == client['operationId']
                and type(row.get('logTimestampMs')) is int and lower <= row['logTimestampMs'] <= upper):
            own.append(row)
    return own
