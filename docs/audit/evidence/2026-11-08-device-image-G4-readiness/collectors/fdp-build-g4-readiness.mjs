import {readFileSync,writeFileSync,mkdirSync,copyFileSync} from 'node:fs';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {inputTemplate,receiptTemplate,admission,CANDIDATE,protocolDigest,sha} from '/Users/anray/Documents/project/hiddenjoyacom/food-digester-platform/scripts/device-image-target-package.mjs';
const root='/Users/anray/Documents/project/hiddenjoyacom/food-digester-platform';
const relative='docs/audit/evidence/2026-11-08-device-image-G4-readiness';
const dir=join(root,relative);mkdirSync(join(dir,'proofs'),{recursive:true});mkdirSync(join(dir,'observations'),{recursive:true});
const files={
 'db-before.json':'/private/tmp/fdp-image-g4-db-snapshot.json','db-after.json':'/private/tmp/fdp-image-g4-postmigration-snapshot.json',
 'db-before-start.json':'/private/tmp/fdp-image-g4-db-start.json','db-after-start.json':'/private/tmp/fdp-image-g4-postmigration-start.json',
 'migration-start.json':'/private/tmp/fdp-image-g4-migration-start.json','migration-upload.json':'/private/tmp/fdp-image-g4-migration-upload.json','migration-build.json':'/private/tmp/fdp-image-g4-migration-build.json','migration-result.json':'/private/tmp/fdp-image-g4-migration-result-frames.json',
 'asset-bytes-failed.json':'/private/tmp/fdp-image-g4-application-version.json','asset-full-object-sha256.json':'/private/tmp/fdp-image-g4-stored-asset-verification.json','public-probes.json':'/private/tmp/fdp-image-g4-public-probes.json','identity-counts.json':'/private/tmp/fdp-image-g4-identity-counts.json','dynamodb.json':'/private/tmp/fdp-image-g4-dynamodb-config.json','stack.json':'/private/tmp/fdp-image-g4-stack.json','resources.json':'/private/tmp/fdp-image-g4-resources.json','mqtt-endpoint.json':'/private/tmp/fdp-image-g4-mqtt-endpoint.json','web-version.json':'/private/tmp/fdp-image-g4-web-version.json'};
for(const [name,path]of Object.entries(files))copyFileSync(path,join(dir,'observations',name));
const load=name=>JSON.parse(readFileSync(join(dir,'observations',name)));
const assets=load('asset-full-object-sha256.json');if(assets.gate!=='PASS'||assets.lambdaArtifacts.length!==20||assets.lambdaArtifacts.some(x=>!x.matches))throw Error('Asset gate not complete');
const outputs=Object.fromEntries(load('stack.json').Outputs.map(x=>[x.OutputKey,x.OutputValue]));
const input=inputTemplate();
const text={accountId:'065986019555',region:'ap-southeast-1',stackName:'fdp-test-app',adminBaseUrl:outputs.AdminApiUrl.replace(/\/$/,''),deviceBaseUrl:outputs.DeviceApiUrl.replace(/\/$/,'')+'/api/v1',webOrigin:outputs.AdminWebOrigin,mqttEndpoint:load('mqtt-endpoint.json').endpointAddress,deployedCommit:CANDIDATE,controlTable:'fdp-test-live-image-control',payloadTable:'fdp-test-live-image-payload',archiveBucket:outputs.MediaBucketName};
for(const [id,value]of Object.entries(text))input.entries[id].value=value;
const names={adminApi:'fdp-test-api',deviceApi:'fdp-test-device-api-handler',ingestion:'fdp-test-ingestion',mediaEvidence:'fdp-test-media-evidence',outbox:'fdp-test-outbox-publisher'};
const versions=Object.fromEntries(Object.entries(names).map(([key,name])=>[key,assets.lambdaArtifacts.find(x=>x.name===name).current.codeSha256]));
const authorities=assets.lambdaArtifacts.filter(x=>x.name!=='fdp-test-archive');if(authorities.length!==19||authorities.some(x=>x.current.control!==text.controlTable||x.current.payload!==text.payloadTable))throw Error('Authority environment mismatch');
const db=load('db-after.json').snapshot;const old=load('db-before.json').snapshot;const expected=JSON.parse(readFileSync(join(root,'docs/audit/evidence/2026-11-08-device-image-G3-rebind-69c76e1d/gates/fdp-core-api-integration-gate.json')));
const {readdirSync}=await import('node:fs');
const migrations=readdirSync(join(root,'packages/database/prisma/migrations')).filter(x=>/^\d{14}_/u.test(x)).sort();
const applied=db.migrations.filter(x=>x.finished_at&&!x.rolled_back_at);
const missing=migrations.filter(name=>!applied.some(x=>x.migration_name===name));
const mismatched=migrations.filter(name=>applied.some(x=>x.migration_name===name&&x.checksum!==sha(readFileSync(join(root,'packages/database/prisma/migrations',name,'migration.sql')))));
const unresolved=db.migrations.filter(x=>!x.finished_at&&!x.rolled_back_at);
if(missing.length||mismatched.length||unresolved.length||applied.length!==44||db.identity.read_only!=='on')throw Error('Native migration revalidation failed');
const before=old.preservationFingerprints,after=db.preservationFingerprints;
const changed=Object.keys(before).filter(t=>JSON.stringify(before[t])!==JSON.stringify(after[t]));
const added=Object.keys(after).filter(t=>!Object.hasOwn(before,t)).sort();
const migrationComparison={status:'PASS',sourceCommit:CANDIDATE,expected:44,applied:44,missing,mismatched,unresolved,addedTables:added,changedExistingTables:changed,allOtherExistingFingerprintsPreserved:changed.every(x=>x==='_prisma_migrations'),legacyProbeManifestGate:load('db-after.json').migrationGate,legacyProbeManifestGateScope:'Historical 40-migration expected list only; complete native rows compared with current 44 here'};
writeFileSync(join(dir,'migration-comparison.json'),JSON.stringify(migrationComparison,null,2)+'\n');
const proof=(id,details,sourceEvidence)=>{
 const value={mode:'TARGET_CLOUD',syntheticResponsesAllowed:false,sourceCommit:CANDIDATE,accountId:text.accountId,region:text.region,stackName:text.stackName,inputId:id,passed:true,details,sourceEvidence};
 const path=`proofs/${id}.json`;const bytes=Buffer.from(JSON.stringify(value,null,2)+'\n');writeFileSync(join(dir,path),bytes);input.entries[id].value={path,sha256:sha(bytes)};
};
proof('deploymentProof',{deployedSourceCommit:CANDIDATE,versions},['observations/asset-full-object-sha256.json','observations/web-version.json']);
proof('runtimeVersionsProof',{versions,LIVE_IMAGE_CONTROL_TABLE:text.controlTable,LIVE_IMAGE_PAYLOAD_TABLE:text.payloadTable,allAuthorityWritersOnCandidate:true},['observations/asset-full-object-sha256.json','observations/dynamodb.json']);
proof('migrationProof',{schemaSha256:sha(readFileSync(join(root,'packages/database/prisma/schema.prisma'))),appliedMigrations:migrations,pendingMigrations:[]},['migration-comparison.json','observations/db-after.json','observations/migration-result.json']);
writeFileSync(join(dir,'inputs.json'),JSON.stringify(input,null,2)+'\n');
const result=admission(input,path=>readFileSync(join(dir,path)));
writeFileSync(join(dir,'admission.json'),JSON.stringify(result,null,2)+'\n');
writeFileSync(join(dir,'receipt.json'),JSON.stringify(receiptTemplate(),null,2)+'\n');
const summary={sourceCommit:CANDIDATE,protocolDigest:protocolDigest(),scope:'REAL_TARGET_PREREQUISITES_ONLY',g3:'PASS_LOCAL',readiness:result.status,g4:'NOT_RUN',completeBusinessCases:0,totalBusinessCases:44,prerequisites:{deployment:'PASS_FIXED_VERSION_FULL_OBJECT_SHA256',migrations:'PASS_NATIVE_44_CHECKSUMS',dynamodb:'PASS_CONFIGURATION_ONLY',publicEntry:'OBSERVED_PREFLIGHT_AND_UNAUTHENTICATED_REJECTION_ONLY'},missingInputs:result.blocked,performance:'BLOCKED_USER_CONFIRMED_NO_ACCEPTANCE_TARGETS',businessFixturesCreated:false,deviceWhitelistEnabled:false,sharedFaultsInjected:false,longWindowStarted:false};
writeFileSync(join(dir,'result.json'),JSON.stringify(summary,null,2)+'\n');
console.log(JSON.stringify({readiness:result.status,missing:result.blocked.length,filled:Object.values(input.entries).filter(x=>x.value!==null).length,g4:'NOT_RUN'}));
