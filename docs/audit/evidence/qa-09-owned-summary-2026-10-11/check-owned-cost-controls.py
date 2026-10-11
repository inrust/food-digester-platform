"""Local fixed receipt replay only: no network, injected delay, query or process spawn."""
import json
from pathlib import Path
root = Path(__file__).resolve().parent
matrix = json.loads((root / 'sealed-runtime-matrix/matrix.json').read_text())
rows = []
for item in matrix['rows']:
    receipt = json.loads((root / 'sealed-runtime-matrix' / item['receipt']).read_text())
    for i, sample in enumerate(receipt['samples']):
        costs = [r for r in sample['observations'] if r['event'] == 'data-path.contract-load.observer-cost']
        if not costs or costs[0]['status'] != 'COMPLETE':
            continue
        cost = costs[0]
        own = cost['ownedBoundaries']
        phases = [r for r in sample['observations'] if r.get('phase') == 'contract-load-await-after-queue']
        assert len(phases) == 1
        assert abs(own['afterQueueWallUs'] / 1000 - phases[0]['durationMs']) <= 1
        assert sum(s['wallUs'] for s in own['segments'][:3]) == own['afterQueueWallUs']
        assert sum(s['wallUs'] for s in own['segments'][3:5]) == cost['segments'][0]['wallUs']
        if item['case'] == 'slow-prefix-log':
            assert own['segments'][3]['name'] == 'repository-driver-setup'
            assert own['segments'][3]['wallUs'] >= 19000
            assert cost['segments'][0]['outputWallUs'] >= 19000
        rows.append({'case': item['case'], 'index': i, 'afterQueueWallUs': own['afterQueueWallUs'],
                     'originalAfterQueueDurationMs': phases[0]['durationMs'],
                     'repositoryDriverSetupUs': own['segments'][3]['wallUs'],
                     'driverPrefixOutputWallUs': cost['segments'][0]['outputWallUs']})
assert len(rows) == 18
print(json.dumps({'gate': 'PASS', 'scope': 'LOCAL_FIXED_RUNTIME_OWNED_PARTITION_AND_PREFIX_CONTROL',
                  'completeSamples': 18, 'prefixControlledSamples': 3, 'controlledCpuPerSampleMs': 20,
                  'targetEquivalent': False, 'networkCalls': 0, 'p95Accepted': False,
                  'compilerOnlyAttribution': False, 'rows': rows}, indent=2))
