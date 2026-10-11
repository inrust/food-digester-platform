"""Seal final local evidence without promoting it to new-SHA target acceptance."""
import hashlib
import json
import subprocess
import sys
from pathlib import Path
root = Path(__file__).resolve().parent
report = Path('docs/audit/QA-09-精确采集器小批读取与总时限实施记录-2026-10-12.md')
runbook = Path('docs/dev/QA-09-精确采集器小批读取与总时限复验.md')
manifest = root/'manifest.json'
bindings = ['scripts/collect-qa09-contract-correlation.py','scripts/qa09_log_read.py',
    'scripts/qa09_observer_cost.py','scripts/check-qa09-log-read-budget.mjs',
    'scripts/check-qa09-log-read-budget.test.mjs','scripts/qa09-log-read.test.mjs',
    'scripts/qa09-exact-correlation.test.mjs','scripts/qa09-observer-collector.test.mjs',
    'scripts/qa09-contract-correlation.test.mjs','scripts/qa09-cold409-correlation.test.mjs',
    'package.json','AGENTS.md',str(report),str(runbook)]
def digest(path): return hashlib.sha256(Path(path).read_bytes()).hexdigest()
def inventory(): return {str(p.relative_to(root)):digest(p) for p in sorted(root.rglob('*')) if p.is_file() and p != manifest}
def validate():
    assert (root/'final-secrets.exit').read_text().strip()=='0'
    assert json.loads((root/'final-source-checks.json').read_text())['gate']=='PASS'
    checks=json.loads((root/'verify-clean/verify-results.json').read_text())
    expected=json.loads(Path('package.json').read_text())['scripts']['verify'].split(' && ')
    assert checks['gate']=='PASS' and checks['noCloudActions'] is True and len(checks['commands'])==22
    assert [c['original'] for c in checks['commands']]==expected
    assert all(c['exitCode']==0 for c in checks['commands'])
    first=json.loads((root/'verify-results.json').read_text())
    assert first['gate']=='PARTIAL' and first['commands'][0]['exitCode']==1
    restored=json.loads((root/'build-preservation.json').read_text())
    assert restored['gate']=='PASS' and restored['before']==restored['after'] and restored['verifyExitCode']==0
    historical=json.loads((root/'historical-evidence.json').read_text())
    assert historical['gate']=='PASS' and historical['newTargetGate']=='NOT_RUN'
    assert (root/'final-script-tests.exit').read_text().strip()=='1'
    assert 'EPERM' in (root/'final-script-tests.log').read_text()
    assert (root/'final-script-tests-localnet.exit').read_text().strip()=='0'
    final_scripts=(root/'final-script-tests-localnet.log').read_text()
    assert 'tests 1129' in final_scripts and 'pass 1129' in final_scripts and 'fail 0' in final_scripts
    suites=sorted((root/'suite-receipts').glob('*.json'))
    assert len(suites)==7 and all(json.loads(p.read_text())['status']=='PASS' for p in suites)
    log=(root/'sealed-matrix-tests.log').read_text()
    assert 'tests 103' in log and 'pass 103' in log and 'fail 0' in log
    matrix=sorted((root/'sealed-failure-matrix').glob('*.json'))
    assert len(matrix)==37
    for p in matrix:
        row=json.loads(p.read_text())
        assert row['scope']=='LOCAL_CONTROLLED_NO_AWS' and row['fullQa09Accepted'] is False
        result=row.get('result')
        if result:
            for field,path in [('collectorSha256',bindings[0]),('readerSha256',bindings[1]),('observerProjectorSha256',bindings[2])]:
                assert result[field]==digest(path), (p,field)
            assert len(result['logReadBudget']['attempts'])<=40
    return {'gate':'LOCAL_LOG_READ_BUDGET_PASS','targetGate':'NOT_RUN','qa09Gate':'PARTIAL',
        'p95Accepted':False,'fullQa09Accepted':False,'noCloudActions':True,
        'focusedTests':103,'finalMatrixReceipts':37,'finalScriptTests':1129,'localVerifyCommands':22,
        'initialLintGate':'FAIL_PREEXISTING_UNTRACKED_BUILD','buildRestoreGate':'PASS',
        'historicalEvidenceGate':'PASS','nextSequence':'SAME_SHA_19_ARTIFACTS_R0_CLEANUP_R1_CLEANUP_OFF_RESTORE'}
assert sys.argv[1:] in [['--seal'],['--check']]
result=validate()
if sys.argv[1]=='--seal':
    assert not manifest.exists(), 'FRESH_LOCAL_SEAL_REQUIRED'
    manifest.write_text(json.dumps({**result,'baseCommit':subprocess.check_output(['git','rev-parse','HEAD']).decode().strip(),
        'files':inventory(),'bindings':{p:digest(p) for p in bindings}},indent=2)+'\n')
saved=json.loads(manifest.read_text())
assert saved['files']==inventory(), 'LOCAL_EVIDENCE_BYTES_DRIFT'
assert saved['bindings']=={p:digest(p) for p in bindings}, 'LOCAL_SOURCE_BYTES_DRIFT'
assert all(saved[k]==v for k,v in result.items())
print(json.dumps({**result,'sealedFiles':len(saved['files']),'sourceBindings':len(saved['bindings'])}))
