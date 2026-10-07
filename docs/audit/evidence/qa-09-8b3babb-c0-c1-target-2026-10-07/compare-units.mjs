import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {validateEngineInputPair} from '../../../../scripts/record-qa09-deployment-inputs.mjs';
const dir=dirname(fileURLToPath(import.meta.url)),bindings={};
const demand=(v,m)=>{if(!v)throw Error(m);};
const read=(p)=>{const b=readFileSync(join(dir,p));bindings[p]=createHash('sha256').update(b).digest('hex');return JSON.parse(b);};
const inputs=validateEngineInputPair(read('c0/qa09-deployment-inputs.json'),read('c1/qa09-deployment-inputs.json'), {preconnect:true});
const modes={};
for(const mode of ['c0','c1']){
 const version=read(mode+'/application-version.json'),target=read(mode+'/target-summary.json'),runtime=read(mode+'/runtime-assembly-analysis.json'),provenance=read(mode+'/deployment-input-binding.json'),config=read(mode+'/api-config.json'),final=read(mode+'/api-final-config.json'),capacity=read(mode+'/api-concurrency.json'),finalCapacity=read(mode+'/api-final-concurrency.json');
 demand(version.gate==='PASS'&&version.lambdaArtifacts.length===19&&target.businessGate==='PASS'&&target.cleanup==='PASS'&&runtime.gate==='PASS'&&runtime.negativeNoSqlGate==='PASS'&&provenance.gate==='PASS'&&provenance.runId===(mode==='c0'?inputs.offRunId:inputs.onRunId),'UNIT_GATES_REQUIRED');
 demand(JSON.stringify(config)===JSON.stringify(final)&&JSON.stringify(capacity)===JSON.stringify(finalCapacity),'UNIT_CONFIG_DRIFT');
 const closure=read(mode+'/unit-completion.json');
 demand(closure.gate==='PASS'&&closure.sourceCommit===version.sourceCommit&&closure.runId===provenance.runId&&closure.prefix===target.prefix,'ACTUAL_UNIT_CLOSURE_REQUIRED');
 for(const [name,expected] of Object.entries(closure.bindings))demand(createHash('sha256').update(readFileSync(join(dir,mode,name))).digest('hex')===expected,'UNIT_CLOSURE_BYTE_DRIFT');
 const records=[];
 for(const group of ['baseline-patch','baseline-audit','sampling-patch','sampling-audit'])for(const c of read(mode+'/'+group+'.json').records){
  const p=(name)=>c.phases.find(p=>p.phase===name);
  records.push({requestId:c.requestId,status:c.status,clientMs:c.latencyMs,gatewayMs:Number(c.gateway[0].responseLatency),applicationMs:c.lambda[0].elapsedMs,platformReport:c.platformReports[0],clientTransport:c.clientTransport,preconnect:p('db-authenticated-preconnect')??null,engine:p('db-engine-prepare')??null,afterAdapter:p('db-engine-after-adapter')??null,modelPrepare:p('db-client-prepare')??null,accountQuery:p('admin-account-query')??null,firstQuery:p('db-first-query')??null,firstConnection:p('db-first-connection')??null,accountHook:p('admin-account-hook')??null});
 }
 modes[mode]={sourceCommit:version.sourceCommit,runId:provenance.runId,config,capacity,version,targetGate:target.gate,prefix:target.prefix,runtimeInitialization:runtime.rows.filter(r=>r.runtimeAssembly!==null),negativeNoSqlGate:runtime.negativeNoSqlGate,businessChecks:target.businessChecks,cleanup:target.cleanup,baselineCold:target.baselineColdConflictGate,samplingCold:target.samplingColdConflictGate,records};
}
demand(modes.c0.sourceCommit===modes.c1.sourceCommit&&modes.c0.prefix!==modes.c1.prefix,'SOURCE_AND_DISTINCT_PREFIX_REQUIRED');
for(const a of modes.c0.version.lambdaArtifacts){const b=modes.c1.version.lambdaArtifacts.find(b=>b.name===a.name);demand(b&&a.matches&&b.matches&&['codeSha256','artifactSha256','s3Key','s3Bucket','runtime'].every(k=>a[k]===b[k]),'CROSS_MODE_ZIP_OR_SOURCE_DRIFT');if(a.name!=='fdp-test-api')demand(a.revisionId===b.revisionId,'UNCONTROLLED_NON_API_REVISION_DRIFT');}
for(const key of ['envName','pool','memory','state','update','parallelSecrets'])demand(modes.c0.config[key]===modes.c1.config[key],'CROSS_MODE_BUDGET_OR_CONFIG_DRIFT');
demand(modes.c0.config.engineCpu==='true'&&modes.c1.config.engineCpu==='true'&&modes.c0.config.preconnect==='false'&&modes.c1.config.preconnect==='true'&&modes.c0.capacity.ReservedConcurrentExecutions===12&&modes.c1.capacity.ReservedConcurrentExecutions===12,'EFFECTIVE_MODE_OR_CAPACITY');
for(const mode of ['c0','c1'])delete modes[mode].version;
const result={gate:'PARTIAL',scope:'SAME_SHA_C0_C1_BOUNDED_DESCRIPTIVE_COMPARISON',sourceCommit:inputs.sourceCommit,inputPairGate:inputs.gate,targetVersionPairGate:'PASS',businessPairGate:'PASS',cleanupPairGate:'PASS',runtimeAssemblyPairGate:['c0','c1'].every(m=>modes[m].runtimeInitialization.length>0)?'PASS':'NOT_OBSERVED',negativeNoSqlPairGate:'PASS',budget:{pool:1,memoryMiB:512,reserved:12,connections:63,maxConnections:70},modes,bindings,fullQa09Accepted:false,p95Accepted:false,candidate:'DEFAULT_OFF_TARGET_BENEFIT_NOT_ESTABLISHED',candidateImplemented:true,candidateTargetBenefit:'NOT_ESTABLISHED',causalBenefit:'NOT_ESTABLISHED_NATURAL_COLD_SAMPLES_NOT_MATCHED_OR_P95'};
writeFileSync(join(dir,'comparison.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({gate:result.gate,inputPairGate:inputs.gate,targetVersionPairGate:result.targetVersionPairGate,businessPairGate:result.businessPairGate,cleanupPairGate:result.cleanupPairGate}));
