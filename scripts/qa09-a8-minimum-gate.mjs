/** Missing required business evidence cannot be waived by an unrelated A2 exclusion. */
export function summarizeMinimumGate(rows) {
  const a2 = new Set([
    'device.independentLicenseVerification',
    'device.naturalActive',
    'device.suspendReactivateRetire',
    'license.lifecycle',
    'command.deliveryAndResult',
    'ota.trustedFirmwareAndCampaign',
    'media.realUploadAndIsolation',
  ]);
  if (!rows.length || new Set(rows.map((r) => r.id)).size !== rows.length)
    throw Error('EXACT_UNIQUE_REQUIREMENTS_REQUIRED');
  for (const r of rows) {
    if (
      r.status === 'DEFERRED_FROM_MINIMUM_PHASE_NOT_ACCEPTED' &&
      !(
        (r.authorizedExclusion === 'REL-A2-01' && a2.has(r.id)) ||
        (r.authorizedExclusion === 'REL-QUEUE-01' && r.id === 'actualArchivePoisonRetryDlq')
      )
    )
      throw Error('UNAUTHORIZED_SCOPE_EXCLUSION');
    if (r.status === 'PASS' && (!r.proof || r.proof === 'HTTP_ONLY' || r.proof === 'FREE_FORM_FLAG'))
      throw Error('SPECIALIZED_PROOF_REQUIRED');
  }
  const outstanding = rows.filter((r) => !['PASS', 'DEFERRED_FROM_MINIMUM_PHASE_NOT_ACCEPTED'].includes(r.status));
  return {
    gate: outstanding.length ? 'PARTIAL_MINIMUM_QA09_NOT_ACCEPTED' : 'PASS_MINIMUM_QA09_ONLY',
    minimumPhaseAccepted: outstanding.length === 0,
    fullQa09Accepted: false,
    productionReady: false,
    outstanding: outstanding.map((r) => r.id),
  };
}
