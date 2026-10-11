"""Local evidence/source integrity and offline receipt revalidation; no cloud calls."""
import hashlib
import json
import re
import subprocess
import sys
from pathlib import Path

root = Path(__file__).resolve().parent
repo = root.parents[3]
manifest = root / 'manifest.json'
documents = [
    'docs/audit/QA-09-after-queue与driver-prefix离线分界实施记录-2026-10-11.md',
    'docs/dev/QA-09-after-queue与driver-prefix离线分界.md',
]


def digest(p):
    return hashlib.sha256(p.read_bytes()).hexdigest()


def inventory():
    return {str(p.relative_to(root)): digest(p) for p in sorted(root.rglob('*'))
            if p.is_file() and p != manifest}


assert sys.argv[1:] in [['--seal'], ['--check']]
if sys.argv[1] == '--seal':
    assert not manifest.exists(), 'NO_RESEAL'
    matrix = json.loads((root / 'matrix-final/matrix.json').read_text())
    assert matrix['gate'] == 'PASS' and len(matrix['rows']) == 16
    assert matrix['readyToDeploy'] is False and matrix['candidateDefaultsChanged'] is False
    assert matrix['budget']['forcedYields'] == matrix['budget']['networkRequests'] == 0
    assert matrix['budget']['poolMax'] == matrix['budget']['concurrency'] == 1
    assert sum(len(row['summary']) for row in matrix['rows']) == 36
    for item in matrix['inputs']:
        assert digest(repo / item['path']) == item['sha256'], 'CURRENT_INPUT_DRIFT:' + item['path']
    validator = """
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { validateDispatchReceipt } from './scripts/qa09-contract-dispatch-proof.mjs';
const root=process.argv[1], matrix=JSON.parse(readFileSync(resolve(root,'matrix-final/matrix.json')));
for (const row of matrix.rows) {
  const bytes=readFileSync(resolve(root,'matrix-final',row.receipt));
  if (createHash('sha256').update(bytes).digest('hex')!==row.sha256) throw Error('RECEIPT_DRIFT');
  if (JSON.stringify(validateDispatchReceipt(JSON.parse(bytes)))!==JSON.stringify(row.summary)) throw Error('SUMMARY_DRIFT');
}
console.log(JSON.stringify({gate:'PASS',cases:matrix.rows.length}));
"""
    q = subprocess.run(['node', '--input-type=module', '-e', validator, str(root)], cwd=repo,
                       capture_output=True, text=True, check=True)
    assert json.loads(q.stdout)['cases'] == 16
    old = repo / 'docs/audit/evidence/qa-09-5773ac9-r0-r1-2026-10-11/check-current-seal.py'
    q = subprocess.run(['python3', str(old), '--check'], cwd=repo,
                       capture_output=True, text=True, check=True)
    assert json.loads(q.stdout)['sealedFiles'] == 716
    verification = json.loads((root / 'verification.json').read_text())
    production = ['apps', 'packages/database/src', 'packages/observability/src', 'infra', '.github']
    q = subprocess.run(['git', 'diff', verification['baseCommit'], '--', *production], cwd=repo,
                       capture_output=True, check=True)
    assert not q.stdout, 'PRODUCTION_SOURCE_DRIFT'
    for p in root.rglob('*'):
        if p.is_file():
            assert not re.search(rb'(?:AKIA|ASIA)[A-Z0-9]{16}|eyJ[\w-]{12,}\.[\w-]{12,}\.[\w-]{12,}|-----BEGIN (?:RSA |EC |ENCRYPTED )?PRIVATE KEY-----', p.read_bytes()), 'SECRET_PATTERN'
    data = dict(gate='OFFLINE_BOUNDARY_PASS', files=inventory(),
                sources={item['path']: item['sha256'] for item in matrix['inputs']},
                documents={name: digest(repo / name) for name in documents},
                historicalTargetFilesVerified=716, independentCases=16, transactionSamples=36,
                runtimeWiringImplemented=False, readyToDeploy=False, candidateDefaultsChanged=False,
                targetGate='NOT_RUN', qa09Gate='PARTIAL', p95Accepted=False, fullQa09Accepted=False)
    manifest.write_text(json.dumps(data, indent=2, ensure_ascii=False) + '\n')
data = json.loads(manifest.read_text())
assert inventory() == data['files'], 'EVIDENCE_DRIFT'
for section in ['sources', 'documents']:
    for name, expected in data[section].items():
        assert digest(repo / name) == expected, section + ':' + name
print(json.dumps({k: v for k, v in data.items() if k not in ['files', 'sources', 'documents']} |
                 {'sealedFiles': len(data['files'])}))
