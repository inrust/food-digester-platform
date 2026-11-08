import {readFileSync,writeFileSync} from 'node:fs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {validateStoredAssetSha256} from '/Users/anray/Documents/project/hiddenjoyacom/food-digester-platform/scripts/collect-qa09-application-version.mjs';
const exec=promisify(execFile);
const priorBytes=readFileSync('/private/tmp/fdp-image-g4-application-version.json');
const prior=JSON.parse(priorBytes);
if(prior.sourceCommit!=='69c76e1dd508bf6e03dd21992194a8280109cd0a'||prior.lambdaArtifacts.length!==20)throw Error('Unexpected inventory');
const result={mode:'TARGET_CLOUD',syntheticResponsesAllowed:false,sourceCommit:prior.sourceCommit,accountId:prior.accountId,region:prior.region,stackName:prior.stackName,scope:'FIXED_VERSION_S3_FULL_OBJECT_SHA256_AND_CURRENT_LAMBDA',collectedAt:new Date().toISOString(),priorByteAttempt:{sha256:createHash('sha256').update(priorBytes).digest('hex'),status:prior.gate,preserved:true},ci:prior.ci,deployment:prior.pendingDeployment,amplify:prior.amplify,lambdaArtifacts:[],gate:'BLOCKED'};
async function aws(args){ const {stdout}=await exec('aws',[...args,'--profile','esgiot-readonly','--region',prior.region,'--output','json','--no-cli-pager','--cli-connect-timeout','10','--cli-read-timeout','20'],{timeout:45000,maxBuffer:1048576,env:{...process.env,AWS_MAX_ATTEMPTS:'1'}});return JSON.parse(stdout);}
let next=0;
await Promise.all(Array.from({length:4},async()=>{while(next<prior.lambdaArtifacts.length){const item=prior.lambdaArtifacts[next++];const row={name:item.name,s3Bucket:item.s3Bucket,s3Key:item.s3Key,sourceVersion:item.sourceVersion,contentLength:item.contentLength,matches:false};try{
 const [stored,current]=await Promise.all([
 aws(['s3api','get-object-attributes','--bucket',item.s3Bucket,'--key',item.s3Key,'--version-id',item.sourceVersion,'--object-attributes','Checksum','ObjectSize']),
 aws(['lambda','get-function-configuration','--function-name',item.name,'--query','{codeSha256:CodeSha256,revisionId:RevisionId,state:State,lastUpdateStatus:LastUpdateStatus,control:Environment.Variables.LIVE_IMAGE_CONTROL_TABLE,payload:Environment.Variables.LIVE_IMAGE_PAYLOAD_TABLE}'])]);
 if(current.codeSha256!==item.codeSha256||current.revisionId!==item.revisionId)throw Error('LAMBDA_REVISION_DRIFT');
 row.artifactSha256=validateStoredAssetSha256(stored,{versionId:item.sourceVersion,contentLength:item.contentLength,codeSha256:current.codeSha256});
 row.current=current;row.checksum=stored.Checksum;row.matches=current.state==='Active'&&current.lastUpdateStatus==='Successful';
 }catch(e){row.error=e.message?.includes('LAMBDA_REVISION_DRIFT')?'LAMBDA_REVISION_DRIFT':'FIXED_VERSION_SHA256_NOT_VERIFIED';}
 result.lambdaArtifacts.push(row);writeFileSync('/private/tmp/fdp-image-g4-stored-asset-verification.json',JSON.stringify(result,null,2)+'\n');console.log(`${row.matches?'PASS':'BLOCKED'} ${row.name}`);
}}));
result.lambdaArtifacts.sort((a,b)=>a.name.localeCompare(b.name));result.gate=result.lambdaArtifacts.every(x=>x.matches)?'PASS':'BLOCKED';
result.bytesDownloadedLocally=false;result.binding='Successful exact-commit workflow and deployed template asset inventory, followed by fixed S3 VersionId/ObjectSize/FULL_OBJECT SHA256 verification against unchanged current Lambda CodeSha256/revisionId';
writeFileSync('/private/tmp/fdp-image-g4-stored-asset-verification.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({gate:result.gate,count:result.lambdaArtifacts.length}));
