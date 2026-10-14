/** Target proofs remain separate from the full QA09 gate. */
export function assertRotationSchedule(schedule) {
  if (
    schedule.Name !== 'fdp-test-cert-package-sweeper' ||
    schedule.State !== 'ENABLED' ||
    schedule.ScheduleExpression !== 'rate(5 minutes)'
  )
    throw Error('EXISTING_ENABLED_FIVE_MINUTE_SWEEPER_REQUIRED_NO_CONFIGURATION_CHANGE');
  return 360000;
}
export function assertRotationProof(r) {
  const a = r.before?.certificates?.find((c) => c.id === r.oldCertificateId),
    old = r.after?.certificates?.find((c) => c.id === r.oldCertificateId),
    next = r.after?.certificates?.find((c) => c.id === r.newCertificateId);
  if (
    !a ||
    a.status !== 'ACTIVE' ||
    r.oldCertificateId === r.newCertificateId ||
    old?.status !== 'REVOKED' ||
    !old.revoked_at ||
    next?.status !== 'ACTIVE' ||
    next.rotated_from_id !== old.id ||
    !next.rotation_confirmed_at ||
    !next.mqtt_verified_at ||
    !next.rest_verified_at ||
    !next.package_destroyed ||
    next.fingerprint !== r.newFingerprint ||
    r.oldRestStatus !== 401 ||
    r.newRestStatus !== 200 ||
    r.oldIotStatus !== 'INACTIVE' ||
    !(
      r.oldMqttRejection === 'NOT_AUTHORIZED' ||
      (r.oldMqttRejection === 'NO_CONNACK_WITH_INACTIVE_CERT_AND_ADJACENT_VALID_CONTROL' &&
        r.adjacentNewMqttControl === true &&
        ['CLOSED_BEFORE_CONNACK', 'CONNECTION_RESET'].includes(r.oldMqttOutcome))
    ) ||
    r.newMqttConnected !== true ||
    r.after.devices.some((d) => ['Active', 'Maintenance'].includes(d.lifecycle_status))
  )
    throw Error('REAL_DUAL_CHANNEL_ROTATION_AND_OLD_IDENTITY_DENIAL_REQUIRED');
  return { gate: 'PASS_ONE_REAL_DUAL_CHANNEL_ROTATION', fullQa09Accepted: false };
}
export function assertTabletProof(rows) {
  if (
    rows.length !== 8 ||
    new Set(rows.map((r) => r.locale + ':' + r.route)).size !== 8 ||
    rows.some(
      (r) =>
        r.width !== 768 ||
        !['zh-CN', 'en'].includes(r.locale) ||
        !['/settings', '/contracts', '/contracts/new', '/consumables'].includes(r.route) ||
        r.result !== 'PASS' ||
        r.lang !== r.locale ||
        r.documentWidth > 769 ||
        r.documentWidth < 768 ||
        !/^[a-f0-9]{64}$/.test(r.domSha256 ?? '') ||
        !r.apiReads?.length ||
        r.apiReads.some((q) => q.status !== 200 || !q.requestId),
    )
  )
    throw Error('REAL_TABLET_BILINGUAL_READ_PAGE_PROOFS_REQUIRED');
  return { gate: 'PASS_ROOT_TABLET_BILINGUAL_FOUR_READ_PAGES', fullWorkflowsAccepted: false, allRolesAccepted: false };
}
