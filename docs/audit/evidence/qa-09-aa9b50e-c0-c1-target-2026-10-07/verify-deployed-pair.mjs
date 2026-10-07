import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {validateEngineInputPair} from '../../../../scripts/record-qa09-deployment-inputs.mjs';
const root=dirname(fileURLToPath(import.meta.url)),bindings={};const read=f=>{const b=readFileSync(join(root,f));bindings[f]=createHash('sha256').update(b).digest('hex');return JSON.parse(b);};const demand=(v,m)=>{if(!v)throw Error(m);};
const inputs=validateEngineInputPair(read('c0/qa09-deployment-inputs.json'),read('c1/qa09-deployment-inputs.json'),{preconnect:true});
const v0=read('c0/application-version.json'),v1=read('c1/application-version.json'),c0=read('c0/api-config.json'),c1=read('c1/api-config.json');
for(const v of [v0,v1])demand(v.gate==='PASS'&&v.sourceCommit===inputs.sourceCommit&&v.lambdaArtifacts.length===19,'ACTUAL_19_REQUIRED');
for(const a of v0.lambdaArtifacts){const b=v1.lambdaArtifacts.find(b=>b.name===a.name);demand(b&&a.matches&&b.matches&&['codeSha256','artifactSha256','s3Key','s3Bucket','runtime'].every(k=>a[k]===b[k]),'ZIP_DRIFT');if(a.name!=='fdp-test-api')demand(a.revisionId===b.revisionId,'NON_API_REVISION_DRIFT');}
for(const k of ['memory','pool','envName','state','update','parallelSecrets'])demand(c0[k]===c1[k],'BUDGET_OR_CONFIG_DRIFT');
demand(c0.preconnect==='false'&&c1.preconnect==='true'&&c0.engineCpu==='true'&&c1.engineCpu==='true'&&c0.memory===512&&c0.pool==='1','ACTUAL_FLAGS');
for(const mode of ['c0','c1']){demand(read(mode+'/api-concurrency.json').ReservedConcurrentExecutions===12,'RESERVED_BUDGET');demand(read(mode+'/deployment-input-binding.json').gate==='PASS','ACTUAL_MANUAL_PROVENANCE');}
const result={gate:'PASS',scope:'SAME_SHA_ACTUAL_C0_C1_DEPLOYMENTS_AND_19_IDENTICAL_BYTES_ONLY',sourceCommit:inputs.sourceCommit,c0RunId:inputs.offRunId,c1RunId:inputs.onRunId,lambdaCount:19,authenticatedPreconnect:[false,true],budget:{pool:1,memoryMiB:512,reserved:12},c1Business:'NOT_EVALUATED',p95Accepted:false,fullQa09Accepted:false,bindings};writeFileSync(join(root,'deployed-pair-gate.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({gate:result.gate,scope:result.scope}));
