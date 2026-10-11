"""Describe byte-bound existing cold requests only; no probes or cost attribution."""
import hashlib, json, sys
from pathlib import Path

root = Path(__file__).resolve().parent
mode = sys.argv[1]
assert mode in ['r0', 'r1']
p = root / mode
output = p / 'contract-window-observations.json'
assert not output.exists()
bindings = {}

def read(name):
    b = (p / name).read_bytes()
    bindings[name] = hashlib.sha256(b).hexdigest()
    return json.loads(b)

unit = read('unit-completion.json')
assert unit['gate'] == 'PASS' and unit['sourceCommit'] == '5773ac9d7bad13d41c2d00e456f8b633fa939579'
for name, digest in unit['bindings'].items():
    assert hashlib.sha256((p / name).read_bytes()).hexdigest() == digest
rows = []
names = ['contract-load', 'contract-load-await-after-queue', 'contract-load-driver-before-pg',
         'contract-load-pg-submit', 'contract-load-driver-submit', 'contract-load-pg-await',
         'contract-load-driver-after-pg', 'contract-load-driver-query',
         'contract-load-result-to-model', 'contract-load-result-after-model', 'contract-load-result']
for group in ['baseline', 'sampling']:
    receipt = read(group + '-patch.json')
    assert receipt['gate'] == 'PASS' and receipt['sourceCommit'] == unit['sourceCommit']
    assert receipt['prefix'] == unit['prefix']
    for r in receipt['records']:
        if r['status'] != 409 or not any((v.get('initDurationMs') or 0) > 0 for v in r['platformReports']):
            continue
        assert r['exactLinked'] and len(r['lambda']) == len(r['gateway']) == len(r['platformReports']) == 1
        assert r['gateway'][0]['integrationRequestId'] == r['lambda'][0]['lambdaRequestId']
        phases = {}
        for name in names:
            found = [v for v in r['phases'] if v['phase'] == name]
            assert len(found) == 1
            duration = found[0]['durationMs']
            assert isinstance(duration, int) and not isinstance(duration, bool) and duration >= 0
            phases[name] = duration
        summaries = r['contractObserverCost']
        if mode == 'r1':
            assert len(summaries) == 1 and summaries[0]['status'] == 'COMPLETE'
            assert summaries[0]['compilerOnlyAttribution'] is False and summaries[0]['cpuSubtractionAllowed'] is False
        else:
            assert summaries == []
        rows.append({'id': r['id'], 'group': group, 'requestId': r['requestId'],
                     'lambdaRequestId': r['lambda'][0]['lambdaRequestId'], 'clientMs': r['latencyMs'],
                     'phaseMs': phases, 'observerSegmentsUs': summaries[0]['segments'] if summaries else None})

result = {'gate': 'DESCRIPTIVE_ONLY', 'scope': 'EXISTING_EXACT_PHYSICAL_COLD_409_NESTED_WINDOWS',
          'sourceCommit': unit['sourceCommit'], 'prefix': unit['prefix'], 'mode': mode,
          'coldRequests': len(rows), 'rows': rows, 'bindings': bindings,
          'additionalRequests': 0, 'nestedIntervalsAdditive': False, 'cpuSubtractionAllowed': False,
          'compilerOnlyAttribution': False, 'candidateBenefit': 'NOT_ESTABLISHED',
          'p95Accepted': False, 'fullQa09Accepted': False}
output.write_text(json.dumps(result, indent=2) + '\n')
print(json.dumps({k:v for k,v in result.items() if k not in ['bindings', 'rows']}))
