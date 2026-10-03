import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
test('performance summary refuses to report P95 PASS for missing or incomplete actual samples', () => {
  const r = spawnSync(
    'python3',
    [
      '-c',
      `import runpy,json
m=runpy.run_path('scripts/collect-qa09-performance-summary.py');f=m['slo_scope'];s=[{'visible':True,'latencyMs':100} for _ in range(20)]
assert f(s,'visible',5000)['gate']=='PASS'
assert f(s[:19],'visible',5000)['gate']=='FAIL'
assert f(s[:19]+[{'visible':False,'latencyMs':1}],'visible',5000)['p95Ms'] is None
assert f(s[:19]+[{'visible':True,'latencyMs':None}],'visible',5000)['gate']=='FAIL'
assert f([{'received':False,'latencyMs':None} for _ in range(20)],'received',3000)['gate']=='FAIL'
print(json.dumps({'gate':'PASS'}))`,
    ],
    { encoding: 'utf8', timeout: 5000 },
  );
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).gate, 'PASS');
});
