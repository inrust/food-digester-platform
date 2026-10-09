import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fixtureAws } from '../../../../../scripts/qa09-ten-device-bridge.mjs';
import { verifyStartedBuild, STARTED_BUILD_QUERY, readStartedFixtureBuild } from '../../../../../scripts/qa09-started-build-read.mjs';
import { readVerifiedFixtureFrame } from '../../../../../scripts/qa09-db-frame-wait.mjs';
const [originalFile, output] = process.argv.slice(2);
if (!originalFile || !output || existsSync(output)) throw Error('NEW_OUTPUT_REQUIRED');
const bytes = readFileSync(originalFile), original = JSON.parse(bytes);
const prepBytes = readFileSync(originalFile + '.preparation.json'), prep = JSON.parse(prepBytes);
if (original.gate !== 'FAIL' || original.build || original.failure?.kind !== 'START_OUTCOME_UNCONFIRMED' || prep.plan.action !== 'capacity-readonly') throw Error('UNKNOWN_READONLY_START_REQUIRED');
const aws = (args) => fixtureAws(args, 'esgiot-readonly');
if (aws(['sts','get-caller-identity']).Account !== '065986019555') throw Error('WRONG_ACCOUNT');
const ids = aws(['codebuild','list-builds-for-project','--project-name',prep.project.name,'--sort-order','DESCENDING','--max-items','20']).ids;
const matches = [];
let oldest = Infinity;
for (const id of ids) {
  const b = aws(['codebuild','batch-get-builds','--ids',id,'--query',STARTED_BUILD_QUERY]);
  oldest = Math.min(oldest, Date.parse(b.startTime));
  try { verifyStartedBuild(b,prep,id); matches.push(b); } catch (e) { if (e.message !== 'FIXTURE_BUILD_BINDING_MISMATCH') throw e; }
}
const started = Date.parse(original.operations.find(x => x.operation === 'start-build').startedAt);
if (ids.length >= 20 && oldest > started - 120000) throw Error('RECENT_WINDOW_INCOMPLETE');
if (matches.length !== 1 || Date.parse(matches[0].startTime) < started-120000 || Date.parse(matches[0].startTime) > Date.parse(original.finishedAt)+30000) throw Error('UNIQUE_EXACT_STARTED_BUILD_REQUIRED');
const observations = [];
const result = {gate:'RUNNING',scope:'EXACT_UNKNOWN_READ_ONLY_START_RESOLUTION_NO_RESTART',originalGate:original.gate,originalReceiptSha256:createHash('sha256').update(bytes).digest('hex'),preparationSha256:createHash('sha256').update(prepBytes).digest('hex'),buildId:matches[0].id,scannedCount:ids.length,otherBuildDetailsPersisted:false,writes:0,buildReadObservations:observations};
const save = () => writeFileSync(output,JSON.stringify(result,null,2)+'\n');
save();
const read = await readStartedFixtureBuild(prep,matches[0].id,id => aws(['codebuild','batch-get-builds','--ids',id,'--query',STARTED_BUILD_QUERY]),{maxPolls:6,timeoutMs:90000,observations,onObservation:save});
const b = read.build;
const frame = await readVerifiedFixtureFrame(() => aws(['logs','get-log-events','--log-group-name',b.logs.groupName,'--log-stream-name',b.logs.streamName,'--start-from-head']),{buildId:b.id,sourceHash:prep.sourceHash,prefix:prep.plan.prefix,action:prep.plan.action});
delete b.buildspec; delete b.environment;
Object.assign(result,{gate:'PASS',build:b,result:frame.frame,readGate:read.readGate,originalReadGate:read.originalReadGate,resultReadObservations:frame.observations,finishedAt:new Date().toISOString()});
save();
console.log(JSON.stringify({gate:result.gate,buildId:result.buildId,action:result.result.action,writes:0}));
