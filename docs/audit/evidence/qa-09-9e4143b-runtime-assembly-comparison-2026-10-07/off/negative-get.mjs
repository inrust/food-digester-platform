import {readFileSync,writeFileSync} from 'node:fs';
import {randomUUID,createHash} from 'node:crypto';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {observedHttpsFetch} from '../../../../../scripts/qa09-https-transport.mjs';
const dir=dirname(fileURLToPath(import.meta.url));
const version=JSON.parse(readFileSync(join(dir,'application-version.json')));
if(version.gate!=='PASS'||version.sourceCommit!=='9e4143b5144a8aa10692927084256c225d5dd6d4')throw Error('VERSION_REQUIRED');
const rows=[];
const receipt={sourceCommit:version.sourceCommit,scope:'BOUNDED_NEGATIVE_GET_ONLY',gate:'RUNNING',startedAt:new Date().toISOString(),budget:{requests:12,maxConcurrency:6,deadlineMs:20000},rows,fullQa09Accepted:false,p95Accepted:false};
const save=()=>writeFileSync(join(dir,'negative-get.json'),JSON.stringify(receipt,null,2)+'\n');save();
for(let i=0;i<12;i++){
 const requestId=randomUUID(),startedAt=new Date().toISOString(),start=performance.now(),timing={};
 const mode=i<6?'anonymous':'invalid-jwt';
 const row={id:'negative-'+(i+1),requestId,startedAt,mode};
 try {
  const r=await observedHttpsFetch('https://api.bio-nexa.com/api/v1/admin/contracts',{method:'GET',headers:{Accept:'application/json','x-amzn-RequestId':requestId,...(mode==='invalid-jwt'?{Authorization:'Bearer qa09.invalid.signature'}:{})},signal:AbortSignal.timeout(20000),rejectUnauthorized:true},timing);
  row.status=r.status;row.gatewayRequestId=r.headers.get('x-amzn-requestid');row.gatewayExtendedRequestId=r.headers.get('x-amz-apigw-id');await r.json();row.responseReceived=true;
 }catch(e){row.failure=e.code&&/^[A-Z_0-9]+$/.test(e.code)?e.code:'TRANSPORT_FAILED';}
 row.latencyMs=Math.round(performance.now()-start);row.clientTransport=timing;rows.push(row);save();
}
receipt.finishedAt=new Date().toISOString();receipt.gate=rows.length===12&&rows.every(r=>r.status===401&&r.responseReceived&&r.clientTransport.phase==='COMPLETE')?'PASS':'PARTIAL';
receipt.executorSha256=createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex');save();console.log(JSON.stringify({gate:receipt.gate,requests:rows.length}));process.exitCode=receipt.gate==='PASS'?0:1;
