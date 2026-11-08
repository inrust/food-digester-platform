/** Synthetic clock/identities/budget, never target admission input or authorization. */
import type { Manifest } from './contracts.js';
import type { Snapshot } from './manifests.js';
import type { Budget, Network } from './infra.js';
import { databaseCapacity } from '../../infra/src/database-capacity.js';
export const FIXTURE_NOW = Date.parse('2026-11-09T00:01:00.000Z');
export function fixtureInput() {
  const manifest: Manifest = {
    formatVersion: 1,
    runId: 'IMG21-MC02-LOCAL-NOT-AUTHORIZED',
    applicationCommit: 'd1a7b81196d60ec320e760da3d18de403563fc12',
    toolCommit: 'a'.repeat(40),
    approvalRef: 'LOCAL_FIXTURE_NOT_TARGET_APPROVAL',
    window: { startsAt: '2026-11-09T00:00:00.000Z', endsAt: '2026-11-09T01:30:00.000Z' },
    serialNumber: 'img21-0123456789abcdef',
    model: 'IMG21-LOCAL',
    customerName: 'LOCAL FIXTURE',
    siteName: 'LOCAL FIXTURE',
    csrPublicKeyFingerprint: 'b'.repeat(64),
    provisioner: { username: 'img21-0123456789abcdef-admin', email: 'admin@example.invalid' },
    viewer: { username: 'img21-0123456789abcdef-viewer', email: 'viewer@example.invalid' },
    writerVersion: '1',
    verifierVersion: '2',
    licenseSecretVersion: '1'.repeat(32),
    verifierBinding: null,
    verification: null,
  };
  const snapshot: Snapshot = {
    observedAt: new Date(FIXTURE_NOW).toISOString(),
    sourceRef: 'LOCAL_FIXTURE_NOT_REAL_SYNC',
    binding: {
      deviceId: '11111111-1111-4111-8111-111111111111',
      customerId: '22222222-2222-4222-8222-222222222222',
      siteId: '33333333-3333-4333-8333-333333333333',
      certificateFingerprint: 'c'.repeat(64),
      certificateId: 'LOCAL-FIXTURE',
    },
    licenseId: '44444444-4444-4444-8444-444444444444',
    licenseVersion: 1,
    snapshotEtag: 'e'.repeat(64),
  };
  const network: Network = {
    vpcId: 'vpc-0d287fdfa0a4a06bd',
    subnetIds: ['subnet-0f52dca7a7253f7d1', 'subnet-0c1584eea5495f25a'],
    securityGroupIds: ['sg-056df8dcb3fe75dcb'],
    sourceRef: 'LOCAL_FIXTURE_NOT_FRESH_NETWORK_PROOF',
    observedAt: new Date(FIXTURE_NOW).toISOString(),
  };
  const budget: Budget = {
    sourceRef: 'LOCAL_FIXTURE_NOT_NATIVE_BUDGET_PROOF',
    observedAt: new Date(FIXTURE_NOW).toISOString(),
    maxConnections: 79,
    superuserReserved: 3,
    reserved: 2,
    rdsReserved: 4,
    operationalReserve: 8,
    idleOverlapReserve: 10,
    otherClients: 0,
    functions: databaseCapacity(true, true).functions,
  };
  return { manifest, snapshot, network, budget };
}
