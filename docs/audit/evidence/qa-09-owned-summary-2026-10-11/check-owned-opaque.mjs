// Local API ownership probes only. These explicit async test turns never enter target code.
import assert from 'node:assert/strict';
import {withDataPathTrace, beginContractObserverCost, recordContractObserverBoundary, captureDataPathBoundary, observeContractPublicCall, finishContractObserverCost} from '../../../../packages/observability/src/index.ts';
const rows = [];
withDataPathTrace({gatewayRequestId:'forged',lambdaRequestId:'L-forged',operationId:'updateContract'}, () => {
  const scope = beginContractObserverCost(true, true);
  recordContractObserverBoundary(scope, 'CHECKPOINT', {kind: 'DATA_PATH_BOUNDARY'});
  const value = {};
  assert.strictEqual(observeContractPublicCall(scope, () => value), value);
  finishContractObserverCost(scope, true); finishContractObserverCost(scope, true);
}, row => rows.push(row));
assert.equal(rows.length, 1); assert.equal(rows[0].status, 'FOREIGN_SCOPE');
const concurrent = [];
await Promise.all(['a','b'].map(id => withDataPathTrace({gatewayRequestId:id,lambdaRequestId:'L-'+id,operationId:'updateContract'}, async () => {
  const scope=beginContractObserverCost(true,true);
  for(const point of ['CHECKPOINT','CHECKPOINT_PHASE_READY','CHECKPOINT_RETURN']) recordContractObserverBoundary(scope,point,captureDataPathBoundary());
  await Promise.resolve(); // Test-only independent trace interleave.
  recordContractObserverBoundary(scope,'DRIVER_DISPATCH',captureDataPathBoundary());
  const pending=Promise.resolve(id);
  assert.strictEqual(observeContractPublicCall(scope,()=>pending),pending);
  for(const point of ['ADAPTER_CALL_RETURNED','MODEL_EXTENSION_RESUMED','OPERATION_END']) recordContractObserverBoundary(scope,point,captureDataPathBoundary());
  finishContractObserverCost(scope,true);
  assert.equal(await pending,id);
},row=>concurrent.push(row))));
assert.equal(concurrent.length,2);
for(const row of concurrent) {
  assert.equal(row.status,'COMPLETE'); assert.equal(row.lambdaRequestId,'L-'+row.gatewayRequestId);
  assert.equal(row.foreignOutputs,0); assert.equal(row.schemaVersion,2);
}
console.log(JSON.stringify({gate:'PASS',forgedBoundarySamples:1,concurrentOwners:2,summaryAttempts:3,networkCalls:0,targetEquivalent:false}));
