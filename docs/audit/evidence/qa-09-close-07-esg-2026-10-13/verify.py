"""Verify scoped target receipts and retained history; never turn integrity into QA-09 acceptance."""
import base64, hashlib, json, pathlib, re, subprocess
ROOT=pathlib.Path(__file__).resolve().parent
REPO=ROOT.parents[3]
sha=lambda b:hashlib.sha256(b).hexdigest()
load=lambda p:json.loads((ROOT/p).read_bytes())
version=load('application-version.json')
assert version['gate']=='PASS' and version['sourceCommit']=='ee8f0713cdc5785dbf45e354f1f63723d77e3716'
assert len(version['lambdaArtifacts'])==19 and all(a['matches'] and a['artifactSha256']==a['codeSha256'] for a in version['lambdaArtifacts'])
assert all(r['headSha']==version['sourceCommit'] and r['conclusion']=='success' for r in load('ci-deploy.json')['runs'])
assert load('application-version-before-deploy.json')['gate']=='BLOCKED'
assert all(row['equal'] for row in load('application-input-compatibility.json')['compatibility'])
assert load('entry-session.json')['gate']=='PASS' and load('entry-session-v2.json')['gate']=='PASS' and load('entry-session-v3.json')['gate']=='PASS'
for name in ['api-entry-config.json','api-entry-config-v2.json','api-entry-config-v3.json','api-final-config.json']:
 config=load(name);assert config['gate']=='PASS' and config['sourceCommit']==version['sourceCommit']
 assert config['config']['pool']=='1' and config['config']['memory']==512 and config['concurrency']['ReservedConcurrentExecutions']==12
 assert all(config['config'][k]=='false' for k in ['preconnect','accountReadCandidate','contractLoadDetail','contractPublicBoundaries','contractObserverCost'])
capacity=load('capacity-readonly.json')
assert capacity['gate']=='FAIL' and capacity['failure']['kind']=='PRE_START_OR_MUTATION_FAILURE'
assert not capacity.get('build') and capacity['failure']['startedBuildMayStillRun'] is False
assert all(o['operation']!='start-build' for o in capacity['operations'])
assert load('capacity-independent-plan.json')['originalPlanRestarted'] is False
independent=load('capacity-independent.json');assert independent['gate']=='PASS'
assert independent['result']['transactionReadOnly'] is True and independent['result']['writes']==0
first=load('target.json');first_child=load('target.json.reliability.json');unknown=load('first-audit-start-location.json')
assert first['gate']=='FAIL' and first['cleanupHold']=='UNKNOWN_OR_RUNNING_RELIABILITY_WRITE'
assert first_child['gate']=='FAIL' and first_child['failure']['code']=='BOUNDED_EXACT_ESG_QUERY_REQUIRED'
assert unknown['gate']=='UNKNOWN' and unknown['originalStartGate']=='UNKNOWN' and unknown['restartAllowed'] is False
assert load('first-unknown-readonly-disposition.json')['originalPlanRestarted'] is False
recovery=load('first-cleanup-recovery.json');recovered_final=load('first-recovery-final.json')
assert recovery['gate']=='PASS' and recovery['domain']['gate']=='PASS' and len(recovery['cleanup'])==26
assert recovery['originalPlanRestarted'] is False and recovery['originalReceiptUnmodified'] is True
assert recovered_final['gate']=='PASS_RECOVERED_OWN_EMPTY_UNKNOWN_RETAINED' and recovered_final['originalStartGate']=='UNKNOWN'
assert recovered_final['originalParentSha256']==sha((ROOT/'target.json').read_bytes())
assert recovered_final['recoverySha256']==sha((ROOT/'first-cleanup-recovery.json').read_bytes())
assert len(recovered_final['archives'])==8 and all(a['versions']==a['markers']==0 and not a['truncated'] for a in recovered_final['archives'])
assert len(recovered_final['identities'])==2 and all(i['count']==0 for i in recovered_final['identities'])
assert len(recovered_final['builds'])==8 and all(b['status']=='SUCCEEDED' for b in recovered_final['builds'])
for row in load('target.json.sources.json')['sources']:assert sha(base64.b64decode(row['sourceBase64'],validate=True))==row['sha256']
failed_v2=load('target-v2.json.reliability.json');empty_v2=load('v2-final-readonly.json')
assert failed_v2['gate']=='FAIL' and failed_v2['failure']['code']=='PUBLISHED_ARCHIVE_BINDING_REQUIRED'
assert failed_v2['businessCleanup']=='PASS' and failed_v2['jobs']==[]
assert empty_v2['gate']=='PASS_READONLY_EMPTY_AND_BUILD_TERMINAL' and len(empty_v2['archives'])==8 and empty_v2['exportObjects']==[]
assert all(o['versions']==o['markers']==0 and not o['truncated'] for o in empty_v2['archives'])
assert empty_v2['identities'][0]['count']==0 and all(b['status']=='SUCCEEDED' for b in empty_v2['builds'])
for row in load('target-v2.json.sources.json')['sources']:assert sha(base64.b64decode(row['sourceBase64'],validate=True))==row['sha256']
reassessment=load('v2-retained-frame-reassessment.json')
assert reassessment['gate']=='PASS_REASSESSMENT_ONLY_ORIGINAL_FAIL_RETAINED' and reassessment['originalGatePromoted'] is False
assert reassessment['consistency']['receipts']==32 and reassessment['consistency']['dailyRows']==10
assert reassessment['childSha256']==sha((ROOT/'target-v2.json.reliability.json').read_bytes())
assert reassessment['correctedAssertionSha256']==sha((REPO/'scripts/qa09-esg-closeout.mjs').read_bytes())
assert empty_v2['parentSha256']==sha((ROOT/'target-v2.json').read_bytes())
parent=load('target-v3.json');child=load('target-v3.json.reliability.json');final=load('final-readonly.json')
assert parent['sourceCommit']==child['sourceCommit']==final['sourceCommit']==version['sourceCommit']
assert parent['prefix']==child['prefix']==final['prefix'] and parent['finishedAt'] and not parent.get('cleanupHold')
assert parent['gate']=='PASS' and child['gate']=='PASS_SCOPED_ESG_LEASE_AND_CONSISTENCY'
assert len(parent['checks'])==305 and all(c['result']=='PASS' for c in parent['checks'])
assert len(parent['cleanup'])==15 and all(c['result']=='PASS' for c in parent['cleanup'])
assert child['businessCleanup']=='PASS' and child['fullQa09Accepted'] is False
assert child['versionSha256']==sha((ROOT/'application-version-v3.json').read_bytes())
assert len(child['telemetry'])==20 and len(child['reports'])==2 and all(r['publish']=='PUBACK' and r['knownDuplicatePuback'] for r in child['reports'])
assert child['naturalSchedule']['manualInvocations']==child['sharedWorkerInvocations']==0
assert child['naturalSchedule']['budgetMs']==4500000 and child['naturalSchedule']['observedAt']
assert load('natural-summary-schedule.json')['state']=='ENABLED'
for k in ['consistency','finalConsistency']:
 v=child[k];assert v['gate']=='PASS_REAL_MQTT_DAILY_ARCHIVE_ESG_CONSISTENCY'
 assert v['receipts']==32 and v['telemetrySamples']==20 and v['dailyRows']==10 and v['reportRows']==v['esgSummaryRows']==2
 assert v['sourceAttestation']=='SIMULATED_DEVICE_REPORT_NOT_THIRD_PARTY_VERIFICATION'
assert child['archive']['gate']=='PASS' and child['archive']['result']['archivedMessages']==22
assert child['archive']['result']['allReportsArchived'] is True
assert all(o['manifestMatched'] and re.fullmatch('[a-f0-9]{64}',o['manifestProjectionSha256']) for o in child['archive']['result']['archiveObjects'])
assert child['leaseRecovery']['gate']=='PASS_OWN_EXPIRED_EXPORT_LEASE_RECOVERY'
assert len(child['jobs'])==4 and {j['dataset'] for j in child['jobs']}=={'HOURLY','DAILY','REPORTS','DAILY_SUMMARY'}
assert all(j['csv']['gate']=='PASS_NONEMPTY_CSV_DATABASE_EQUAL' and j['csv']['rowCount']>0 for j in child['jobs'])
assert all(c['result']=='PASS' for c in child['checks'])
assert all(d['lifecycle_status']!='Active' for d in child['finalFrame']['devices'])
assert all(c['result']=='PASS' or c['type']=='identity-refresh-before-cleanup' for c in parent['cleanup'])
assert final['gate']=='PASS_READONLY_EMPTY_AND_BUILD_TERMINAL' and final['businessWrites']==final['iamKmsOrCapacityWrites']==0
assert final['parentSha256']==sha((ROOT/'target-v3.json').read_bytes())
assert len(final['archives'])==8 and len(final['exportObjects'])==4
assert all(o['versions']==o['markers']==0 and not o['truncated'] for o in final['archives']+final['exportObjects'])
assert final['identities'][0]['count']==0 and all(b['status']=='SUCCEEDED' for b in final['builds'])
assert len(final['builds'])==15 and len({b['id'] for b in final['builds']})==15
db= json.loads((REPO/final['databaseReceipt']).read_bytes())
assert db['result']['empty'] is True and db['result']['devices']==db['result']['certificates']==db['result']['onboardingRequests']==[]
assert final['databaseSha256']==sha((REPO/final['databaseReceipt']).read_bytes())
final_version=load('final-application-version.json')
assert final_version['gate']=='PASS' and final_version['sourceCommit']==version['sourceCommit']
assert {a['name']:a['codeSha256'] for a in version['lambdaArtifacts']}=={a['name']:a['codeSha256'] for a in final_version['lambdaArtifacts']}
assessment=load('esg-assessment.json')
assert assessment['gate']=='PASS_RECOMPUTED_SCOPED_ESG_AND_LEASE' and assessment['sourceCommit']==parent['sourceCommit'] and assessment['prefix']==parent['prefix']
assert assessment['consistency']==child['finalConsistency'] and assessment['lease']==child['leaseRecovery']
assert len(assessment['exports'])==4 and all(j['rowCount']>0 and j['gate']=='PASS_NONEMPTY_CSV_DATABASE_EQUAL' for j in assessment['exports'])
assert assessment['fullQa09Accepted'] is False
mapping=load('formal-map.json')
assert mapping['gate']=='PARTIAL_FORMAL_MAPPING_ONLY' and mapping['formalPassCount']==0 and mapping['formalRequiredCount']==8
assert len(mapping['results'])==8 and all(r['exitCode']==1 and r['cloudRequests']==0 for r in mapping['results'])
for row in mapping['results']:assert sha((REPO/row['validator']).read_bytes())==row['validatorSha256']
assert mapping['actualEnvironment']['isolated'] is False and mapping['fullQa09Accepted'] is mapping['formalAccepted'] is mapping['productionReady'] is False
assert len(mapping['candidates'])==5 and all(r['gate']=='SCOPED_CANDIDATE_REQUIRES_FORMAL_ASSEMBLY' for r in mapping['candidates'])
assert mapping['historicalReliability']['originalGate']=='PARTIAL' and mapping['historicalReliability']['directSendGate']=='BLOCKED_PERMISSION_NO_RETRY'
for ref in mapping['bindings']:assert sha((REPO/ref['path']).read_bytes())==ref['sha256'],ref['path']
old=ROOT.parent/'qa-09-close-07-2026-10-13';seal=json.loads((old/'manifest.json').read_bytes())
assert {str(p.relative_to(old)):sha(p.read_bytes()) for p in old.rglob('*') if p.is_file() and p.name!='manifest.json'}==seal['files']
for path,wanted in seal['bindings'].items():
 assert sha(subprocess.check_output(['git','show','ee8f0713cdc5785dbf45e354f1f63723d77e3716:'+path],cwd=REPO))==wanted,path
frozen=load('target-v3.json.sources.json');assert len(frozen['sources'])==27
for row in frozen['sources']:
 assert sha(base64.b64decode(row['sourceBase64'],validate=True))==row['sha256']==sha((REPO/row['path']).read_bytes()),row['path']
assert parent['executorSha256']==next(row['sha256'] for row in frozen['sources'] if row['path']=='scripts/run-qa09-ten-device-acceptance.mjs')
tests=load('test-source-bindings.json')
raw_whitespace=load('raw-evidence-whitespace.json')
assert raw_whitespace['gate']=='EXPECTED_RAW_BYTE_WHITESPACE_ONLY' and raw_whitespace['originalBytesChanged'] is False
assert raw_whitespace['fullCachedCheckExitCode']==2 and raw_whitespace['codeAndDocumentationCheckExitCode']==0
for p in ROOT.glob('*.csv'):assert b'\r\n' in p.read_bytes()
assert tests['gate']=='PASS_LOCAL_TEST_SOURCE_BINDINGS_ONLY' and tests['targetFrozenDependencies']==27
assert {r['passed'] for r in tests['testLogs']}=={1336,7}
for path,wanted in tests['bindings'].items():assert sha((REPO/path).read_bytes())==wanted,path
for row in tests['testLogs']:
 assert sha((ROOT/row['path']).read_bytes())==row['sha256']
 log=(ROOT/row['path']).read_text();assert 'ℹ pass '+str(row['passed']) in log and 'ℹ fail 0' in log
scanned=0
def scan(value):
 global scanned
 if isinstance(value,dict):
  for key,item in value.items():
   if key in ['sourceBase64','handlerSourceBase64']:
    decoded=base64.b64decode(item,validate=True).decode();scan(decoded);scanned+=1
   else:scan(item)
 elif isinstance(value,list):
  for item in value:scan(item)
 elif isinstance(value,str):
  assert not re.search(r'\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\bghp_[A-Za-z0-9]{36}\b|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\beyJ[A-Za-z0-9_-]{30,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}|https?://[^\s"\x27<>]*[?&]X-Amz-Signature=',value),'SECRET_VALUE_DETECTED'
for p in ROOT.rglob('*.json'):scan(json.loads(p.read_bytes()))
if (ROOT/'manifest.json').exists():
 manifest=load('manifest.json')
 assert {str(p.relative_to(ROOT)):sha(p.read_bytes()) for p in ROOT.rglob('*') if p.is_file() and p.name!='manifest.json'}==manifest['files']
 for path,wanted in manifest['bindings'].items():assert sha((REPO/path).read_bytes())==wanted,path
print(json.dumps({'gate':'PASS_INTEGRITY_ONLY','scopedBusinessGate':child['gate'],'qa09Gate':'PARTIAL','formalPassCount':0,'frozenSources':27,'decodedSourcesScanned':scanned,'originalFailuresAndUnknownsPreserved':True}))
