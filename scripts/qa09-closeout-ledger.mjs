export const A2_OPERATIONS = new Set([
  'suspendDevice',
  'reactivateDevice',
  'retireDevice',
  'forceCompleteRetirement',
  'activateLicense',
  'renewLicense',
  'revokeLicense',
  'createDeviceCommand',
  'createFirmwareUpload',
  'completeFirmwareUpload',
  'createOtaCampaign',
  'expandOtaCampaignBatch',
  'pauseOtaCampaign',
  'resumeOtaCampaign',
  'cancelOtaCampaign',
  'retryOtaCampaignFailures',
]);
export const MATERIAL_OPERATIONS = new Set(['inviteUser', 'triggerUserPasswordReset', 'updateSetting']);
export function persistenceLedger(pairs, proofs) {
  if (pairs.length !== 112 || new Set(pairs.map((p) => p.operationId + ':' + p.role)).size !== 112)
    throw Error('EXACT_112_OPERATION_ROLES_REQUIRED');
  return pairs.map((p) => {
    const found = proofs.filter(
      (x) =>
        x.operationId === p.operationId &&
        x.role === p.role &&
        x.sourceCompatible === true &&
        x.cleanupVerified === true &&
        [
          'ATOMIC_AUDIT_SNAPSHOT',
          'CURRENT_CONTRACT_STATE_READBACK',
          'REAL_CSR_ENTITY_RECEIPT',
          'SCOPED_SIGNED_USER_AUDIT',
          'NONACTIVE_LICENSE_EVALUATION_READBACK',
        ].includes(x.proofKind) &&
        x.receiptSha256?.match(/^[a-f0-9]{64}$/) &&
        x.specializedValidation === 'PASS',
    );
    return {
      operationId: p.operationId,
      role: p.role,
      status: A2_OPERATIONS.has(p.operationId)
        ? 'DEFERRED_A2_NOT_ACCEPTED'
        : MATERIAL_OPERATIONS.has(p.operationId)
          ? 'UNAVAILABLE_INPUT_NOT_ACCEPTED'
          : found.length
            ? 'PASS_SCOPED_PERSISTENCE'
            : 'NOT_PROVEN',
      proofs: found,
    };
  });
}
export function mapSemanticElements(elements, priorUserIds, compatibility, freshContract) {
  if (elements.length !== 117 || new Set(elements.map((e) => e.id)).size !== 117) throw Error('EXACT_117_REQUIRED');
  return elements.map((e) => {
    let status;
    if (priorUserIds.includes(e.id)) status = 'PASS_REUSED_SCOPED_USER_BROWSER';
    else if (
      [
        'dashboard.commands',
        'dashboard.upgrade',
        'device-view.media',
        'device-operate.commands',
        'device-manage.ota',
      ].includes(e.group)
    )
      status = 'DEFERRED_A2_SUCCESS_NOT_ACCEPTED';
    else if (e.group === 'settings.platform') status = 'UNAVAILABLE_NOTIFICATION_INPUT_NOT_ACCEPTED';
    else if (
      e.result === 'PASS' &&
      compatibility[e.group] === true &&
      (!e.group.startsWith('contract-') || freshContract)
    )
      status = 'PASS_REUSED_ORIGINAL_BROWSER_SCOPE';
    else status = 'NOT_PROVEN';
    return {
      id: e.id,
      group: e.group,
      originalStatus: e.result,
      status,
      role: 'PlatformSuperAdmin',
      viewports: [375, 1440],
      deviceIngestionClaimed: false,
    };
  });
}
export function assertContainment(x) {
  if (
    x?.gate !== 'PASS_CONTAINMENT_ONLY_UNKNOWN_EXECUTION_PRESERVED' ||
    x.originalStartGate !== 'UNKNOWN' ||
    x.restartAllowed !== false ||
    x.executionSuccessClaimed !== false ||
    !['ABSENT', 'DISABLED_TOMBSTONE'].includes(x.businessUser) ||
    x.cognitoIdentity !== 'ABSENT' ||
    x.reads?.length !== 2 ||
    x.reads.some((r) => r.type !== 'customer' || r.absent !== true)
  )
    throw Error('UNKNOWN_EXECUTION_OR_CONTAINMENT_BOUNDARY_REQUIRED');
  return {
    gate: 'PASS_CONTAINMENT_ONLY_UNKNOWN_EXECUTION_PRESERVED',
    originalStartGate: 'UNKNOWN',
    restartAllowed: false,
    executionSuccessClaimed: false,
  };
}
