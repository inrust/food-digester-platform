"""Assemble truthful preparation proofs; never promotes the preparation window to G4 authorization."""
import hashlib
import json
from pathlib import Path

ROOT=Path(__file__).resolve().parents[5]
BASE=Path(__file__).resolve().parents[1]
PREP=ROOT/'docs/audit/evidence/2026-11-08-device-image-fixture-preparation'


def dump(name,value):
    p=BASE/name;p.parent.mkdir(parents=True,exist_ok=True);p.write_text(json.dumps(value,indent=2)+'\n')


def main():
    inputs=json.loads((PREP/'inputs.json').read_text())
    window=json.loads((BASE/'approved-preparation-window.json').read_text())
    db=json.loads((BASE/'database-verification.json').read_text())
    src=json.loads((PREP/'readonly-db-source.json').read_text())
    post=json.loads((BASE/'postflight.json').read_text())
    assert db['status']=='PASS_NATIVE_READ_ONLY_PREPARATION' and db['businessDataWrites'] is False
    assert post['status']=='PASS_NO_OWN_COGNITO_IDENTITIES' and post['ownedCustomerDeviceCertificateIds']==[]
    environment={k:inputs['entries'][k]['value'] for k in ['accountId','region','stackName']}
    def proof(name,details,captured,source,extra=None):
        value={'mode':'TARGET_CLOUD','profile':inputs['profile'],'sourceCommit':inputs['sourceCommit'],
            'protocolDigest':inputs['protocolDigest'],'runId':inputs['runId'],**environment,
            'syntheticResponsesAllowed':False,'inputId':name,'passed':True,'capturedAt':captured,
            'details':details,'sourceEvidence':source,'evidenceScope':'APPROVED_PREPARATION_ONLY',
            'g4ExecutionProven':False,'requiresG4WindowRecheck':True,**(extra or {})}
        path='proofs/'+name+'.json';dump(path,value)
        raw=(BASE/path).read_bytes();inputs['entries'][name]['value']={'path':path,'sha256':hashlib.sha256(raw).hexdigest()}
    proof('migrationProof',{'schemaSha256':src['manifest']['schemaSha256'],
        'appliedMigrations':[r['name'] for r in src['manifest']['migrations']],'pendingMigrations':[]},
        db['snapshotAt'],['database-verification.json','database-snapshot.json'],
        {'validationScope':'44 applied migration checksums and 61 table existence; not a full schema introspection diff'})
    proof('cleanupPlan',{'usesResourceLedger':True,'disableThroughAuthorityWriter':True,'preserveControlEpoch':True,
        'preserveHistoricalLinks':True,'deleteOnlyOwnedKeys':True,
        'retentionDecision':'Retain audit/receipts/CONTROL and historical links; no business resources were created in this execution'},
        window['startsAt'],['approved-preparation-window.json','postflight.json'],
        {'planApprovalOnly':True,'actualBusinessCleanupRequired':False})
    assert inputs['entries']['testScopeProof']['value'] is None and inputs['entries']['executionWindowProof']['value'] is None
    dump('inputs.json',inputs)
    dump('owned-resource-ledger.json',{'runId':inputs['runId'],'businessResources':[],
        'codebuildBuilds':[{'buildId':db['buildId'],'status':'SUCCEEDED','retention':'AUDIT_HISTORY_RETAINED'}],
        'cognitoUsersCreated':0,'customerDeviceCertificateIdsCreated':[], 'serverAllowlistWrites':0,
        'businessCleanup':'NOT_REQUIRED_NO_OWN_BUSINESS_RESOURCES_CREATED','localPrivateKey':'RETAINED_OUTSIDE_REPOSITORY_MODE_0600',
        'g4CleanupEvidence':False})
    reasons={
        'deployedCommit':'EXACT_CANDIDATE_DEPLOYMENT_NOT_PROVEN_SOURCE_EQUIVALENCE_REVIEW_ONLY',
        'deploymentProof':'CURRENT_HASHES_MATCH_HISTORICAL_69_NOT_EXACT_D1_DEPLOYMENT_PROOF',
        'runtimeVersionsProof':'EXACT_CANDIDATE_AUTHORITY_WRITER_BINDING_NOT_PROVEN',
        'deviceId':'NOT_CREATED_NO_COMPATIBLE_EXISTING_BOUND_WRITER',
        'customerId':'NOT_CREATED_NO_COMPATIBLE_EXISTING_BOUND_WRITER',
        'deviceMtlsRef':'NO_DEVICE_OR_CERTIFICATE_ISSUED',
        'mqttIdentityRef':'NO_DEVICE_OR_CERTIFICATE_ISSUED',
        'viewerARef':'NO_COGNITO_OR_DATABASE_VIEWER_CREATED_TO_AVOID_ORPHAN_PRIVILEGED_USERS',
        'testScopeProof':'G4_CF_CASE_WRITES_EXCLUDED_BY_THIS_USER_DIRECTIVE_AND_IDS_UNAVAILABLE',
        'executionWindowProof':'90_MINUTE_WINDOW_IS_PREPARATION_ONLY_G4_WRITES_EXCLUDED',
        'sequenceReservation':'NO_ACTUAL_DEVICE_BASELINE_NO_RESERVATION',
    }
    dump('input-status.json',{'provided':11,'blockedOrIntentionallyExcluded':11,
        'newPreparationProofs':['migrationProof','cleanupPlan'],
        'remaining':[{'id':k,'reason':reason,'status':'NOT_AUTHORIZED_FOR_G4_IN_THIS_BATCH' if k in ['testScopeProof','executionWindowProof'] else 'BLOCKED'} for k,reason in reasons.items()],
        'note':'Preparation proof fields are structurally provided, not G4 acceptance. Fresh G4-window observations remain necessary.'})
    steps={
        'W01':{'status':'NOT_RUN','reason':'Avoid orphan Cognito identities while required DB writer is unavailable'},
        'W02':{'status':'BLOCKED','reason':'No compatible existing single-device createPreviewAwarePrismaClient VPC executor; legacy ten-device fixture uses raw SQL and a different prefix'},
        'W03':{'status':'NOT_RUN','reason':'No provisioner DB actor or own customer/device; no onboarding request submitted'},
        'W04':{'status':'BLOCKED','reason':'Dedicated license verifier IAM role NoSuchEntity; existing local verifier rejects img21 serial/model; no role creation, expansion, scope forgery or manual Active transition'},
        'W05':{'status':'NOT_RUN','reason':'No own Active device, current certificate or compliant authority writer; no opt-in/allowlist write'},
        'W06':{'status':'PASS_NATIVE_READ_ONLY','buildId':db['buildId'],'startCalls':1,'databaseBusinessWrites':False},
        'W07':{'status':'NOT_REQUIRED','reason':'No business fixtures/identities/allowlist/leases created. Build audit retained; planned Cognito identities confirmed ABSENT'},
    }
    dump('execution-steps.json',{'runId':inputs['runId'],'approvedScope':'W01-W07','steps':steps,
        'scopeApprovalPersisted':True,'requestApprovalAgainForSameScope':False,
        'newDeploymentMigrationOrIamExpansionPerformed':False,'g4':'NOT_RUN'})
    print(json.dumps({'provided':11,'remaining':11,'W06':'PASS_NATIVE_READ_ONLY','g4':'NOT_RUN'}))


if __name__=='__main__':main()
