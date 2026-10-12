import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {validateRuntimeAssemblyPhases} from '../../../../../scripts/qa09-runtime-assembly-proof.mjs';
const dir=dirname(fileURLToPath(import.meta.url)),read=(n)=>JSON.parse(readFileSync(join(dir,n))),source=read('negative-get.json'),linked=read('negative-phases.json');
const demand=(v,m)=>{if(!v)throw Error(m);};
demand(source.gate==='PASS'&&linked.gate==='PASS'&&linked.records.length===12&&linked.bindings.childSha256===createHash('sha256').update(readFileSync(join(dir,'negative-get.json'))).digest('hex'),'NEGATIVE_CLIENT_BINDING');
const rows=[];
for(const c of linked.records){
 const client=source.rows.find(r=>r.gatewayRequestId===c.requestId),g=c.gateway[0],l=c.completion[0],report=c.platformReports[0];
 if(c.boundary==='COGNITO_AUTHORIZER_REJECTED_BEFORE_LAMBDA'){
  demand(client&&client.status===401&&String(g.status)==='401'&&g.errorResponseType==='UNAUTHORIZED'&&['integrationRequestId','integrationStatus','functionStatus'].every(k=>g[k]==='-')&&c.phases.length===0&&c.completion.length===0&&c.platformReports.length===0&&c.exactOwnLambdaLogMatches===0,'GATEWAY_REJECTION_PROOF');
  rows.push({requestId:c.requestId,lambdaRequestId:null,status:401,mode:client.mode,boundary:c.boundary,physicalCold:null,platformReport:null,runtimeAssembly:null});continue;
 }
 demand(client&&client.status===401&&String(g.status)==='401'&&g.integrationRequestId===l.lambdaRequestId&&l.lambdaRequestId===report.lambdaRequestId&&report.memoryMiB===512&&g.extendedRequestId===l.gatewayExtendedRequestId,'NEGATIVE_EXACT_IDS');
 demand(!c.phases.some(p=>p.phase.startsWith('db-')||p.phase.startsWith('admin-account-')),'NEGATIVE_SQL_OR_ENGINE');
 rows.push({requestId:c.requestId,lambdaRequestId:l.lambdaRequestId,status:401,mode:client.mode,physicalCold:Number(report.initDurationMs)>0,platformReport:report,runtimeAssembly:validateRuntimeAssemblyPhases(c.phases)});
}
const result={gate:'PASS',scope:'TWELVE_EXACT_NEGATIVE_GET_NO_ENGINE_OR_SQL',sourceCommit:source.sourceCommit,rows,p95Accepted:false,fullQa09Accepted:false,bindings:Object.fromEntries(['negative-get.json','negative-phases.json'].map(n=>[n,createHash('sha256').update(readFileSync(join(dir,n))).digest('hex')]))};
writeFileSync(join(dir,'negative-gate.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({gate:'PASS',requests:rows.length,runtimeObserved:rows.filter(r=>r.runtimeAssembly!==null).length}));
