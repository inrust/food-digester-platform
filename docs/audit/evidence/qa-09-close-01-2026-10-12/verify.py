"""Local integrity and scope checks; never promotes historical evidence to live acceptance."""
from pathlib import Path
import base64
import hashlib
import json
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parent
REPO = ROOT.parents[3]
sha = lambda b: hashlib.sha256(b).hexdigest()
load = lambda name: json.loads((ROOT / name).read_bytes())
base = load('reconciliation-before.json')
assert base['gate'] == 'PASS_INVENTORY_ONLY_QA09_PARTIAL'
assert (base['candidatePairs'], base['historicallyObservedPairs'], base['duplicatesRemovedFromNeverRun']) == (112, 79, 4)
for ref in base['refs']:
    assert sha((REPO / ref['path']).read_bytes()) == ref['sha256'], ref['path']
assert all(not x['currentAcceptance'] == 'PASS' for x in base['semantic']['elements'])
version = load('application-version.json')
assert version['gate'] == 'PASS' and len(version['lambdaArtifacts']) == 19
assert version['sourceCommit'] == base['targetCommit'] == 'beaccece84ec865020aefc537af296228ec8b933'
recovery = load('user-target-recovery.json')
assert recovery['gate'] == 'PASS_CLEANUP_ONLY'
assert recovery['originalReceiptSha256'] == sha((ROOT / 'user-target.json').read_bytes())
assert recovery['checks'] and all(x['result'] == 'PASS' for x in recovery['checks'])
assert recovery['cleanup'] and all(x['result'] == 'PASS' for x in recovery['cleanup'])
unknown = load('first-user-five-build-inspection.json')
assert unknown['originalStartGate'] == 'UNKNOWN' and unknown['restartAllowed'] is False
assert unknown['absenceProvesNonExecution'] is False
assert unknown['windowCovered'] is True and unknown['exactMatches'] == 0
builds = load('latest-exact-build-details.json')
assert all(b['status'] == 'SUCCEEDED' for b in builds)
assert load('formal-gates.json')['results'] and all(x['exitCode'] != 0 for x in load('formal-gates.json')['results'])
# Historical sealed bytes are checked against their recorded audit commit, never rewritten.
old_root = REPO / 'docs/audit/evidence/qa-09-ad213fa-r0-r1-2026-10-12'
old = json.loads((old_root / 'manifest.json').read_bytes())
actual = {str(p.relative_to(old_root)): sha(p.read_bytes()) for p in old_root.rglob('*') if p.is_file() and p.name != 'manifest.json'}
assert actual == old['files'] and len(actual) == 792
for path, wanted in old['bindings'].items():
    assert sha(subprocess.check_output(['git', 'show', '6504b635705b631e93240780da1665f4ad12a313:' + path], cwd=REPO)) == wanted
# Freeze snapshots and scan decoded source, including sources over the generic scanner size limit.
source_count = 0
for p in ROOT.rglob('*.json'):
    value = json.loads(p.read_bytes())
    def scan(v):
        global source_count
        if isinstance(v, dict):
            if 'sourceBase64' in v:
                raw = base64.b64decode(v['sourceBase64'], validate=True)
                wanted = v.get('sha256') or v.get('sourceHash')
                if wanted:
                    assert sha(raw) == wanted, str(p)
                scan(raw.decode())
                source_count += 1
            for k, item in v.items():
                if k != 'sourceBase64':
                    scan(item)
        elif isinstance(v, list):
            for item in v: scan(item)
        elif isinstance(v, str):
            assert not re.search(r'\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\bghp_[A-Za-z0-9]{36}\b|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\beyJ[A-Za-z0-9_-]{30,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}', v), str(p)
    scan(value)
final = load('reconciliation-after.json')
assert final['qa09Gate'] == 'PARTIAL' and final['fullQa09Accepted'] is False
assert final['releasePerformanceAccepted'] is False and final['productionReady'] is False
assert len(final['semanticSupplement']) == 2
assert final['combinedHistoricalBehaviorCoverage'] == {'everPass': 102, 'neverRun': 15, 'currentTargetVerified': 2, 'current117Accepted': False}
run = load('user-target-v2.json')
assert run['gate'] == 'PASS_SCOPED_FIVE_ROLE_SIGNED_SESSION_AND_USER_WRITES'
assert len(run['users']) == 5 and all(u['businessDisabled'] and u['cognitoDeleted'] for u in run['users'])
assert all(c['result'] == 'PASS' for c in run['checks'] + run['cleanup'])
assert len(run['userBrowser']) == 2 and all(b['result'] == 'PASS' and b['notificationWrites'] == 0 for b in run['userBrowser'])
assert run['notificationSendingRequested'] is False and run['invitationAcceptanceClaimed'] is False
assert run['applicationVersionReceiptSha256'] == sha((ROOT / 'application-version.json').read_bytes())
readback = load('final-readonly-recovered.json')
assert readback['gate'] == 'PASS_READ_ONLY_IDENTITIES_EMPTY_BUILDS_TERMINAL' and readback['writes'] == 0
assert readback['originalReadGate'] == 'FAIL' and readback['originalUnknownStart'] == 'UNKNOWN_NO_RESTART'
assert readback['originalReceiptSha256'] == sha((ROOT/'final-readonly.json').read_bytes())
assert len(readback['identities']) == 2 and all(x['count'] == 0 for x in readback['identities'])
assert len(readback['builds']) == 5 and all(x['status'] == 'SUCCEEDED' for x in readback['builds'])
assert re.search(r'pass 1316\b', (ROOT / 'closeout-all-script-tests.log').read_text())
assert not (ROOT / 'final-lint.log').read_text().strip()
for name in ['docs/dev/QA-09-非Active用户闭环与证据合并复验.md', 'docs/audit/QA-09-CLOSE-01业务证据合并与非Active用户闭环-2026-10-12.md']:
    path = REPO / name
    for link in re.findall(r'\]\(([^)]+)\)', path.read_text()):
        if not link.startswith(('https:', '#')):
            assert path.parent.joinpath(link).resolve().exists(), link
bindings = ['scripts/qa09-ten-device-db.mjs', 'scripts/run-qa09-signed-session-target.mjs', 'scripts/collect-qa09-business-reconciliation.mjs', 'scripts/qa09-business-reconciliation.mjs', 'scripts/qa09-business-reconciliation.test.mjs', 'scripts/qa09-user-closeout-browser.mjs', 'scripts/qa09-user-closeout.test.mjs', 'scripts/run-qa09-user-closeout-target.mjs', 'scripts/recover-qa09-user-closeout.mjs', 'docs/dev/QA-09-非Active用户闭环与证据合并复验.md', 'docs/dev/QA-09-业务闭环优先收口计划.md', 'docs/管理后台开发任务清单.md', 'docs/audit/QA-09-CLOSE-01业务证据合并与非Active用户闭环-2026-10-12.md']
files = {str(p.relative_to(ROOT)): sha(p.read_bytes()) for p in ROOT.rglob('*') if p.is_file() and p.name not in ['manifest.json', 'verification.json']}
manifest = {'scope': 'QA09_CLOSE01_SCOPED_USER_ACCEPTANCE_NOT_FULL_QA09', 'targetCommit': version['sourceCommit'], 'files': files, 'bindings': {p: sha((REPO / p).read_bytes()) for p in bindings}, 'fullQa09Accepted': False}
if '--seal' in sys.argv:
    assert not (ROOT / 'manifest.json').exists()
    (ROOT / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
else:
    assert load('manifest.json') == manifest
result = {'gate':'PASS_LOCAL_INTEGRITY_AND_SCOPED_RECEIPTS', 'files':len(files), 'bindings':len(bindings), 'decodedSourcesChecked':source_count, 'historicalFilesChecked':792, 'qa09Gate':'PARTIAL', 'fullQa09Accepted':False, 'productionReady':False}
(ROOT / 'verification.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
print(json.dumps(result,ensure_ascii=False))
