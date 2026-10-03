export async function runTargetLicenseLifecycle(api, { deviceId, from, to, prefix, now }) {
  let license = (
    await api('license-create', 'PlatformOperator', 'POST', '/api/v1/admin/licenses', 201, {
      deviceId,
      validFrom: from,
      validTo: to,
      entitlements: ['REMOTE_CONTROL', 'ESG_REPORTING'],
      reason: prefix,
    })
  ).data;
  const path = '/api/v1/admin/licenses/' + license.licenseId;
  await api('license-detail', 'PlatformOperator', 'GET', path, 200);
  for (const action of ['issue', 'activate'])
    license = (
      await api('license-' + action, 'PlatformOperator', 'POST', path + '/' + action, 200, undefined, {
        'If-Match': String(license.version),
      })
    ).data;
  license = (await api('license-before-renew-evaluate', 'PlatformOperator', 'POST', path + '/evaluate', 200, {})).data;
  if (license.status !== 'ExpiringSoon') throw Error('LICENSE_RENEW_PREREQUISITE_NOT_PROVED');
  license = (
    await api(
      'license-renew',
      'PlatformOperator',
      'POST',
      path + '/renew',
      200,
      { newValidTo: new Date(now + 86400000 * 60).toISOString() },
      { 'If-Match': String(license.version) },
    )
  ).data;
  const replay = await api('license-renew-replay', 'PlatformOperator', 'POST', path + '/renew', 200, {
    newValidTo: new Date(now + 86400000 * 60).toISOString(),
  });
  if (replay.data.replayed !== true) throw Error('LICENSE_RENEW_REPLAY_NOT_PROVED');
  license = (await api('license-reactivate-renewed', 'PlatformOperator', 'POST', path + '/activate', 200)).data;
  if (license.status !== 'Active') throw Error('LICENSE_REACTIVATION_NOT_PROVED');
  await api('license-history', 'PlatformOperator', 'GET', path + '/history', 200);
  await api('license-evaluate', 'PlatformOperator', 'POST', path + '/evaluate', 200, {});
  await api(
    'license-revoke',
    'PlatformOperator',
    'POST',
    path + '/revoke',
    200,
    { reason: prefix },
    { 'If-Match': String(license.version) },
  );
  return {
    licenseId: license.licenseId,
    renewalReplay: true,
    renewalPrerequisite: 'ExpiringSoon',
    reactivation: 'Active',
  };
}
