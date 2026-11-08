import { exactKeys, isHash, isUuid, jsonHash, requireThat } from './contracts.js';
import type { Binding, BoundManifest } from './contracts.js';
export interface BindingReceipt {
  runId: string;
  manifestHash: string;
  status: 'COMMITTED';
  action: 'BIND_DEVICE';
  operationId: string;
  requestHash: string;
  binding: Binding;
  sourceRef: string;
}
export function validatePhaseB(
  writer: BoundManifest,
  receipt: BindingReceipt,
  deviceId: string,
  previousAssetSha256: string,
  currentAssetSha256: string,
) {
  exactKeys(receipt, [
    'runId',
    'manifestHash',
    'status',
    'action',
    'operationId',
    'requestHash',
    'binding',
    'sourceRef',
  ]);
  exactKeys(receipt.binding, ['deviceId', 'customerId', 'siteId', 'certificateFingerprint', 'certificateId']);
  requireThat(
    receipt.runId === writer.manifest.runId &&
      receipt.manifestHash === writer.hash &&
      receipt.status === 'COMMITTED' &&
      receipt.action === 'BIND_DEVICE' &&
      isHash(receipt.operationId) &&
      isHash(receipt.requestHash) &&
      receipt.sourceRef.length > 0 &&
      [receipt.binding.deviceId, receipt.binding.customerId, receipt.binding.siteId].every(isUuid) &&
      isHash(receipt.binding.certificateFingerprint) &&
      !!receipt.binding.certificateId &&
      receipt.binding.deviceId === deviceId &&
      isHash(previousAssetSha256) &&
      previousAssetSha256 === currentAssetSha256,
    'PHASE_B_IMMUTABLE_BINDING_REQUIRED',
  );
  return jsonHash(receipt.binding);
}
