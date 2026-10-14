/** Explicit minimum-phase contract. Material deferrals never satisfy a retained proof. */
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
export const MINIMUM_AUTHORIZATION = 'USER_DIRECTIVE_2026_10_14_DEFER_THREE_MATERIALS_AND_DEPENDENCIES_TO_PRE_RELEASE';
export const MATERIAL_DEFERRALS = {
  'REL-MATERIAL-CLAIMS-01': {
    status: 'DEFERRED_TO_PRE_RELEASE_NOT_ACCEPTED',
    releaseRequired: true,
    input: 'trustedSignedInvalidClaims',
    requirements: ['security.signedClaimsAndIsolation'],
    operations: [],
    semanticItems: [],
    deferred: ['trusted signed invalid exp/nbf/audience rejection and valid control'],
  },
  'REL-MATERIAL-NOTIFY-01': {
    status: 'DEFERRED_TO_PRE_RELEASE_NOT_ACCEPTED',
    releaseRequired: true,
    input: 'controlledNotificationRecipientAndScope',
    requirements: [
      'notifications.inviteAndPasswordApi',
      'business.operationsRolesPersistence',
      'prototype.117SemanticItems',
      'browser.targetJourneys',
    ],
    operations: ['inviteUser', 'triggerUserPasswordReset'],
    semanticItems: ['settings.button.addPlatformUser', 'settings.button.resetPlatformUserPassword'],
    deferred: [
      'real invite/password-reset API and delivery',
      'associated Cognito compensation and notification workflows',
    ],
  },
  'REL-MATERIAL-SETTING-01': {
    status: 'DEFERRED_TO_PRE_RELEASE_NOT_ACCEPTED',
    releaseRequired: true,
    input: 'writableRestorableSettingKey',
    requirements: [
      'settings.authorizedWriteAndRestore',
      'business.operationsRolesPersistence',
      'browser.targetJourneys',
    ],
    operations: ['updateSetting'],
    semanticItems: [],
    deferred: [
      'authorized Setting update, version race, readback and restoration',
      'associated settings-write browser workflow',
    ],
  },
};
export const A2_REQUIREMENTS = [
  'device.independentLicenseVerification',
  'device.naturalActive',
  'device.suspendReactivateRetire',
  'license.lifecycle',
  'command.deliveryAndResult',
  'ota.trustedFirmwareAndCampaign',
  'media.realUploadAndIsolation',
];
export const RETAINED_REQUIREMENTS = [
  'certificate.completeRotation',
  'replay.operatorNonempty',
  'replay.uniqueProducerAssociation',
  'reliability.sameRunNonemptyDedup',
  'reliability.archivePartialFailure',
  'reliability.queueAndScheduleAssociation',
  'users.signedSessionAndState',
  'security.signedClaimsAndIsolation',
  'business.operationsRolesPersistence',
  'prototype.117SemanticItems',
  'browser.targetJourneys',
  'data.naturalEsgConsistency',
  'data.exportLeaseRecovery',
  'cleanup.ownedResourcesAndUnknownWrites',
];
export const MINIMUM_DOMAINS = {
  iot: [
    'certificate.completeRotation',
    'reliability.queueAndScheduleAssociation',
    'security.signedClaimsAndIsolation',
    'cleanup.ownedResourcesAndUnknownWrites',
  ],
  processing: [
    'replay.operatorNonempty',
    'replay.uniqueProducerAssociation',
    'reliability.sameRunNonemptyDedup',
    'reliability.archivePartialFailure',
    'reliability.queueAndScheduleAssociation',
    'data.naturalEsgConsistency',
    'data.exportLeaseRecovery',
    'cleanup.ownedResourcesAndUnknownWrites',
  ],
  customersDevices: [
    'business.operationsRolesPersistence',
    'security.signedClaimsAndIsolation',
    'cleanup.ownedResourcesAndUnknownWrites',
  ],
  business: [
    'business.operationsRolesPersistence',
    'data.naturalEsgConsistency',
    'data.exportLeaseRecovery',
    'security.signedClaimsAndIsolation',
    'cleanup.ownedResourcesAndUnknownWrites',
  ],
  mediaUsersSettings: [
    'users.signedSessionAndState',
    'business.operationsRolesPersistence',
    'security.signedClaimsAndIsolation',
    'cleanup.ownedResourcesAndUnknownWrites',
  ],
  fe06_10: [
    'prototype.117SemanticItems',
    'browser.targetJourneys',
    'business.operationsRolesPersistence',
    'security.signedClaimsAndIsolation',
    'cleanup.ownedResourcesAndUnknownWrites',
  ],
  fe11_15: [
    'prototype.117SemanticItems',
    'browser.targetJourneys',
    'data.naturalEsgConsistency',
    'data.exportLeaseRecovery',
    'security.signedClaimsAndIsolation',
    'cleanup.ownedResourcesAndUnknownWrites',
  ],
  fe16_19: [
    'prototype.117SemanticItems',
    'browser.targetJourneys',
    'users.signedSessionAndState',
    'business.operationsRolesPersistence',
    'security.signedClaimsAndIsolation',
    'cleanup.ownedResourcesAndUnknownWrites',
  ],
};
export const MINIMUM_LIMITS = {
  iot: 'Real certificate rotation and retained MQTT/queue observations; not full eight-uplink/QA03 acceptance.',
  processing:
    'Five scoped A5 criteria plus retained real archive/ESG/lease proofs; mixed batch is direct deployed-handler invocation, not actual poison-message retry/DLQ.',
  customersDevices:
    'Applicable server-state operation/role persistence and scoped isolation; no natural Active or retirement success claim.',
  business:
    'Applicable committed server transactions, including Draft/Issued license state; not device-side license verification, delivery or full branch acceptance.',
  mediaUsersSettings:
    'Signed user role/scope/disable state, scoped audit and authorization; no Media success, notification or Setting-write acceptance.',
  fe06_10:
    'Retained real UI semantics, route controls and corresponding server persistence; no A2-dependent device/Media success journey.',
  fe11_15:
    'Retained ESG/activity export and read/audit routes plus related semantic groups; no command/OTA/Media success journey.',
  fe16_19:
    'Retained user-state/contract/consumable semantics and persisted results, route and language/layout controls; no notification or Setting-write journey.',
};
export const digest = (b) => createHash('sha256').update(b).digest('hex');
const demand = (ok, code) => {
  if (!ok) throw Error(code);
};
export function buildMinimumPhaseScope(original, originalSha256) {
  const ids = [...original.mandatorySupplemental.map((r) => r.id), 'actualArchivePoisonRetryDlq'];
  demand(
    ids.length === 24 && new Set(ids).size === 24 && RETAINED_REQUIREMENTS.every((id) => ids.includes(id)),
    'EXACT_ORIGINAL_SUPPLEMENTAL_SCOPE_REQUIRED',
  );
  return {
    schemaVersion: '2.0',
    scope: 'QA09_MINIMUM_PHASE_2026_10_14',
    authorization: MINIMUM_AUTHORIZATION,
    originalScopeSha256: originalSha256,
    applicationAndExecutorAndDocumentationSeparatelyBound: true,
    materialDeferrals: MATERIAL_DEFERRALS,
    requirements: ids.map((id) => ({
      id,
      disposition: RETAINED_REQUIREMENTS.includes(id) ? 'RETAINED_REQUIRED' : 'DEFERRED_TO_PRE_RELEASE_NOT_ACCEPTED',
      deferral: A2_REQUIREMENTS.includes(id)
        ? 'REL-A2-01'
        : id === 'actualArchivePoisonRetryDlq'
          ? 'REL-QUEUE-01'
          : id === 'notifications.inviteAndPasswordApi'
            ? 'REL-MATERIAL-NOTIFY-01'
            : id === 'settings.authorizedWriteAndRestore'
              ? 'REL-MATERIAL-SETTING-01'
              : null,
      dependentSubscopeDeferrals: Object.entries(MATERIAL_DEFERRALS)
        .filter(([, v]) => v.requirements.includes(id))
        .map(([key]) => key),
      releaseRequired: !RETAINED_REQUIREMENTS.includes(id),
    })),
    minimumDomainRequirements: MINIMUM_DOMAINS,
    minimumDomainLimits: MINIMUM_LIMITS,
    retainedOperationRoles: 76,
    deferredA2OperationRoles: 33,
    deferredMaterialOperationRoles: 3,
    retainedSemanticItems: 100,
    deferredA2SemanticItems: 15,
    deferredMaterialSemanticItems: 2,
    fullOriginalDomainContractsUnchanged: true,
    fullOriginalDomainAcceptanceClaimed: false,
    unknownExecutionMustRemainUnknown: true,
    permissionChangesAllowed: false,
    fullSuiteRepeated: false,
    productionReady: false,
  };
}
export function validateMinimumPhaseScope(scope, original, originalSha256) {
  demand(
    isDeepStrictEqual(scope, buildMinimumPhaseScope(original, originalSha256)),
    'EXACT_AUTHORIZED_MINIMUM_SCOPE_REQUIRED',
  );
}
export function validateMinimumPhaseFacts(f) {
  demand(f.currentApplication === 'PASS_BOUND_CURRENT_DEPLOYMENT_AND_CONFIG', 'CURRENT_DEPLOYMENT_BINDING_REQUIRED');
  demand(f.rotation === 'PASS_REAL_DUAL_CHANNEL_ROTATION', 'REAL_ROTATION_REQUIRED');
  demand(
    f.a5?.length === 5 &&
      new Set(f.a5).size === 5 &&
      [
        'replay.operatorNonempty',
        'replay.uniqueProducerAssociation',
        'reliability.sameRunNonemptyDedup',
        'reliability.archivePartialFailure',
        'reliability.queueAndScheduleAssociation',
      ].every((id) => f.a5.includes(id)),
    'FIVE_REAL_A5_PROOFS_REQUIRED',
  );
  demand(f.userState === 'PASS_FIVE_SIGNED_ROLES_STATE_AUDIT_AND_CLEANUP', 'SIGNED_USER_STATE_REQUIRED');
  demand(
    f.authorization?.invalidBranches === 378 &&
      f.authorization.forgedSignatures === 6 &&
      f.authorization.currentRoles === 5 &&
      f.authorization.trustedInvalidClaimsAccepted === false,
    'RETAINED_AUTHORIZATION_REQUIRED',
  );
  demand(
    isDeepStrictEqual(f.persistence, { retained: 76, deferredA2: 33, deferredMaterials: 3, notProven: 0 }),
    'EXACT_RETAINED_PERSISTENCE_REQUIRED',
  );
  demand(
    isDeepStrictEqual(f.semantics, { retained: 100, deferredA2: 15, deferredMaterials: 2, notProven: 0 }),
    'EXACT_RETAINED_SEMANTICS_REQUIRED',
  );
  demand(
    f.browser?.originalPass === 87 &&
      f.browser.originalFail === 1 &&
      f.browser.finalLayoutRecheck === 'PASS' &&
      f.browser.changedViewerRead === 'PASS' &&
      f.browser.realLogins === 5 &&
      f.browser.originalFailurePreserved === true,
    'REAL_BROWSER_GAP_REPAIR_REQUIRED',
  );
  demand(
    isDeepStrictEqual(f.browser.retainedWorkflowFamilies, [
      'alias-write-readback',
      'contract-create-bind',
      'consumable-process-complete',
      'device-user-create-update',
      'nonempty-csv-export',
    ]),
    'RETAINED_MUTATING_BROWSER_WORKFLOWS_REQUIRED_NOT_ONLY_READ_LAYOUT',
  );
  demand(
    f.data?.naturalConsistency === 'PASS_RETAINED_REAL_DATABASE_CSV_ARCHIVE' &&
      f.data.leaseRecovery === 'PASS_NATURAL_NONEMPTY_EQUAL_CSV',
    'REAL_DATA_AND_LEASE_PROOFS_REQUIRED',
  );
  demand(
    f.cleanup?.current === 'PASS_INDEPENDENT_EMPTY_IDENTITY_ABSENCE_AND_OUTSIDE_BASELINE' &&
      f.cleanup.unknownExecution === 'UNKNOWN' &&
      f.cleanup.unknownContainment === 'PASS' &&
      f.cleanup.originalFailuresPreserved === true,
    'CLEANUP_AND_UNKNOWN_BOUNDARY_REQUIRED',
  );
  demand(
    f.permissionsChanged === false &&
      f.fullSuiteRepeated === false &&
      f.fullQa09Accepted === false &&
      f.productionReady === false,
    'MINIMUM_ACCEPTANCE_BOUNDARY_REQUIRED',
  );
}
export function validateMinimumDomainReceipt(r, scope, facts, binding) {
  validateMinimumPhaseFacts(facts);
  const requirements = MINIMUM_DOMAINS[r.domain];
  demand(
    requirements &&
      r.schemaVersion === '2.0' &&
      r.kind === 'QA09_FORMAL_MINIMUM_DOMAIN_RECEIPT' &&
      r.status === 'PASS_MINIMUM_SCOPE',
    'MINIMUM_DOMAIN_KIND_REQUIRED',
  );
  demand(
    r.scopeSha256 === binding.scopeSha256 &&
      r.factsSha256 === digest(JSON.stringify(facts)) &&
      r.applicationCommit === binding.applicationCommit &&
      r.executorSnapshotSha256 === binding.executorSnapshotSha256 &&
      r.documentationSnapshotSha256 === binding.documentationSnapshotSha256,
    'MINIMUM_DOMAIN_PROVENANCE_REQUIRED',
  );
  demand(
    isDeepStrictEqual(r.required, requirements) &&
      isDeepStrictEqual(r.accepted, requirements) &&
      r.scopeLimit === MINIMUM_LIMITS[r.domain],
    'EXACT_MINIMUM_DOMAIN_INVENTORY_REQUIRED',
  );
  demand(
    isDeepStrictEqual(
      r.releaseDeferrals,
      scope.requirements.filter((x) => x.disposition.startsWith('DEFERRED')).map((x) => x.id),
    ) && isDeepStrictEqual(r.materialDependencyDeferrals, scope.materialDeferrals),
    'EXPLICIT_RELEASE_DEFERRALS_REQUIRED',
  );
  demand(
    r.fullOriginalDomainAccepted === false &&
      r.fullQa09Accepted === false &&
      r.productionReady === false &&
      r.evidenceBundleSha256 === binding.evidenceBundleSha256,
    'LEGACY_FULL_DOMAIN_CANNOT_BE_PROMOTED',
  );
  return { minimumFormalAccepted: true, fullOriginalDomainAccepted: false };
}
export function summarizeMinimumPhase(receipts, scope, facts, binding) {
  demand(
    receipts.length === 8 &&
      new Set(receipts.map((r) => r.domain)).size === 8 &&
      Object.keys(MINIMUM_DOMAINS).every((id) => receipts.some((r) => r.domain === id)),
    'EXACT_EIGHT_MINIMUM_DOMAINS_REQUIRED',
  );
  for (const r of receipts) validateMinimumDomainReceipt(r, scope, facts, binding);
  return {
    gate: 'PASS_MINIMUM_QA09_ONLY',
    minimumPhaseAccepted: true,
    minimumFormalPassCount: 8,
    minimumFormalRequiredCount: 8,
    fullOriginalDomainPassCount: 0,
    fullQa09Accepted: false,
    releasePerformanceAccepted: false,
    productionReady: false,
    outstandingMinimumRequirements: [],
  };
}
