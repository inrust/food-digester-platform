// New read-only observation only after proven pre-StartBuild project-read failure.
import {readFileSync,existsSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {runFixture} from '../../../../scripts/qa09-ten-device-bridge.mjs';
const dir=process.argv[2],p=JSON.parse(readFileSync(dir+'/sample.json.fixtures.json')),c=JSON.parse(readFileSync(dir+'/sample.json'));
const row=p.databaseBuilds.at(-1);
if(p.gate!=='FAIL'||c.gate!=='PASS'||!c.cleanupComplete||p.prefix!==c.prefix||p.sourceCommit!=='b5522378aebca9340a0767b53ed3bab846ffc080'||row.gate!=='FAIL'||row.action!=='observe'||row.buildId||row.failure.code!=='AWS_batch-get-projects_CLI_NETWORK_ERROR'||['', '.preparation.json','.started.json'].some(s=>existsSync(row.receipt+s)))throw Error('EXACT_PRE_START_READ_FAILURE_REQUIRED');
const first=p.databaseBuilds.find(r=>r.action==='observe'&&r.gate==='PASS'),baseline=JSON.parse(readFileSync(first.receipt));
const out=dir+'/parent-observe-recovered.json';
if(existsSync(out))throw Error('NO_OBSERVATION_REPLAY');
writeFileSync(out+'.entry.json',JSON.stringify({gate:'PASS',scope:'NEW_READ_ONLY_OBSERVATION_AFTER_PROJECT_READ_FAILED_BEFORE_PREPARATION_OR_START',sourceCommit:p.sourceCommit,prefix:p.prefix,originalParentSha256:createHash('sha256').update(readFileSync(dir+'/sample.json.fixtures.json')).digest('hex'),failedAction:row,unknownStart:false,writes:0},null,2)+'\n');
await runFixture({prefix:p.prefix,devices:p.devices,customers:p.customers,action:'observe',baseline:baseline.result.originalFingerprints},out,console.log);
