"""Bind actual receipts; never upgrade partial scopes to full QA-09 acceptance."""
import base64, collections, datetime, hashlib, json, math, pathlib
BASE = pathlib.Path('docs/audit/evidence')
bindings = []
def read(name):
    path = BASE / name
    raw = path.read_bytes()
    bindings.append({'path': str(path), 'sha256': hashlib.sha256(raw).hexdigest()})
    return json.loads(raw)
def demand(ok, code):
    if not ok: raise ValueError(code)
def capsule(name):
    obj = read(name)
    for entry in obj['sources']:
        demand(hashlib.sha256(base64.b64decode(entry['sourceBase64'])).hexdigest() == entry['sha256'], 'FROZEN_BYTES_HASH_MISMATCH')
    return obj

def slo_scope(samples, field, limit):
    complete = len(samples) == 20 and all(x.get(field) is True and isinstance(x.get('latencyMs'), (int,float)) and x['latencyMs'] >= 0 for x in samples)
    values = sorted(x['latencyMs'] for x in samples if isinstance(x.get('latencyMs'), (int,float)) and x['latencyMs'] >= 0)
    value = values[math.ceil(.95*len(values))-1] if values and complete else None
    return {'gate': 'PASS' if complete and value <= limit else 'FAIL', 'samples':len(samples), 'completedSamples':sum(x.get(field) is True for x in samples), 'p95Ms':value, 'limitMs':limit, 'fullBusinessClaimed':False}

def collect(output):
    old = read('qa-09-performance-target-2026-10-03.json')
    old_parent = read('qa-09-performance-target-2026-10-03.json.devices.json')
    old_sources = capsule('qa-09-performance-target-2026-10-03.json.sources.json')
    provenance = read('qa-09-performance-source-provenance-2026-10-03.json')
    demand(provenance['entrypointSnapshotSha256'] == next(x['sha256'] for x in bindings if x['path'] == provenance['entrypointSnapshot']), 'OLD_PRIMARY_SOURCE_UNBOUND')
    recovered = read('qa-09-performance-target-2026-10-03.json.observe-7.recovered.json')
    frozen_db = next(x['sha256'] for x in old_sources['sources'] if x['path'] == 'scripts/qa09-ten-device-db.mjs')
    demand(recovered['gate']=='PASS' and recovered['result']['prefix']==old['prefix'] and recovered['result']['sourceHash']==frozen_db and recovered['build']['status']=='SUCCEEDED', 'OLD_OBSERVATION_UNBOUND')
    frame = recovered['result']
    demand(len(frame['receipts'])==950 and all(x['result']=='PROCESSED' for x in frame['receipts']), 'REAL_INGESTION_NOT_PROVED')
    demand(len(frame['telemetrySamples'])==10 and all(str(x['samples'])=='92' for x in frame['telemetrySamples']), 'PER_DEVICE_SAMPLES_NOT_PROVED')
    ledger_path = BASE / 'qa-09-performance-target-2026-10-03.json.mqtt-publisher.ndjson'
    ledger_bytes = ledger_path.read_bytes();bindings.append({'path':str(ledger_path),'sha256':hashlib.sha256(ledger_bytes).hexdigest()})
    ledger = [json.loads(x) for x in ledger_bytes.splitlines()]
    attempts = [x for x in ledger if x['event']=='publish-attempt']
    acks = [x for x in ledger if x['event']=='puback']
    ackcounts = collections.Counter((x['messageId'],x['bodySha256']) for x in acks)
    demand(ackcounts==collections.Counter((x['messageId'],x['bodySha256']) for x in attempts), 'PUBACK_LEDGER_UNBOUND')
    unique = {(x['messageId'],x['bodySha256']) for x in attempts}
    burst = [x for x in attempts if x['stage']=='burst']
    times = [datetime.datetime.fromisoformat(x['startedAt']) for x in burst]
    span = (max(times)-min(times)).total_seconds()
    demand(len({x['messageId'] for x in burst})==300 and len(unique)==920, 'ACTUAL_RATE_LEDGER_MISSING')
    old_cleanup = read('qa-09-performance-cleanup-recovery-attempt5-2026-10-03.json')
    empty = read('qa-09-performance-audit-empty-2026-10-03.json')
    domain = read('qa-09-performance-domain-cleanup-2026-10-03.json')
    demand(old_cleanup['prefix']==old['prefix'] and old_cleanup['finishedAt'] and len(old_cleanup['cleanup'])==25 and all(x['result']=='PASS' for x in old_cleanup['cleanup']), 'OLD_CLEANUP_LEDGER_INCOMPLETE')
    demand(empty['gate']=='PASS' and empty['result']['empty'] and empty['result']['prefix']==old['prefix'] and empty['result']['originalFingerprints']==frame['originalFingerprints'], 'OLD_INDEPENDENT_DB_AUDIT_MISSING')
    demand(domain['gate']=='PASS' and domain['prefix']==old['prefix'] and all(x['versionsRemaining']==0 for x in domain['observations']), 'OLD_DOMAIN_CLEANUP_MISSING')
    new = read('qa-09-slo-target-2026-10-03.json')
    parent = read('qa-09-slo-target-2026-10-03.json.devices.json')
    sources = capsule('qa-09-slo-target-2026-10-03.json.sources.json')
    source_hashes = {x['path']:x['sha256'] for x in sources['sources']}
    version = read('qa-09-slo-application-version-refresh-2026-10-03.json')
    demand(version['gate']=='PASS' and len(version['lambdaArtifacts'])==19 and all(x['matches'] for x in version['lambdaArtifacts']), 'CURRENT_VERSION_NOT_PROVED')
    demand(new['prefix']==parent['prefix'] and new['prefix']!=old['prefix'] and new['sourceCommit']==version['sourceCommit']==old['sourceCommit'], 'SOURCE_OR_PREFIX_DRIFT')
    demand(parent['executorSha256']==source_hashes['scripts/run-qa09-ten-device-acceptance.mjs'], 'NEW_EXECUTOR_UNBOUND')
    demand(new.get('finishedAt') and parent.get('finishedAt') and new['cleanup'] and all(x['result']=='PASS' for x in new['cleanup']) and parent['cleanup'] and all(x['result']=='PASS' for x in parent['cleanup']), 'NEW_CLEANUP_INCOMPLETE')
    for b in new['databaseBuilds']+parent['databaseBuilds']:
        proof=read(pathlib.Path(b['receipt']).name)
        demand(proof['gate']=='PASS' and proof['build']['id']==b['buildId'] and proof['result']['prefix']==new['prefix'] and proof['sourceHash']==source_hashes['scripts/qa09-ten-device-db.mjs'], 'NEW_DATABASE_BUILD_UNBOUND')
    new_domain=read('qa-09-slo-target-2026-10-03.json.domain-cleanup.json')
    demand(new_domain['gate']=='PASS' and all(x['versionsRemaining']==0 for x in new_domain['observations']), 'NEW_DOMAIN_CLEANUP_MISSING')
    cloud=read('qa-09-slo-cloud-cleanup-verification-2026-10-03.json')
    demand(cloud['gate']=='PASS' and cloud['prefix']==new['prefix'] and len(cloud['checks'])==20 and cloud['parentReceiptSha256']==next(x['sha256'] for x in bindings if x['path'].endswith('qa-09-slo-target-2026-10-03.json.devices.json')), 'NEW_INDEPENDENT_CLOUD_ABSENCE_MISSING')
    slo = read('qa-09-slo-target-2026-10-03.json.slo.json')
    auth = read('qa-09-slo-target-2026-10-03.json.auth-repro.json')
    for x in auth['sources']: demand(x['sha256']==source_hashes[x['path']], 'AUTH_PROBE_SOURCE_UNBOUND')
    demand(len(auth['cleanup'])==2 and all(x['result']=='PASS' for x in auth['cleanup']), 'AUTH_IDENTITIES_NOT_CLEANED')
    browser=read('qa-09-slo-target-2026-10-03.json.online-browser.json')
    demand(browser['sourceHash']==source_hashes['scripts/qa09-online-browser-guards.mjs'], 'BROWSER_SOURCE_UNBOUND')
    confirmation=read('qa-09-slo-target-2026-10-03.json.device-confirmation.json')
    survey=read('qa-09-performance-prototype-survey-attempt3-2026-10-03.json')
    matrix=json.loads(pathlib.Path('contracts/prototype-traceability.yaml').read_bytes())
    positive=[e['id'] for p in matrix['pages'] for e in p['elements'] if e['disposition'] in ['Adopt','Adapt']]
    survey_pass={e['id'] for p in survey['pages'] for e in p['elements'] if e['behaviorGate']=='PASS'}
    guards={c['id'] for c in browser['cases'] if all(any(x['id']==c['id'] and x['width']==w and x['result']=='PASS' for x in browser['cases']) for w in [375,1440])}
    behavior=[{'id':eid,'guardSubscopeGate':'PASS' if eid in survey_pass or eid in guards else 'NOT_RUN','fullSuccessFailureRecoveryBusinessJourneyGate':'NOT_PROVEN'} for eid in positive]
    demand(len(positive)==117, 'PROTOTYPE_INVENTORY_DRIFT')
    current=read('qa-09-performance-current-http-diagnostic-2026-10-03.json')
    capacity=read('qa-09-performance-capacity-evaluation-2026-10-03.json')
    formal=read('qa-09-performance-formal-gates-2026-10-03.json')
    keepalive=slo.get('keepalive',{});demand(keepalive.get('intervalMs')==30000 and keepalive.get('published',0)>=3 and not keepalive.get('failures'), 'CONTINUOUS_ONLINE_PRECONDITION_NOT_PROVED')
    http=[x for x in old['checks'] if x.get('stage')=='httpLoad']
    role_rows=old['writeBoundaries']['rows'];missing=[x for x in role_rows if x['result']!='PASS']
    denial_repro=[x for x in auth['checks'] if x.get('operationId') in ['activateContract','processConsumableRequest']]
    r={'task':'QA-09','scope':'BOUND_REAL_DIAGNOSTIC_RATE_SLO_AND_PARTIAL_COVERAGE','collectedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'sourceCommit':version['sourceCommit'],'gate':'PARTIAL','fullQa09Accepted':False,
       'stages':{'httpLoad':{'gate':'FAIL','requests':len(http),'http500':sum(x.get('status')==500 for x in http),'requestIds':[x['requestId'] for x in http if x.get('status')==500],'planned300RequestsCompleted':False},
                 'perRequestThrottleCorrelation':{'gate':current['requestCorrelationGate'],'sharedLoggingApplied':False},
                 'mqttActualRate':{'gate':'PASS' if span<=10 else 'FAIL','uniqueBurst':300,'burstAttempts':len(burst),'burstPublishSpanSeconds':span,'burstLimitSeconds':10,'stageActualPublishSpans':{stage:{'attempts':len([x for x in attempts if x['stage']==stage]),'uniqueMessages':len({x['messageId'] for x in attempts if x['stage']==stage}),'spanSeconds':(max(datetime.datetime.fromisoformat(x['startedAt']) for x in attempts if x['stage']==stage)-min(datetime.datetime.fromisoformat(x['startedAt']) for x in attempts if x['stage']==stage)).total_seconds()} for stage in ['normal','history','burst']},'attempts':len(attempts),'pubacks':len(acks),'uniqueProcessedReceipts':950,'samplesPerDevice':92,'fullProfileExecuted':False,'newRateArchiveOriginalBytesGate':'NOT_RUN'},
                 'telemetryApiVisibility':slo_scope(slo['telemetry'],'visible',5000),'onlineCommandBrokerReceipt':slo_scope(slo['commands'],'received',3000),
                 'writePermissionBoundaries':{'originalRows':len(role_rows),'originalFailedRows':missing,'freshDenialRepro':denial_repro,'validWritesAllExecuted':False},
                 'forgedClaimsDenial':{'gate':auth['denialGate'],'strict401ContractGate':auth['strict401ContractGate'],'correctlySignedClaimValidationProved':False},
                 'lifecycle':{'deviceConfirmationGate':confirmation['gate'],'preconditionMode':new.get('lifecycleFixture',{}).get('fixtureMode'),'naturalJourneyGate':new.get('naturalLifecycleGate'),'actualChecks':[x for x in new['checks'] if 'lifecycle' in x['id'] or 'mtls' in x['id'] or 'retired' in x['id']]},
                 'browser':{'guardGate':browser['gate'],'cases':len(browser['cases']),'positiveBindings':117,'coveredGuardBindings':sum(x['guardSubscopeGate']=='PASS' for x in behavior),'full117BehaviorGate':'NOT_PROVEN','inventory':behavior},
                 'queueRedelivery':{'primaryProbe':slo.get('queueRedelivery',{'gate':'NOT_RUN_FIRST_MARKER_NOT_VISIBLE'}),'localArchiveAttempt':read('qa-09-slo-owned-archive-redelivery-2026-10-03.json'),'awsOwnedArchiveAttempt':read('qa-09-slo-aws-archive-redelivery-2026-10-03.json')},'capacityPlanning':capacity['candidates']},
       'cleanup':{'gate':'PASS','oldOriginalParentGatePreserved':old_parent['gate'],'oldOriginalRecoveryGatePreserved':old_cleanup['gate'],'oldPrefix':old['prefix'],'oldRawVersionsDeleted':next(x['count'] for x in old_cleanup['cleanup'] if x['type']=='archive-batch-owned-prefix'),'oldDomainVersionsDeleted':len(domain['deleted']),'newPrefix':new['prefix'],'newParentGate':parent['gate'],'newScopeGate':new['gate'],'newIndependentCloudAbsenceGate':cloud['gate'],'newDomainVersionsDeleted':len(new_domain['deleted'])},
       'formalTargetGates':formal['gate'],'remainingCoverage':['Per-request Gateway integration linkage and authorized shared observability deployment','HTTP300/10-concurrency capacity acceptance','Natural Assigned to Licensed to Active runtime path and72h timeout','All valid writes and full business browser success/failure/recovery journeys','117 complete semantic behavior acceptance and narrow viewport overflow remediation','Complete security cases including correctly signed claims and media/OTA','Exact queue consumption/redelivery linkage and full reliability profile'],
       'collectorSourceSha256':hashlib.sha256(pathlib.Path(__file__).read_bytes()).hexdigest(),'bindings':bindings}
    pathlib.Path(output).write_text(json.dumps(r,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps({'gate':r['gate'],'telemetry':r['stages']['telemetryApiVisibility'],'command':r['stages']['onlineCommandBrokerReceipt'],'fullQa09Accepted':False}))
    return r
if __name__=='__main__':
    import sys
    collect(sys.argv[1])
