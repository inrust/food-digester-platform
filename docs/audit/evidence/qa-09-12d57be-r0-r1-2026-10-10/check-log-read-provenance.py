"""Bind original log-read failures to exact fixed-request recovery without HTTP replay."""
from pathlib import Path
import hashlib, json

root = Path(__file__).resolve().parent
out = root / 'log-read-provenance.json'
assert not out.exists()
bindings, observations = {}, []
def digest(p):
    return hashlib.sha256(p.read_bytes()).hexdigest()
def read(n):
    p = root / n
    bindings[n] = digest(p)
    return json.loads(p.read_text())
fields = ['method', 'operationId', 'id', 'requestId', 'startedAt', 'startMs', 'status',
          'extendedRequestId', 'latencyMs', 'responseReceived', 'clientTransport']
for mode in ['r0', 'r1']:
    unit = read(mode + '/unit-completion.json')
    sample = root / mode / 'sample.json'
    assert digest(sample) == unit['bindings']['sample.json']
    for name, count in [('baseline-patch', 6), ('baseline-audit', 19),
                        ('sampling-patch', 12), ('sampling-audit', 18)]:
        effective = read(mode + '/' + name + '.json')
        assert effective['gate'] == 'PASS' and effective['exactLinkedCount'] == count
        assert effective['sourceReceiptSha256'] == digest(sample)
        originalPath = root / mode / (name + '-original.json')
        assert originalPath.exists(), 'ORIGINAL_READ_RECEIPT_REQUIRED'
        original = read(mode + '/' + name + '-original.json')
        if original['gate'] == 'PASS':
            assert digest(originalPath) == digest(root / mode / (name + '.json'))
            observations.append(dict(mode=mode, collector=name, originalGate='PASS', exactReadRecovery=False))
            continue
        assert original['gate'] == 'PARTIAL' and original['logReadErrors']
        optimization = effective['readOptimization']
        assert optimization['priorGatewayReceiptSha256'] == digest(originalPath)
        for k in ['sourceReceiptSha256', 'sourceCommit', 'prefix', 'startMs', 'endMs']:
            assert effective[k] == original[k]
        def requests(v):
            return [{k:r.get(k) for k in fields} for r in v['records']]
        assert requests(effective) == requests(original), 'HTTP_REQUEST_RECEIPT_DRIFT'
        assert set(optimization['invocationIds']) == {
            r['lambda'][0]['lambdaRequestId'] for r in effective['records']}
        observations.append(dict(mode=mode, collector=name, originalGate='PARTIAL',
                                 effectiveGate='PASS', exactReadRecovery=True, requestCount=count))
v = dict(gate='PASS', scope='FIXED_HTTP_RECEIPTS_AND_EXACT_LOG_READ_RECOVERY_PROVENANCE_ONLY',
         sourceCommit=unit['sourceCommit'], observations=observations, bindings=bindings,
         newHttpRequests=0, p95Accepted=False, fullQa09Accepted=False)
out.write_text(json.dumps(v, indent=2) + '\n')
print(json.dumps(dict(gate='PASS', collectors=len(observations), newHttpRequests=0)))
