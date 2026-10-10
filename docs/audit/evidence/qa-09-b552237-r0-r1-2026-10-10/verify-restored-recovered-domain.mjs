import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {closedDomainPrefixes,validateDomainVersions} from '../../../../scripts/qa09-owned-domain-cleanup.mjs';
const root=dirname(fileURLToPath(import.meta.url)),out=join(root,'restore/owned-domain-readonly.json'),bindings={};
const read=n=>{const b=readFileSync(join(root,n));bindings[n]=createHash('sha256').update(b).digest('hex');return JSON.parse(b);};
if(existsSync(out))throw Error('NO_READ_RECEIPT_OVERWRITE');
const restored=read('restore/restore-completion.json'),original=read('r0/sample.json.fixtures.json'),closed=read('r0/parent-cleanup-recovery.json.domain-parent-snapshot.json'),recovery=read('r0/cleanup-only-completion.json'),domain=read('r0/parent-cleanup-recovery.json.domain-cleanup.json');
if(restored.gate!=='PASS'||original.gate!=='FAIL'||closed.gate!=='PASS'||recovery.gate!=='PASS'||recovery.originalExecutionGate!=='FAIL'||recovery.cleanup!=='PASS'||restored.sourceCommit!==closed.sourceCommit||domain.parentReceiptSha256!==bindings['r0/parent-cleanup-recovery.json.domain-parent-snapshot.json'])throw Error('EXACT_RECOVERED_RESTORED_R0_CLEANUP_REQUIRED');
const prefixes=closedDomainPrefixes(closed),observations=[];
for(const prefix of prefixes){
 const q=spawnSync('aws',['s3api','list-object-versions','--bucket','fdp-test-raw-065986019555','--prefix',prefix,'--no-paginate','--profile','esgiot-readonly','--region','ap-southeast-1','--output','json','--no-cli-pager'],{encoding:'utf8',timeout:60000,maxBuffer:8*1024*1024});
 if(q.status!==0)throw Error('OWN_DOMAIN_READ_FAILED');const page=JSON.parse(q.stdout);if(page.IsTruncated)throw Error('OWN_DOMAIN_PAGE_LIMIT');const versions=validateDomainVersions([...(page.Versions??[]),...(page.DeleteMarkers??[])],[prefix]);observations.push({prefix,versionsRemaining:versions.length});if(versions.length)throw Error('OWN_DOMAIN_NOT_EMPTY');
}
const result={gate:'PASS',scope:'RESTORED_EXACT_COMPENSATING_R0_CUSTOMER_DOMAIN_EMPTY_READ_ONLY_ORIGINAL_FAIL_PRESERVED',sourceCommit:restored.sourceCommit,prefix:closed.prefix,runId:restored.runId,originalR0Gate:'FAIL',r1Gate:'NOT_RUN',observations,writes:0,newBusinessRequests:0,bindings,checkedAt:new Date().toISOString(),p95Accepted:false,fullQa09Accepted:false};
writeFileSync(out,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({gate:'PASS',prefixCount:prefixes.length,writes:0}));
