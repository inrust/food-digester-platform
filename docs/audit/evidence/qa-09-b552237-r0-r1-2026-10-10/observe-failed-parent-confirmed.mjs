// New read-only observation only after proven pre-StartBuild project-read failure.
import {readFileSync,existsSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {runFixture} from '../../../../scripts/qa09-ten-device-bridge.mjs';
const dir=process.argv[2],p=JSON.parse(readFileSync(dir+'/sample.json.fixtures.json')),c=JSON.parse(readFileSync(dir+'/sample.json'));
const row=p.databaseBuilds.at(-1);
if(p.gate!=='FAIL'||c.gate!=='PASS'||!c.cleanupComplete||p.prefix!==c.prefix||p.sourceCommit!=='b5522378aebca9340a0767b53ed3bab846ffc080'||row.gate!=='FAIL'||row.action!=='observe'||row.buildId||row.failure.code!=='AWS_batch-get-projects_CLI_NETWORK_ERROR'||existsSync(row.receipt+'.started.json'))throw Error('EXACT_PRE_START_READ_FAILURE_REQUIRED');
const failed=JSON.parse(readFileSync(row.receipt)),prep=JSON.parse(readFileSync(row.receipt+'.preparation.json'));
if(failed.gate!=='FAIL'||failed.build||failed.failure.kind!=='PRE_START_OR_MUTATION_FAILURE'||failed.failure.startedBuildMayStillRun!==false||failed.operations.length!==2||failed.operations[0].operation!=='get-caller-identity'||failed.operations[0].result!=='PASS'||failed.operations[1].operation!=='batch-get-projects'||failed.operations[1].result!=='FAIL'||prep.plan.prefix!==p.prefix||prep.plan.action!=='observe')throw Error('PRE_START_OPERATION_LEDGER_REQUIRED');
const first=p.databaseBuilds.find(r=>r.action==='observe'&&r.gate==='PASS'),baseline=JSON.parse(readFileSync(first.receipt));
const out=dir+'/parent-observe-recovered.json';
if(existsSync(out))throw Error('NO_OBSERVATION_REPLAY');
writeFileSync(out+'.entry.json',JSON.stringify({gate:'PASS',scope:'NEW_READ_ONLY_OBSERVATION_AFTER_PROJECT_READ_FAILED_BEFORE_ANY_PROJECT_MUTATION_OR_START',sourceCommit:p.sourceCommit,prefix:p.prefix,originalParentSha256:createHash('sha256').update(readFileSync(dir+'/sample.json.fixtures.json')).digest('hex'),failedAction:row,failedReceiptSha256:createHash('sha256').update(readFileSync(row.receipt)).digest('hex'),preparationSha256:createHash('sha256').update(readFileSync(row.receipt+'.preparation.json')).digest('hex'),unknownStart:false,writes:0},null,2)+'\n');
await runFixture({prefix:p.prefix,devices:p.devices,customers:p.customers,action:'observe',baseline:baseline.result.originalFingerprints},out,console.log);
