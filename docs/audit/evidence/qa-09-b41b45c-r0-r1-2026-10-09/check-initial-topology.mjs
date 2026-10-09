import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {validateAuthenticatedPreconnectPhases} from '../../../../scripts/qa09-authenticated-preconnect-proof.mjs';
const mode=process.argv[2];if(!['r0','r1'].includes(mode))throw Error('MODE');
const dir=join(dirname(fileURLToPath(import.meta.url)),mode),bindings={},rows=[];const seen=new Set();
const demand=(v,m)=>{if(!v)throw Error(m);};
for(const name of ['initial-phases.json','baseline-patch.json','baseline-audit.json','sampling-patch.json','sampling-audit.json']){
 const b=readFileSync(join(dir,name)),v=JSON.parse(b);bindings[name]=createHash('sha256').update(b).digest('hex');demand(v.gate==='PASS'&&v.sourceCommit==='b41b45c891eeb5adabc69c1fdaea2b0e81acdf1e','CORRELATED_SOURCE');
 for(const c of v.records){const completed=c.completion??c.lambda;demand(completed.length===1&&c.gateway.length===1&&c.platformReports.length===1,'EXACT_REQUEST');const invocation=completed[0].lambdaRequestId;demand(c.gateway[0].integrationRequestId===invocation&&c.platformReports[0].lambdaRequestId===invocation,'EXACT_INVOCATION');if(seen.has(invocation))continue;seen.add(invocation);
 const proof=validateAuthenticatedPreconnectPhases(c.phases,mode!=='restore');rows.push({requestId:c.requestId,lambdaRequestId:invocation,origin:name,status:Number(c.gateway[0].status),physicalCold:Number(c.platformReports[0].initDurationMs)>0,topology:proof,preconnect:c.phases.find(p=>p.phase==='db-authenticated-preconnect')??null,engine:c.phases.find(p=>p.phase==='db-engine-prepare')??null,accountQuery:c.phases.find(p=>p.phase==='admin-account-query')??null,firstQuery:c.phases.find(p=>p.phase==='db-first-query')??null,firstConnection:c.phases.find(p=>p.phase==='db-first-connection')??null});}
}
const observed=rows.filter(r=>r.topology!==null).length;if(mode!=='restore')demand(observed>0,'C1_ACTUAL_SETTLEMENT_OBSERVATION_REQUIRED');
const result={gate:'PASS',scope:'ALL_OWN_CORRELATED_INITIAL_AND_BUSINESS_PRECONNECT_TOPOLOGY_ONLY',sourceCommit:'b41b45c891eeb5adabc69c1fdaea2b0e81acdf1e',mode,observed,requests:rows.length,warmAbsentIsNull:true,causalBenefit:'NOT_ESTABLISHED',p95Accepted:false,bindings,rows};
writeFileSync(join(dir,'initial-topology-gate.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({gate:result.gate,mode,observed,requests:rows.length}));
