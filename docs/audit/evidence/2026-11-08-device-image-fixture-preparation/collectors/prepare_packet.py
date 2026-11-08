"""Prepare local intents only. No HTTP, AWS, credential reads or target writes."""
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[5]
BASE = Path(__file__).resolve().parents[1]
PRIOR = ROOT / 'docs/audit/evidence/2026-11-08-device-image-cloud-interface-readiness'


def dump(name, value):
    p = BASE / name
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n')


def prepare():
    identity = json.loads((BASE / 'local-identity.json').read_text())
    inputs = json.loads((PRIOR / 'inputs.json').read_text())
    inputs['runId'] = identity['runId']
    prefix = identity['prefix']
    pending = [k for k, v in inputs['entries'].items() if v['value'] is None]
    assert len(pending) == 13
    dump('inputs.json', inputs)
    obs = json.loads((BASE / 'readonly-observations.json').read_text())
    all_matches = len(obs.get('functions', [])) == 20 and all(v['matchesHistoricalCode'] for v in obs['functions'])
    resources = {'runId': identity['runId'], 'prefix': prefix, 'createdInCloud': False,
        'customer': {'name': identity['customerName'], 'id': None},
        'site': {'name': identity['siteName'], 'id': None},
        'device': {'serialNumber': identity['serialNumber'], 'id': None, 'optIn': False, 'serverAllowlisted': False},
        'viewer': {'username': identity['viewerUsername'], 'role': 'CustomerViewer', 'userId': None, 'customerScopeId': None},
        'temporaryProvisioner': {'username': identity['provisionerUsername'], 'role': 'PlatformSuperAdmin', 'userId': None,
            'reason': 'onboarding:approve is unavailable to PlatformOperator; disable immediately after provisioning'},
        'certificate': {'csrSha256': identity['csrSha256'], 'publicKeySha256': identity['publicKeySha256'], 'certificateId': None},
        'countsMaximum': {'customers': 1, 'sites': 1, 'devices': 1, 'certificates': 1, 'cognitoUsers': 2,
            'licenses': 1, 'serverAllowlistRows': 1, 'g4ArchiveObjects': 4, 'activeViewerLeases': 1},
        'neverBorrowExistingDevicesUsersOrCertificates': True}
    dump('planned-resources.json', resources)
    api = json.loads((ROOT / 'contracts/rest/openapi.bundle.json').read_text())
    operation = {op['operationId']: {'method': method.upper(), 'path': path}
        for path, methods in api['paths'].items() for method, op in methods.items() if isinstance(op, dict) and 'operationId' in op}
    bodies = {
        'createCustomer': {'name': identity['customerName']},
        'createSite': {'customerId': '{{CREATED_CUSTOMER_ID}}', 'name': identity['siteName'], 'timezone': 'Asia/Shanghai'},
        'submitOnboardingRequest': {'serialNumber': prefix, 'model': 'IMG21-SIMULATOR', 'hardwareVersion': '1.0',
            'manufacturer': 'FDP cloud test', 'manufactureDate': '2026-11-08', 'csrPem': (BASE / 'device.csr.pem').read_text()},
        'approveOnboardingRequest': None,
        'assignDevice': {'customerId': '{{CREATED_CUSTOMER_ID}}', 'siteId': '{{CREATED_SITE_ID}}', 'reason': 'IMG21 isolated simulator'},
        'createLicense': {'deviceId': '{{CREATED_DEVICE_ID}}', 'validFrom': '2026-11-08', 'validTo': '2026-11-09',
            'entitlements': ['ESG_REPORTING'], 'reason': 'Short test license for simulator Active eligibility; no ESG tests'},
        'issueLicense': None,
    }
    dump('http-write-intents.json', {'executable': False, 'approved': False, 'runId': identity['runId'],
        'requests': [{'operationId': k, **operation[k], 'body': body,
            'pathBindings': 'ONLY_IDS_RETURNED_BY_THIS_RUN', 'authorizationRef': None} for k, body in bodies.items()],
        'datePolicy': 'Client-date proposal only; if execution is later, re-propose valid dates before sending; no backdating.'})
    writes = [
        {'id': 'W01', 'target': 'ap-southeast-1_hZMX8LpFo', 'actions': ['AdminCreateUser','AdminSetUserPassword','AdminAddUserToGroup'],
            'maximumUsers': 2, 'usernames': [identity['viewerUsername'], identity['provisionerUsername']],
            'groups': ['CustomerViewer','PlatformSuperAdmin'], 'messageAction': 'SUPPRESS', 'sendNotifications': False,
            'secretPolicy': 'Fresh random passwords stored only in mode0600 private workspace; no audit output'},
        {'id': 'W02', 'target': 'users/user_roles/user_scopes', 'actions': ['CREATE_OWN_USERS_AND_EXISTING_V1_ROLE_SCOPE'],
            'maximumUsers': 2, 'authorityClient': 'createPreviewAwarePrismaClient', 'bareSql': False,
            'pristineAdminBootstrapCliAllowed': False, 'executor': 'BOUND_CONTROLLED_VPC_WRITER_REQUIRED'},
        {'id': 'W03', 'target': 'createCustomer/createSite/submitOnboardingRequest/approveOnboardingRequest/assignDevice',
            'serialNumber': prefix, 'maximumCustomers': 1, 'maximumSites': 1, 'maximumDevices': 1,
            'certificateRegistration': 'Only app CSR provisioning worker; no CA private key exported'},
        {'id': 'W04', 'target': 'createLicense/issueLicense + device sync RECEIVED/VERIFIED', 'maximumLicenses': 1,
            'entitlements': ['ESG_REPORTING'], 'activation': 'NORMAL_LICENSE_FLOW_ONLY',
            'verifier': 'EXISTING_DEDICATED_TEST_LICENSE_VERIFIER_IF_AUTHORIZED', 'exportHmacKey': False,
            'manualLifecycleOrOperationalStatusUpdate': False},
        {'id': 'W05', 'target': 'device_live_image_policies', 'maximumDevices': 1, 'deviceId': None,
            'allowedSerialNumber': prefix, 'deviceOptIn': True, 'enableServerPreview': True,
            'authorityClient': 'createPreviewAwarePrismaClient', 'directDynamoDbWrite': False,
            'preconditions': ['CREATED_ID_LEDGER','MATCHING_CUSTOMER','ACTIVE_LIFECYCLE_AND_OPERATION','CURRENT_CERTIFICATE','AUTHORITY_WRITER_VERSION_VERIFIED']},
        {'id': 'W06', 'target': 'fdp-test-qa09-readonly-runner', 'action': 'StartBuild', 'maximumStarts': 1,
            'purpose': 'Native PG READ ONLY migration recheck; CodeBuild control-plane write still needs approval',
            'request': {'projectName': 'fdp-test-qa09-readonly-runner'}, 'buildspecOverrideAllowed': False,
            'projectUpdateAllowed': False, 'sourceCheckRequired': True},
        {'id': 'W07', 'target': 'OWN_RUN_CLEANUP', 'actions': ['DISABLE_OWN_PREVIEW_THROUGH_AUTHORITY','RELEASE_OWN_VIEWER',
                'DISABLE_OWN_COGNITO_IDENTITIES','REVOKE_OWN_DEVICE_CERTIFICATE','REVOKE_OWN_TEST_LICENSE'],
            'preserve': ['CONTROL_AUTH_EPOCH','HISTORICAL_MEDIA_LINKS','RECEIPTS_AND_AUDIT'],
            'bulkDeleteOrLifecycleBackdatingAllowed': False},
    ]
    job_source = json.loads((BASE / 'readonly-db-source.json').read_text())
    writes[5].update({'buildspecOverrideAllowed': True, 'overrideRule': 'EXACT_PINNED_LOCAL_REQUEST_ONLY',
        'requestFile': 'readonly-db-start.request.json', 'requestSha256': job_source['requestSha256'],
        'buildspecSha256': job_source['buildspecSha256'], 'defaultBuildspecBinding': 'BLOCKED_SOURCE_DRIFT',
        'request': None})
    dump('write-approval-request.json', {'formatVersion': 1, 'status': 'PENDING_USER_CONFIRMATION',
        'sourceCommit': inputs['sourceCommit'], 'protocolDigest': inputs['protocolDigest'], 'runId': identity['runId'],
        'target': {'accountId': '065986019555', 'region': 'ap-southeast-1', 'stackName': 'fdp-test-app'},
        'approved': False, 'approvalReference': None, 'executionEnabled': False, 'requestedWrites': writes,
        'notIncluded': ['CLOUD_DEPLOYMENT','TARGET_MIGRATION','IAM_EXPANSION','NEW_SHARED_INFRASTRUCTURE','OTA_OR_REMOTE_CONTROL',
            'EXISTING_DEVICE_USER_MODIFICATION','SHARED_FAULT_INJECTION','THIRD_PARTY_APP','PHYSICAL_DEVICE','GIT_PUSH'],
        'stopConditions': ['SOURCE_OR_ENVIRONMENT_DRIFT','MISSING_EXECUTOR_OR_PERMISSIONS','OUTSIDE_OWN_IDS',
            'UNRESOLVED_PRIOR_WRITE','WINDOW_EXPIRED','LICENSE_VERIFIER_UNAVAILABLE']})
    dump('window-proposal.json', {'runId': identity['runId'], 'timezone': 'Asia/Shanghai', 'clientDate': '2026-11-08',
        'status': 'PENDING_USER_CONFIRMATION', 'approved': False, 'startsAt': None, 'endsAt': None,
        'proposedPreparationWindowMinutes': 90, 'startRule': 'After explicit approval and execution-prerequisite validation, record actual UTC start/end before writes',
        'g4WindowMinutes': 45, 'g4WindowStatus': 'NOT_SCHEDULED', 'g4WritesIncludedInThisRequest': False,
        'requireThirdPartyAppOrPhysicalDevice': False})
    dump('sequence-plan.json', {'runId': identity['runId'], 'status': 'PROPOSED_NOT_RESERVED', 'deviceId': None,
        'proposedFirstSeq': 1, 'proposedLastSeq': 128, 'baselineObserved': False, 'exclusive': False,
        'rule': 'Fresh application-created device only; record real baseline before first heartbeat, then exclusive monotonic sequence state in private workspace; do not reset after reconnect/restart'})
    dump('admission-materials.json', {'sourceCommit': inputs['sourceCommit'], 'protocolDigest': inputs['protocolDigest'],
        'runId': identity['runId'], 'providedTargetInputs': 9, 'stillBlockedInputs': 13,
        'rows': [{'id': key, 'targetValue': None, 'status': 'BLOCKED', 'preparedMaterial':
            ('readonly-observations.json' if key in ['deployedCommit','deploymentProof','runtimeVersionsProof'] else
             'local-identity.json' if key in ['deviceId','customerId','deviceMtlsRef','mqttIdentityRef','viewerARef'] else
             'write-approval-request.json' if key in ['migrationProof','testScopeProof','cleanupPlan'] else
             'window-proposal.json' if key == 'executionWindowProof' else 'sequence-plan.json')} for key in pending],
        'versionReview': {'matchingHistoricalFunctionHashes': 20 if all_matches else 0, 'historicalCommit': obs.get('historicalDeploymentSourceCommit'),
            'exactCandidateDeploymentProof': False, 'sourceEquivalentReviewOnly': True},
        'executorGaps': ['No public server allowlist HTTP API; use existing wrapped internal client in a bound VPC writer',
            'First-admin bootstrap requires pristine users; not permitted on this environment',
            'Dedicated own-user writer identity, runtime/source digest and IAM authorization must be bound before execution',
            'License verifier must be authorized and usable; no manual Active update'],
        'g4': 'NOT_RUN', 'appRequired': False, 'cloudWrites': 0})
    dump('cleanup-plan.json', {'runId': identity['runId'], 'status': 'PLANNED_NOT_EXECUTED',
        'order': ['Disable temporary provisioner after device setup', 'Release owned viewer and disable owned preview via authority client',
            'Revoke only owned certificate/license; disable viewer identity', 'Retain customer/site/device as closed audit fixtures if lifecycle prevents safe deletion'],
        'requiredChecks': ['No active test viewer','No usable run credentials','No enabled run preview','Outside-run resources untouched',
            'CONTROL epoch and historical image associations preserved'], 'actualCreatedIds': [], 'completed': False,
        'noPlainSqlCleanup': True, 'noS3BucketSweep': True})
    names = {'adminApi': 'fdp-test-api', 'deviceApi': 'fdp-test-device-api-handler',
        'ingestion': 'fdp-test-ingestion', 'mediaEvidence': 'fdp-test-media-evidence', 'outbox': 'fdp-test-outbox-publisher'}
    versions = {key: next(v['data']['codeSha256'] for v in obs['functions'] if v['name'] == name and v['status'] == 'OBSERVED')
        for key, name in names.items()}
    for original in sorted((PRIOR / 'proof-drafts').glob('*.json')):
        draft = json.loads(original.read_text())
        draft.update({'runId': identity['runId'], 'passed': False, 'status': 'DRAFT_NOT_EVIDENCE', 'capturedAt': None,
            'pendingUserScopeAndWindowApproval': True, 'requiresFreshInWindowObservation': True})
        if original.stem in ['deploymentProof', 'runtimeVersionsProof']:
            draft['details']['versions'] = versions
            draft['readonlyObservedAt'] = obs['capturedAt']
            draft['historicalArtifactSourceCommit'] = obs['historicalDeploymentSourceCommit']
            draft['sourceEvidence'] = ['readonly-observations.json']
        if original.stem == 'cleanupPlan':
            for key in ['usesResourceLedger','disableThroughAuthorityWriter','preserveControlEpoch','preserveHistoricalLinks','deleteOnlyOwnedKeys']:
                draft['details'][key] = True
            draft['details']['retentionDecision'] = 'Retain closed audit fixture and historical media; never delete CONTROL'
        dump('proof-drafts/' + original.name, draft)
    return {'status': 'PASS_LOCAL_PREPARATION', 'blockedInputs': 13, 'approved': False, 'cloudWrites': 0}


if __name__ == '__main__':
    print(json.dumps(prepare()))
