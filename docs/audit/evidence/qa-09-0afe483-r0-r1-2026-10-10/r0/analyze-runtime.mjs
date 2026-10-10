import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {validateRuntimeAssemblyPhases} from '../../../../../scripts/qa09-runtime-assembly-proof.mjs';
const dir=dirname(fileURLToPath(import.meta.url)),sha='0afe48384537c8c79ec6ce87276858120b9fd6ef';
const names=['negative-phases.json','initial-phases.json','baseline-patch.json','baseline-audit.json','sampling-patch.json','sampling-audit.json'];
const bindings={},rows=[]; const seen=new Set();
const demand=(v,m)=>{if(!v)throw Error(m);};
for(const name of names){
 const bytes=readFileSync(join(dir,name)),r=JSON.parse(bytes);bindings[name]=createHash('sha256').update(bytes).digest('hex');
 demand(r.gate==='PASS'&&r.sourceCommit===sha,'CORRELATED_RECEIPT_REQUIRED');
 for(const c of r.records){
  const completion=c.completion??c.lambda,gw=c.gateway,report=c.platformReports;
  if(name==='negative-phases.json'&&c.boundary==='COGNITO_AUTHORIZER_REJECTED_BEFORE_LAMBDA'){
   demand(gw.length===1&&String(gw[0].status)==='401'&&gw[0].errorResponseType==='UNAUTHORIZED'&&['integrationRequestId','integrationStatus','functionStatus'].every(k=>gw[0][k]==='-')&&completion.length===0&&report.length===0&&c.phases.length===0&&c.exactOwnLambdaLogMatches===0,'NEGATIVE_GATEWAY_ONLY_BINDING');
   rows.push({requestId:c.requestId,lambdaRequestId:null,status:401,origin:name,boundary:c.boundary,physicalCold:null,platformReport:null,applicationMs:null,gatewayMs:Number(gw[0].responseLatency),runtimeAssembly:null});continue;
  }
  demand(completion.length===1&&gw.length===1&&report.length===1,'EXACT_REPORT_REQUIRED');
  const inv=completion[0].lambdaRequestId;
  demand(inv===gw[0].integrationRequestId&&inv===report[0].lambdaRequestId&&report[0].memoryMiB===512&&gw[0].extendedRequestId===completion[0].gatewayExtendedRequestId&&String(gw[0].status)===String(completion[0].status),'EXACT_GATEWAY_BINDING');
  if(name==='negative-phases.json'){
   demand(String(gw[0].status)==='401'&&!c.phases.some(p=>p.phase.startsWith('db-')||p.phase.startsWith('admin-account-')),'NEGATIVE_SQL_OR_ENGINE');
  }
  if(seen.has(inv))continue;seen.add(inv);
  const proof=validateRuntimeAssemblyPhases(c.phases);
  rows.push({requestId:c.requestId,lambdaRequestId:inv,status:Number(gw[0].status),origin:name,physicalCold:Number(report[0].initDurationMs)>0,platformReport:report[0],applicationMs:completion[0].elapsedMs,gatewayMs:Number(gw[0].responseLatency),runtimeAssembly:proof});
 }
}
const initialized=rows.filter(r=>r.runtimeAssembly!==null),physical=initialized.filter(r=>r.physicalCold);
const result={sourceCommit:sha,gate:'PASS',scope:'EXACT_REQUEST_RUNTIME_ASSEMBLY_AND_NEGATIVE_NO_SQL_PROOF',negativeRequests:12,negativeNoSqlGate:'PASS',runtimeObserved:initialized.length,physicalColdObserved:physical.length,runtimeObservationGate:initialized.length?'PASS':'NOT_OBSERVED',rows,bindings,p95Accepted:false,fullQa09Accepted:false};
writeFileSync(join(dir,'runtime-assembly-analysis.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({gate:result.gate,runtimeObserved:initialized.length,physicalColdObserved:physical.length}));
