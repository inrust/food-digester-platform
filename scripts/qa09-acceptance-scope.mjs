/** Frozen business requirements. Release deferrals never remove a business/security probe. */
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
export const FORMAL_DOMAINS = [
  [
    'iot',
    'aws-iot-data-path',
    'checkAwsIotDataPathEvidence',
    'be-iot-aws-data-path.json',
    ['unknownTopic', 'errorAction', 'cleanup'],
  ],
  [
    'processing',
    'aws-data-processing',
    'checkAwsDataProcessingEvidence',
    'be-arc-rpl-esg-aws-data-processing.json',
    ['cleanup'],
  ],
  [
    'customersDevices',
    'aws-admin-cus-dev',
    'checkAwsAdminCusDevEvidence',
    'be-cus-dev-aws-acceptance.json',
    ['rbac.crossCustomer', 'ifMatchRace', 'retirement', 'activityExport', 'cleanup'],
  ],
  [
    'business',
    'aws-admin-business',
    'checkAwsAdminBusinessEvidence',
    'be-admin-business-aws-acceptance.json',
    ['rbac.crossCustomer', 'ifMatchRace', 'esgExport', 'cleanup'],
  ],
  [
    'mediaUsersSettings',
    'aws-med-rbac-aud-dash-set',
    'checkEvidence',
    'be-med-rbac-aud-dash-set-aws-acceptance.json',
    [
      'rbac.crossCustomer',
      'cognito',
      'superAdminRace',
      'settingVersionRace',
      'mediaS3',
      'mediaQuotaRace',
      'dashboardEntitlement',
      'auditRedaction',
      'strictRequests',
      'cleanup',
    ],
  ],
  [
    'fe06_10',
    'admin-web-target',
    'checkAdminWebTargetEvidence',
    'fe-06-10-admin-web-target.json',
    ['cognito', 'deployedApi', 'crossCustomer', 'concurrency', 'sensitiveData', 'cleanup'],
  ],
  [
    'fe11_15',
    'admin-web-fe11-15-target',
    'checkFe11To15TargetEvidence',
    'fe-11-15-admin-web-target.json',
    [
      'cognito',
      'deployedApi',
      'crossCustomer',
      'shortLink',
      'dangerousAction',
      'readonlyAudit',
      'sensitiveData',
      'cleanup',
    ],
  ],
  [
    'fe16_19',
    'admin-web-fe16-19-target',
    'checkFe16To19TargetEvidence',
    'fe-16-19-admin-web-target.json',
    ['cognito', 'deployedApi', 'authorization', 'concurrency', 'privacy', 'i18nLayout', 'cleanup'],
  ],
].map(([id, name, check, receipt, ancillary]) => ({
  id,
  validator: `check-${name}-evidence.mjs`,
  check,
  receipt: 'docs/audit/evidence/' + receipt,
  ancillary,
}));

export const SUPPLEMENTAL_REQUIREMENTS = [
  [
    'device.independentLicenseVerification',
    'A2/A3',
    'BLOCKED_TEST_VERIFIER',
    'Independent verifier of the actual issued license; no fabricated VERIFIED or SQL Active',
  ],
  [
    'device.naturalActive',
    'A3',
    'BLOCKED_TEST_VERIFIER',
    'RECEIVED -> VERIFIED -> natural Active over real mTLS and persisted audit',
  ],
  [
    'device.suspendReactivateRetire',
    'A3',
    'REQUIRES_ACTIVE',
    'Applicable lifecycle and illegal transitions, certificate/Topic denial after retirement',
  ],
  ['license.lifecycle', 'A3', 'REQUIRES_ACTIVE', 'Activate/renew/revoke, readback, replay denial and applicable roles'],
  [
    'command.deliveryAndResult',
    'A3',
    'REQUIRES_ACTIVE',
    'Applicable commands delivered with result/failed publish, idempotency and dangerous-action denial',
  ],
  [
    'ota.trustedFirmwareAndCampaign',
    'A4',
    'BLOCKED_TRUSTED_FIRMWARE',
    'Trusted package verification, batches, pause/resume/cancel/retry and protocol results',
  ],
  [
    'media.realUploadAndIsolation',
    'A4',
    'NOT_RUN',
    'Real upload/hash/readback, cross-customer denial, expiry, quota race and exact cleanup',
  ],
  [
    'certificate.completeRotation',
    'A4',
    'NOT_RUN',
    'New certificate connects, old certificate denied, persisted state and cleanup',
  ],
  ['replay.operatorNonempty', 'A5', 'NOT_RUN', 'PlatformOperator nonempty Replay with audit and exact own source'],
  [
    'replay.uniqueProducerAssociation',
    'A5',
    'NO_RECEIPT',
    'Unique Job -> produced message -> exact consumer invocation, not temporal proximity',
  ],
  [
    'reliability.sameRunNonemptyDedup',
    'A5',
    'NO_RECEIPT',
    'Same-run nonempty receipt/hourly/daily/outbox before and after exact redelivery; no extra business rows',
  ],
  [
    'reliability.archivePartialFailure',
    'A5',
    'NO_RECEIPT',
    'Partial failure success/failure separation and bad-message isolation',
  ],
  [
    'reliability.queueAndScheduleAssociation',
    'A5',
    'NO_RECEIPT',
    'Archive/Replay queue and natural schedule execution association',
  ],
  [
    'users.signedSessionAndState',
    'A6',
    'SCOPED_EVIDENCE_AVAILABLE',
    'Five roles, real signed unexpired tokens, disable/roles/scope audit and no side effects',
  ],
  [
    'security.signedClaimsAndIsolation',
    'A6',
    'NO_COMPLETE_RECEIPT',
    'Trusted signatures with invalid exp/nbf/audience, JWT/role/customer/cert/Topic boundaries and zero credential leaks',
  ],
  [
    'business.operationsRolesPersistence',
    'A6',
    'NEEDS_FORMAL_ASSEMBLY',
    'Applicable operations/authorization branches with persistence and audit; HTTP coverage is insufficient',
  ],
  [
    'notifications.inviteAndPasswordApi',
    'A6',
    'BLOCKED_AUTHORIZATION',
    'No implicit waiver of invite/reset API, compensation, permissions or signed-user semantics',
  ],
  [
    'settings.authorizedWriteAndRestore',
    'A6',
    'BLOCKED_SHARED_SETTING_SCOPE',
    'Authorized real update/version race/restoration; no implicit waiver',
  ],
  [
    'prototype.117SemanticItems',
    'A7',
    'HISTORICAL_102_OF_117_NOT_CURRENT_ACCEPTANCE',
    'All 117 mapped individually; revalidate only incompatible/missing behavior',
  ],
  [
    'browser.targetJourneys',
    'A7',
    'NEEDS_FORMAL_ASSEMBLY',
    'Real Cognito/API, required roles/workflows/locales/viewports, persisted results and no interception',
  ],
  [
    'data.naturalEsgConsistency',
    'A5',
    'SCOPED_EVIDENCE_AVAILABLE',
    'Natural hourly/daily/report/ESG values and original archive/manifest match',
  ],
  [
    'data.exportLeaseRecovery',
    'A5',
    'SCOPED_EVIDENCE_AVAILABLE',
    'Own expired export lease naturally recovers with nonempty unchanged CSV',
  ],
  [
    'cleanup.ownedResourcesAndUnknownWrites',
    'A8',
    'PER_RUN_PROOF_REQUIRED',
    'Created-ID ledger, independent empty sets, no outside drift, revoked identities/restored config, unknown writes contained',
  ],
].map(([id, workPackage, initialStatus, criterion]) => ({
  id,
  workPackage,
  initialStatus,
  criterion,
  required: true,
  closure: 'SPECIALIZED_BUSINESS_EVIDENCE_REQUIRED_NOT_A_FREE_FORM_PASS_FLAG',
}));

export const RELEASE_DEFERRALS = [
  ['REL-PERF-01.telemetryP95', 'Telemetry API visibility P95 <= 5000 ms'],
  ['REL-PERF-01.commandP95', 'Online Command P95 <= 3000 ms'],
  ['REL-PERF-01.loadAndCapacity', 'Sustained/mixed/burst load, backlog recovery and capacity'],
  [
    'REL-PERF-01.coldAndTransport',
    'Cold-start/transport tails; detailed attribution only when needed for SLO/capacity decisions',
  ],
  [
    'REL-PERF-01.candidateBenefit',
    'Candidate optimization and instrumentation-cost comparisons only when needed for SLO/capacity decisions',
  ],
].map(([id, criterion]) => ({
  id,
  criterion,
  status: 'DEFERRED_TO_RELEASE_NOT_ACCEPTED',
  authorization: 'USER_CONFIRMED_2026_10_12_AND_A1_DIRECTIVE_2026_10_13',
  businessFailureWaived: false,
}));

export async function buildFrozenScope(root) {
  const domains = [];
  for (const domain of FORMAL_DOMAINS) {
    const module = await import(pathToFileURL(resolve(root, 'scripts', domain.validator)));
    const sets = Object.fromEntries(
      Object.entries(module).filter(
        ([key]) => key.startsWith('REQUIRED_') || ['UPLINK_TYPES', 'QA03_PROBES', 'RETIRED_MQTT_TYPES'].includes(key),
      ),
    );
    domains.push({ ...domain, requiredSets: sets, fullOriginalContractRequired: true });
  }
  const prototype = JSON.parse(readFileSync(resolve(root, 'contracts/prototype-traceability.yaml')));
  const prototypeElements = prototype.pages.flatMap((page) =>
    page.elements.map((element) => ({ id: element.id, page: page.pageState, disposition: element.disposition })),
  );
  return {
    schemaVersion: '1.0',
    scope: 'QA09_BUSINESS_ACCEPTANCE_ENTRY',
    domains,
    prototype: {
      requiredElements: prototypeElements.filter((item) => ['Adopt', 'Adapt'].includes(item.disposition)),
      forbiddenOrReadonly: prototypeElements.filter((item) => !['Adopt', 'Adapt'].includes(item.disposition)),
      menus: prototype.menus.map((item) => item.menuId),
      pages: prototype.pages.map((item) => item.pageState),
    },
    mandatorySupplemental: SUPPLEMENTAL_REQUIREMENTS,
    releaseDeferrals: RELEASE_DEFERRALS,
    proposedReleaseOnly: [
      'Actual external notification delivery',
      'Shared/global configuration switching',
      'Global disaster recovery and long-running operations',
    ],
    proposedReleaseIsNotFunctionalWaiver: true,
    outsideOriginalQa09: [
      'Physical actuator/sensor/interlock validation',
      'Physical flashing/power-loss recovery',
      'Third-party carbon verification',
    ],
    stoppingRule:
      'Only a failed frozen business/security requirement may expand the current blocking work; no performance decomposition or repeated full suite',
    fullQa09Accepted: false,
    releasePerformanceAccepted: false,
    productionReady: false,
  };
}
