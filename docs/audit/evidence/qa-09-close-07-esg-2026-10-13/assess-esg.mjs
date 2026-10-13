import { URL } from 'node:url';
import console from 'node:console';
import {readFileSync,writeFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {assertConsistency,assertCsvDatabase,assertLeaseRecovery} from '../../../../scripts/qa09-esg-closeout.mjs';
import {sha256} from '../../../../scripts/qa09-reliability-closeout.mjs';
const root=new URL('./',import.meta.url),read=p=>JSON.parse(readFileSync(new URL(p,root)));
const parent=read('target-v3.json'),child=read('target-v3.json.reliability.json'),frames=[];
assert.equal(child.gate,'PASS_SCOPED_ESG_LEASE_AND_CONSISTENCY');
const frame=child.finalFrame;
const consistency=assertConsistency(frame,child.telemetry,child.reports,parent.devices,parent.customers);
for(const b of child.builds.filter(b=>b.action==='consistency-observe')){
 const v=JSON.parse(readFileSync(b.receipt));assert.equal(v.gate,'PASS');assert.equal(v.build.status,'SUCCEEDED');
 assert.equal(v.result.prefix,parent.prefix);assert.equal(v.result.action,'consistency-observe');
 assert.equal(v.sourceHash,v.result.sourceHash);assert.equal(sha256(readFileSync(b.receipt)),b.sha256);frames.push(v.result);
}
const exports=child.jobs.map(j=>{
 const text=readFileSync(new URL('target-v3.json.'+j.dataset.toLowerCase()+'.csv',root),'utf8');
 const proof=assertCsvDatabase(text,j.dataset,frame,parent.devices[0],parent.customers[0].id);
 assert.deepEqual(proof,j.csv);return {id:j.id,dataset:j.dataset,...proof};
});
const hourly=child.jobs.find(j=>j.dataset==='HOURLY');
const snapshots=frames.flatMap(f=>f.exports.filter(j=>j.id===hourly.id));
assert.ok(snapshots.length>=2);
const first=readFileSync(new URL('target-v3.json.hourly.csv',root),'utf8'),second=readFileSync(new URL('target-v3.json.hourly-recovered.csv',root),'utf8');
const lease=assertLeaseRecovery(snapshots[0],child.leaseInjection,snapshots.find(j=>Date.parse(j.completed_at)>Date.parse(snapshots[0].completed_at)),first,second);
assert.deepEqual(lease,child.leaseRecovery);
const result={gate:'PASS_RECOMPUTED_SCOPED_ESG_AND_LEASE',consistency,exports,lease,fullQa09Accepted:false,
 sourceCommit:parent.sourceCommit,prefix:parent.prefix};
writeFileSync(new URL('esg-assessment.json',root),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
