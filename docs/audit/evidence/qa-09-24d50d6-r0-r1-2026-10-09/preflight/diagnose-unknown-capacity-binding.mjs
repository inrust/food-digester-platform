import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { verifyStartedBuild, STARTED_BUILD_QUERY, readStartedFixtureBuild } from '../../../../../scripts/qa09-started-build-read.mjs';
import { readVerifiedFixtureFrame } from '../../../../../scripts/qa09-db-frame-wait.mjs';
const [originalFile, output] = process.argv.slice(2);
if (!originalFile || !output || existsSync(output)) throw Error('NEW_OUTPUT_REQUIRED');
const bytes = readFileSync(originalFile), original = JSON.parse(bytes);
const prepBytes = readFileSync(originalFile + '.preparation.json'), prep = JSON.parse(prepBytes);
if (original.gate !== 'FAIL' || original.build || original.failure?.kind !== 'START_OUTCOME_UNCONFIRMED' || prep.plan.action !== 'capacity-readonly') throw Error('UNKNOWN_READONLY_START_REQUIRED');
const aws = args => {const q=spawnSync('aws',[...args,'--profile','esgiot-readonly','--region','ap-southeast-1','--output','json','--no-cli-pager','--cli-connect-timeout','15','--cli-read-timeout','15'],{encoding:'utf8',timeout:45000,maxBuffer:16*1024*1024,env:{...process.env,AWS_MAX_ATTEMPTS:'1'}});if(q.status!==0)throw Error('BOUNDED_READ_ONLY_CLI_FAILED');return JSON.parse(q.stdout);};
if (aws(['sts','get-caller-identity']).Account !== '065986019555') throw Error('WRONG_ACCOUNT');
const ids = aws(['codebuild','list-builds-for-project','--project-name',prep.project.name,'--sort-order','DESCENDING','--max-items','5']).ids;
const all=aws(['codebuild','batch-get-builds','--ids',...ids,'--query',STARTED_BUILD_QUERY.replace('builds[0].','builds[].')]);
const started=Date.parse(original.operations.find(x=>x.operation==='start-build').startedAt);
const exactEnv = prep.project.environment.environmentVariables.filter(x=>['QA09_FIXTURE_HASH','QA09_FIXTURE_PLAN_B64'].includes(x.name));
const diagnostic={scope:'UNKNOWN_START_BINDING_DIAGNOSTIC_ONLY',sourceReceiptSha256:createHash('sha256').update(bytes).digest('hex'),scannedCount:all.length,windowCovered:ids.length<5 || Math.min(...all.map(b=>Date.parse(b.startTime)))<=started-120000,candidatesInOriginalWindow:[],exactPlanMatches:0,otherBuildDetailsPersisted:false};
for(const b of all){
 const vars=b.environment?.environmentVariables??[];
 const plan=vars.find(x=>x.name==='QA09_FIXTURE_PLAN_B64')?.value;
 if(plan===exactEnv.find(x=>x.name==='QA09_FIXTURE_PLAN_B64').value)diagnostic.exactPlanMatches++;
 if(Date.parse(b.startTime)>=started-120000 && Date.parse(b.startTime)<=Date.parse(original.finishedAt)+30000)diagnostic.candidatesInOriginalWindow.push({id:b.id,status:b.status,startTime:b.startTime,buildspecMatches:b.buildspec===prep.project.source.buildspec,sourceTypeMatches:b.sourceType==='NO_SOURCE',roleMatches:b.serviceRole===prep.project.serviceRole,vpcMatches:JSON.stringify(b.vpcConfig)===JSON.stringify(prep.project.vpcConfig),sourceHashMatches:vars.find(x=>x.name==='QA09_FIXTURE_HASH')?.value===prep.sourceHash,planBytesMatches:plan===exactEnv.find(x=>x.name==='QA09_FIXTURE_PLAN_B64').value});
}
writeFileSync(output,JSON.stringify(diagnostic,null,2)+'\n');console.log(JSON.stringify(diagnostic));
