import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const doc = JSON.parse(
  readFileSync(new URL('./device-sync-configuration-delivery-candidate.openapi.json', import.meta.url), 'utf8'),
);
const legacy = JSON.parse(readFileSync(new URL('../rest/device-sync-api.json', import.meta.url), 'utf8'));

test('R19 the candidate delegates legacy Sync fields to the frozen contract', () => {
  const { SyncRequest, DeviceSyncSnapshot } = doc.components.schemas;
  for (const name of ['lastSyncTime', 'licenseConfirmation']) {
    assert.equal(
      SyncRequest.properties[name].$ref,
      '../rest/device-sync-api.json#/components/schemas/SyncRequest/properties/' + name,
    );
  }
  assert.deepEqual(DeviceSyncSnapshot.required, legacy.components.schemas.DeviceSyncSnapshot.required);
  assert.ok(!Object.hasOwn(legacy.components.schemas.DeviceSyncSnapshot.properties, 'configurationDelivery'));
  for (const name of Object.keys(legacy.components.schemas.DeviceSyncSnapshot.properties)) {
    assert.equal(
      DeviceSyncSnapshot.properties[name].$ref,
      '../rest/device-sync-api.json#/components/schemas/DeviceSyncSnapshot/properties/' + name,
    );
  }
});

test('R19 configuration delivery uses the closed DEC-018 payload and receipt tuple', () => {
  const { SyncRequest, DeviceSyncSnapshot, ConfigurationDeliverySnapshot, ConfigurationDeliveryReceipt } =
    doc.components.schemas;
  assert.equal(SyncRequest.then.properties.configurationProtocol.properties.schemaVersion.const, 1);
  assert.ok(!DeviceSyncSnapshot.required.includes('configurationDelivery'));
  assert.equal(
    ConfigurationDeliverySnapshot.properties.settings.$ref,
    '../rest/device-sync-api.json#/components/schemas/SyncConfiguration',
  );
  assert.equal(ConfigurationDeliverySnapshot.properties.schemaVersion.const, 1);
  assert.equal(ConfigurationDeliverySnapshot.additionalProperties, false);
  assert.equal(ConfigurationDeliveryReceipt.additionalProperties, false);
  assert.deepEqual(ConfigurationDeliveryReceipt.required, ['deliveryId', 'configurationId', 'version', 'status']);
  assert.deepEqual(ConfigurationDeliveryReceipt.properties.status.enum, ['RECEIVED', 'APPLIED']);
});
