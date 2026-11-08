"""Local files and Git only. Does not create identities, fetch credentials, or call targets."""
import hashlib
import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[5]
BASE = Path(__file__).resolve().parents[1]
OLD = ROOT / 'docs/audit/evidence/2026-11-08-device-image-G4-readiness'
TOOL = ROOT / 'scripts/device-image-target-package.mjs'

def dump(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')

def digest(data):
    return hashlib.sha256(data).hexdigest()

def ref(path):
    return {'path': str(path.relative_to(ROOT)), 'sha256': digest(path.read_bytes())}

def blobs(commit, paths):
    proc = subprocess.run(['git', 'cat-file', '--batch'], cwd=ROOT,
        input=''.join(f'{commit}:{p}\n' for p in paths).encode(), capture_output=True, check=True)
    data = proc.stdout
    offset = 0
    result = {}
    for path in paths:
        end = data.index(b'\n', offset)
        header = data[offset:end].decode().split()
        assert len(header) == 3 and header[1] == 'blob', path
        size = int(header[2]); offset = end + 1
        result[path] = data[offset:offset + size]; offset += size
        assert data[offset:offset+1] == b'\n'; offset += 1
    assert offset == len(data)
    return result

if (BASE / 'receipt.json').exists():
    assert json.loads((BASE / 'receipt.json').read_text())['execution'] == 'NOT_RUN', 'Refuse to overwrite executed receipt'
package = json.loads(subprocess.check_output(['node', str(TOOL), '--cloud-templates'], cwd=ROOT))
input_data = package['input']; receipt = package['receipt']
run_id = 'IMG21-CLOUD-20261108-PREPARE01'
input_data['runId'] = run_id; receipt['runId'] = run_id
historical = json.loads((OLD / 'inputs.json').read_text())
confirmed = ['accountId','region','stackName','adminBaseUrl','deviceBaseUrl','mqttEndpoint','controlTable','payloadTable','archiveBucket']
if (BASE / 'inputs.json').exists():
    existing = json.loads((BASE / 'inputs.json').read_text())
    assert all(v['value'] is None for k, v in existing['entries'].items() if k not in confirmed), 'Refuse to overwrite completed execution inputs'
for key in confirmed:
    input_data['entries'][key]['value'] = historical['entries'][key]['value']
receipt['environment'] = {k: input_data['entries'][k]['value'] for k in ['accountId','region','stackName']}
dump(BASE / 'inputs.json', input_data); dump(BASE / 'receipt.json', receipt)
dump(BASE / 'cases.json', {'profile': input_data['profile'], 'sourceCommit': input_data['sourceCommit'],
    'protocolDigest': input_data['protocolDigest'], 'cases': package['cases'],
    'appRequired': False, 'physicalDeviceRequired': False, 'extended44Required': False})
dump(BASE / 'input-provenance.json', {'sourceCommit': input_data['sourceCommit'], 'protocolDigest': input_data['protocolDigest'],
    'userDecision': '沿用该测试环境，设备与身份待准备', 'confirmedEnvironment': confirmed,
    'source': ref(OLD / 'inputs.json'), 'historicalSourceCommit': historical['sourceCommit'],
    'targetRecheckedThisRun': False,
    'note': 'Environment locators reused by user confirmation; not fresh deployment or resource-health evidence.',
    'pending': [k for k, v in input_data['entries'].items() if v['value'] is None]})
# Compare the complete delivery source inventory, without relabeling target observations.
g3 = ROOT / 'docs/audit/evidence/2026-11-08-device-image-G3-rebind-d1a7b811'
rows = [line.split('  ', 1) for line in (g3 / 'sources.sha256').read_text().splitlines()]
paths = [p for _, p in rows]
old_blobs = blobs(historical['sourceCommit'], paths)
new_blobs = blobs(input_data['sourceCommit'], paths)
changed = [p for p in paths if digest(old_blobs[p]) != digest(new_blobs[p])]
for expected, p in rows:
    assert digest(new_blobs[p]) == expected, p
snapshot = json.loads((OLD / 'observations/db-after.json').read_text())['snapshot']
migrations = sorted((ROOT / 'packages/database/prisma/migrations').glob('*/migration.sql'))
applied = {r['migration_name']: r for r in snapshot['migrations']}
checks = []
for path in migrations:
    row = applied.get(path.parent.name)
    checks.append({'name': path.parent.name, 'candidateSha256': digest(path.read_bytes()),
        'historicalChecksum': row['checksum'] if row else None,
        'matchesHistoricalObservation': bool(row and row['checksum'] == digest(path.read_bytes()) and
            row['finished_at'] and not row['rolled_back_at'])})
assert len(checks) == 44 and all(r['matchesHistoricalObservation'] for r in checks)
version_proofs = {name: json.loads((OLD / f'proofs/{name}.json').read_text())
    for name in ['deploymentProof', 'migrationProof', 'runtimeVersionsProof']}
dump(BASE / 'versions.review.json', {'status': 'PASS_OFFLINE_SOURCE_COMPARISON_ONLY',
    'sourceCommit': input_data['sourceCommit'], 'historicallyObservedCommit': historical['sourceCommit'],
    'deliverySourcesCompared': len(paths), 'changedDeliverySources': changed,
    'historicalVersions': version_proofs['deploymentProof']['details']['versions'],
    'historicalSchemaMatchesCandidate': version_proofs['migrationProof']['details']['schemaSha256'] == digest((ROOT / 'packages/database/prisma/schema.prisma').read_bytes()),
    'migrationComparisons': checks, 'historicalProbeMigrationGate': 'BLOCKED_HISTORICAL_40_EXPECTED_LIST_RETAINED',
    'targetCurrentState': 'NOT_RECHECKED', 'currentDeploymentProof': 'NOT_AVAILABLE',
    'targetProofsPromoted': False, 'deploymentOrMigrationAuthorized': False,
    'sources': [ref(OLD / f'proofs/{name}.json') for name in version_proofs] + [ref(OLD / 'observations/db-after.json')],
    'note': 'Source equality supports a version review; it does not prove current deployment or re-date old proofs. No automatic redeploy or remigration.'})
version_keys = ['adminApi','deviceApi','ingestion','mediaEvidence','outbox']
null_versions = dict.fromkeys(version_keys)
details = {
    'deploymentProof': {'deployedSourceCommit': None, 'versions': null_versions},
    'migrationProof': {'schemaSha256': digest((ROOT / 'packages/database/prisma/schema.prisma').read_bytes()),
        'appliedMigrations': None, 'pendingMigrations': None},
    'runtimeVersionsProof': {'versions': null_versions,
        'LIVE_IMAGE_CONTROL_TABLE': input_data['entries']['controlTable']['value'],
        'LIVE_IMAGE_PAYLOAD_TABLE': input_data['entries']['payloadTable']['value'], 'allAuthorityWritersOnCandidate': None},
    'testScopeProof': {'isolated': None, 'mayMutate': None, 'client': 'CONTROLLED_SIMULATOR',
        'deviceIds': [], 'customerIds': [], 'caseIds': ['CF01','CF02','CF03']},
    'executionWindowProof': {'startsAt': None, 'endsAt': None, 'permittedCloudCases': None, 'caseIds': ['CF01','CF02','CF03']},
    'sequenceReservation': {'deviceId': None, 'exclusive': None, 'originalCounterRecorded': None, 'firstSeq': None, 'lastSeq': None},
    'cleanupPlan': {'usesResourceLedger': None, 'disableThroughAuthorityWriter': None, 'preserveControlEpoch': None,
        'preserveHistoricalLinks': None, 'deleteOnlyOwnedKeys': None, 'retentionDecision': None},
}
for name, value in details.items():
    dump(BASE / f'proof-drafts/{name}.json', {'status': 'DRAFT_NOT_EVIDENCE', 'mode': 'TARGET_CLOUD',
        'profile': input_data['profile'], 'sourceCommit': input_data['sourceCommit'], 'protocolDigest': input_data['protocolDigest'],
        'runId': run_id, **receipt['environment'], 'syntheticResponsesAllowed': False,
        'inputId': name, 'capturedAt': None, 'passed': False, 'details': value,
        'sourceEvidence': [], 'requiredCandidate': input_data['sourceCommit']})
dump(BASE / 'schedule.json', {'status': 'BLOCKED_MISSING_DEVICE_IDENTITY_AND_WINDOW', 'profile': input_data['profile'],
    'sourceCommit': input_data['sourceCommit'], 'protocolDigest': input_data['protocolDigest'], 'runId': run_id,
    'timezone': 'Asia/Shanghai', 'requestedStartsAt': None, 'requestedEndsAt': None,
    'authorizedStartsAt': None, 'authorizedEndsAt': None, 'approved': False,
    'estimateMinutes': 45, 'estimateIsNotAnApprovedWindowOrSla': True,
    'steps': [
        {'order':1,'task':'Prepare exclusive simulated device/customer, mTLS/MQTT and viewer identity; no App required','state':'BLOCKED'},
        {'order':2,'task':'Confirm actual target deployment/runtime and existing migration state inside authorized window','state':'NOT_RUN'},
        {'order':3,'task':'Run CF01 on real public endpoints and compare decoded JPEG bytes','state':'NOT_RUN'},
        {'order':4,'task':'Run CF02 EVENT then CF03 ACTIVE ALARM, S3/MQTT/AVAILABLE/download hash','state':'NOT_RUN'},
        {'order':5,'task':'Release viewers; retain owned evidence; record cleanup ledger and sanitized artifacts','state':'NOT_RUN'},
        {'order':6,'task':'Offline cloud receipt check plus independent real-source review; record PASS_CLOUD_INTERFACES or actual failures','state':'NOT_RUN'}],
    'notPrerequisites':['THIRD_PARTY_APP','PHYSICAL_DEVICE_TEST','24H_WINDOW','CAPACITY_SLA','NATIVE_FAULT_SUITE'],
    'notAuthorizedByThisDraft':['DEPLOY','TARGET_MIGRATION','DEVICE_ENABLEMENT','TARGET_API_CALLS','PUSH']})
print(json.dumps({'status':'PASS_OFFLINE_PREPARATION','environmentFields':len(confirmed),
    'pendingExecutionInputs':22-len(confirmed),'deliverySourcesCompared':len(paths), 'changedDeliverySources':len(changed),
    'historicalMigrationChecksumsMatched':len(checks),'cloudRequests':0,'g4':'NOT_RUN'}))
