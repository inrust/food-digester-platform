// Descriptive original-request windows only; no sampling/unit admission bypass.
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {validateContractLoadDetail} from '../../../../scripts/qa09-contract-load-detail-proof.mjs';
const root=dirname(fileURLToPath(import.meta.url)),p=join(root,'r0'),out=join(p,'r0-observations.json'),bindings={};
const hash=b=>createHash('sha256').update(b).digest('hex');
const read=n=>{const b=readFileSync(join(p,n));bindings[n]=hash(b);return JSON.parse(b);};
const demand=(v,c)=>{if(!v)throw Error(c);};demand(!existsSync(out),'NO_OBSERVATION_OVERWRITE');
const child=read('sample.json'),receipts=['baseline-patch.json','baseline-audit.json','sampling-patch.json','sampling-audit.json'];
demand(child.gate==='FAIL'&&child.cleanupFailure.code==='AWS_batch-get-builds_CLI_FAILED','ORIGINAL_FAILED_CLEANUP_REQUIRED');
const rows=[],detail=[];
for(const name of receipts){const r=read(name);demand(r.gate==='PASS'&&r.sourceReceiptSha256===bindings['sample.json']&&Object.keys(r.logReadErrors).length===0,'EXACT_SOURCE_LOG_BINDING');
 for(const c of r.records){demand(c.exactLinked===true&&c.gateway.length===1&&c.lambda.length===1&&c.platformReports.length===1&&c.gateway[0].integrationRequestId===c.lambda[0].lambdaRequestId&&c.platformReports[0].lambdaRequestId===c.lambda[0].lambdaRequestId,'EXACT_REQUEST_REPORT');
  const row={origin:name,requestId:c.requestId,lambdaRequestId:c.lambda[0].lambdaRequestId,status:c.status,clientMs:c.latencyMs,gatewayMs:Number(c.gateway[0].responseLatency),lambdaMs:c.lambda[0].elapsedMs,platformInitMs:c.platformReports[0].initDurationMs??null,clientTransport:c.clientTransport};rows.push(row);
  if(name.endsWith('patch.json'))detail.push({...row,...validateContractLoadDetail(c.phases,c.contractLoadOwnership,true),ownership:c.contractLoadOwnership[0],parentsMs:Object.fromEntries(c.phases.filter(x=>['contract-load','contract-load-orm-prepare','contract-load-driver-query','admin-account-query'].includes(x.phase)).map(x=>[x.phase,x.durationMs]))});
 }
}
demand(rows.length===55&&detail.length===18,'BOUNDED_ORIGINAL_REQUEST_COUNT');
const phase=read('baseline-phases.json'),cold=read('baseline-cold-phases.json');demand(phase.gate==='PASS'&&cold.gate==='PASS'&&phase.contractLoadDetailRequired===true,'BASELINE_STRICT_DETAIL');
const result={gate:'OBSERVATIONS_ONLY',scope:'ORIGINAL_R0_PUBLIC_PHASE_AND_TRANSPORT_WINDOWS_NO_UNIT_ADMISSION',sourceCommit:child.sourceCommit,prefix:child.prefix,originalExecutionGate:'FAIL',baselineStrictDetailGate:'PASS',samplingBusinessLedger:child.cold409Sampling.gate,samplingStrictGate:'BLOCKED_ORIGINAL_CHILD_FAIL',requestCount:55,patchDetailCount:18,baselinePhysicalCold409:cold.coldConflictObservedCount,cold409Detail:detail.filter(x=>x.status===409&&x.platformInitMs>0),rows,detail,bindings,matchingR1:'NOT_RUN',modelCostShift:'NOT_ESTABLISHED',networkNodeAttribution:'NOT_ESTABLISHED_NO_SECOND_AUTHORIZED_NETWORK',cpuScope:'PROCESS_ALL_THREADS',pgWindowIncludesConnectionWait:true,compilerOnlyAttribution:false,serverExecutionIsolated:false,p95Accepted:false,fullQa09Accepted:false};
writeFileSync(out,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({gate:result.gate,requestCount:55,patchDetailCount:18,cold409Detail:result.cold409Detail.length}));
