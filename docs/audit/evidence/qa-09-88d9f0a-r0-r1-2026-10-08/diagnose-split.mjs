import {readFileSync,writeFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {validateClientSplitPhases} from '../../../../scripts/qa09-client-split-proof.mjs';
const root=dirname(fileURLToPath(import.meta.url)),dir=join(root,'r0'),bindings={},rows=[];
for(const group of ['baseline','sampling']) for(const kind of ['patch','audit']){
 const name=`${group}-${kind}-boundary-corrected.json`,b=readFileSync(join(dir,name)),r=JSON.parse(b);bindings[name]=createHash('sha256').update(b).digest('hex');
 if(r.gate!=='PASS')throw Error('EXACT_CORRECTED_READ_REQUIRED');
 for(const c of r.records){
  const names=['db-client-prepare','db-client-submit','db-client-await-dispatch'],p=Object.fromEntries(names.map(n=>[n,c.phases.find(p=>p.phase===n)]));
  if(names.some(n=>!p[n]))throw Error('REAL_SPLIT_PHASES_REQUIRED');
  const [outer,submit,wait]=names.map(n=>p[n]);let proof,error;
  try{proof=validateClientSplitPhases(c.phases,true);}catch(e){error=e.message;}
  rows.push({id:c.id,requestId:c.requestId,origin:name,lambdaRequestId:c.lambda[0].lambdaRequestId,status:c.status,initDurationMs:c.platformReports[0].initDurationMs??null,gate:error?'FAIL':'PASS',failure:error??null,proof:proof??null,outerMs:outer.durationMs,submitMs:submit.durationMs,awaitDispatchMs:wait.durationMs,partitionResidualMs:outer.durationMs-submit.durationMs-wait.durationMs,startGapMs:Date.parse(submit.startedAt)-Date.parse(outer.startedAt),middleGapMs:Date.parse(wait.startedAt)-Date.parse(submit.completedAt),endGapMs:Date.parse(outer.completedAt)-Date.parse(wait.completedAt),submitBoundary:submit.completionBoundary,processCpuScope:'PROCESS_ALL_THREADS'});
 }
}
if(rows.length!==55||new Set(rows.map(r=>r.lambdaRequestId)).size!==55)throw Error('EXACT_55_REQUESTS_REQUIRED');
const result={gate:rows.some(r=>r.gate==='FAIL')?'FAIL':'PASS',scope:'EXISTING_55_CORRECTED_BOUNDARY_READS_STRICT_CLIENT_SPLIT_ONLY',sourceCommit:'88d9f0a5a734aacf0aef6af69c5a4985baacfe84',requests:55,failed:rows.filter(r=>r.gate==='FAIL').length,allSubmitBoundariesPreserved:rows.every(r=>['CALL_RETURNED','DRIVER_DISPATCH'].includes(r.submitBoundary)),causeAttribution:'GAP_BEFORE_SUBMIT_INCLUDES_CPU_SNAPSHOT_AND_FRAME_SETUP_NOT_ISOLATED_SYSCALL_PROOF',toleranceMs:5,toleranceChanged:false,newBusinessRequests:0,bindings,rows,p95Accepted:false,fullQa09Accepted:false};
writeFileSync(join(root,'client-split-diagnosis.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({gate:result.gate,requests:55,failed:result.failed,allSubmitBoundariesPreserved:result.allSubmitBoundariesPreserved,failures:rows.filter(r=>r.gate==='FAIL')}));
