import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { assertBusinessContext } from './qa09-business-target.mjs';
import { runWriteBoundaryProbes } from './qa09-write-boundary-probes.mjs';
import { CURRENT_TEST_CONFIG } from './qa09-current-environment.mjs';
import { writeFileSync } from 'node:fs';

export function requireReadback(ok) {
  if (!ok) throw Error('REMAINING_WRITE_READBACK_FAILED');
}
export async function runRemainingNonActive(ctx) {
  assertBusinessContext(ctx);
  const { api, db, prefix, devices, customers, semanticExports, sessions } = ctx;
  const credentialCanaries = [...(ctx.logins?.values() ?? [])].map((x) => x.password).filter(Boolean);
  const devicePassword = 'A!z9' + randomBytes(20).toString('base64url');
  credentialCanaries.push(devicePassword);
  const r = {
    scope: 'OWN_NONACTIVE_LEGAL_WRITES_SECURITY_LEASE_RECOVERY',
    gate: 'RUNNING',
    checks: [],
    fullQa09Accepted: false,
    apiMock: false,
    sharedResourcesChanged: false,
  };
  ctx.businessReceipt.remaining = r;
  ctx.save();
  const proof = (id, ok) => {
    r.checks.push({ id, result: ok ? 'PASS' : 'FAIL' });
    requireReadback(ok);
  };
  const req = (id, role, method, path, status, body, headers) =>
    api('remaining:' + id, role, method, path, status, body, headers);
  const get = async (id, role, path) => (await req(id, role, 'GET', path, 200)).data;
  const headers = (x) => ({ 'If-Match': String(x.version) });
  try {
    const role = 'PlatformSuperAdmin';
    for (const [i, rr] of ['PlatformSuperAdmin', 'PlatformOperator'].entries()) {
      const license = (
        await req('license-create-' + rr, rr, 'POST', '/api/v1/admin/licenses', 201, {
          deviceId: devices[i === 0 ? 4 : 9],
          validFrom: new Date(Date.now() - 1000).toISOString(),
          validTo: new Date(Date.now() + 86400000 * 20).toISOString(),
          entitlements: ['REMOTE_CONTROL', 'ESG_REPORTING'],
          reason: prefix,
        })
      ).data;
      const path = '/api/v1/admin/licenses/' + license.licenseId;
      await req('license-issue-' + rr, rr, 'POST', path + '/issue', 200, undefined, headers(license));
      const evaluated = (await req('license-evaluate-' + rr, rr, 'POST', path + '/evaluate', 200, {})).data;
      proof('license-issued-no-fake-activation-' + rr, evaluated.status === 'Issued');
    }
    const cfg = (
      await req('config-create', role, 'POST', '/api/v1/admin/configurations', 201, {
        name: prefix + '-super',
        targetDeviceId: devices[1],
      })
    ).data;
    const cp = '/api/v1/admin/configurations/' + cfg.configurationId;
    const v = (
      await req('config-version', role, 'POST', cp + '/versions', 201, {
        payload: { heartbeatInterval: 60, telemetryInterval: 30, cameraRefreshInterval: 1, temperatureThreshold: 80 },
      })
    ).data;
    await req('config-publish', role, 'POST', cp + '/versions/' + v.version + '/publish', 200, {});
    proof(
      'config-published-readback',
      (await get('config-readback', role, cp + '/versions/' + v.version)).version === v.version,
    );
    let u = (
      await req('user-create', role, 'POST', '/api/v1/admin/device-users', 201, {
        customerId: customers[0].id,
        username: prefix + '-super',
        password: devicePassword,
        displayName: prefix,
      })
    ).data;
    const up = '/api/v1/admin/device-users/' + u.deviceUserId;
    u = (
      await req(
        'user-update',
        role,
        'PATCH',
        up,
        200,
        { displayName: prefix + '-super-updated', reason: prefix },
        headers(u),
      )
    ).data;
    await req(
      'user-assign',
      role,
      'POST',
      up + '/assignments',
      201,
      { deviceIds: [devices[1]], reason: prefix },
      headers(u),
    );
    u = await get('user-assignment-read', role, up);
    proof(
      'device-user-assignment-persisted',
      u.assignments.some((x) => x.deviceId === devices[1]),
    );
    await req(
      'user-revoke',
      role,
      'POST',
      up + '/assignments/revoke',
      200,
      { deviceIds: [devices[1]], reason: prefix },
      headers(u),
    );
    u = await get('user-revoke-read', role, up);
    await req('user-disable', role, 'POST', up + '/disable', 200, { reason: prefix }, headers(u));
    const alarmId = randomUUID();
    await db('business-seed-alarm', undefined, { alarmId });
    await req('alarm-ack', role, 'POST', '/api/v1/admin/alarms/' + alarmId + '/acknowledge', 200, { reason: prefix });
    await req('alarm-clear', role, 'POST', '/api/v1/admin/alarms/' + alarmId + '/clear', 200, { reason: prefix });
    for (const type of ['CARBON_FILTER', 'BIO_ADDITIVE']) {
      const rr = 'PlatformOperator';
      let c = (
        await req('consumable-' + type, rr, 'POST', '/api/v1/admin/consumable-requests', 201, {
          deviceId: devices[2],
          consumableType: type,
          note: prefix,
        })
      ).data;
      const path = '/api/v1/admin/consumable-requests/' + c.requestId;
      if (type === 'CARBON_FILTER') {
        c = (await req('consumable-process', rr, 'POST', path + '/process', 200, { note: prefix }, headers(c))).data;
        await req('consumable-complete', rr, 'POST', path + '/complete', 200, { note: prefix }, headers(c));
      } else await req('consumable-cancel', rr, 'POST', path + '/cancel', 200, { note: prefix }, headers(c));
      const after = await get('consumable-read-' + type, rr, path);
      proof('consumable-terminal-' + type, ['COMPLETED', 'CANCELLED', 'CANCELED'].includes(after.status));
    }
    const metadataDevice = await get('metadata-before', role, '/api/v1/admin/devices/' + devices[3]);
    await req(
      'metadata-super',
      role,
      'PATCH',
      '/api/v1/admin/devices/' + devices[3] + '/metadata',
      200,
      { alias: prefix + '-alias' },
      { 'If-Match': metadataDevice.updatedAt },
    );
    proof(
      'metadata-readback',
      (await get('metadata-get', role, '/api/v1/admin/devices/' + devices[3])).alias === prefix + '-alias',
    );
    const customerPath = '/api/v1/admin/customers/' + customers[0].id;
    let c = await get('customer-get', role, customerPath);
    await req('customer-update-super', role, 'PATCH', customerPath, 200, { name: customers[0].name }, headers(c));
    proof('customer-name-preserved', (await get('customer-readback', role, customerPath)).name === customers[0].name);
    for (const rr of ['PlatformSuperAdmin', 'PlatformOperator']) {
      const extra = (
        await req('customer-extra-create-' + rr, 'PlatformOperator', 'POST', '/api/v1/admin/customers', 201, {
          name: prefix + '-extra-' + rr,
        })
      ).data;
      (r.extraCustomers ??= []).push({ id: extra.id, name: extra.name, deleted: false });
      ctx.save();
      const path = '/api/v1/admin/customers/' + extra.id;
      try {
        await req(
          'customer-deactivate-' + rr,
          rr,
          'POST',
          path + '/deactivate',
          200,
          { reason: prefix },
          headers(extra),
        );
      } finally {
        c = await get('extra-customer-scope-' + rr, 'PlatformOperator', path);
        proof('extra-customer-owned-' + rr, c.name === prefix + '-extra-' + rr);
        await req('customer-delete-operator-' + rr, 'PlatformOperator', 'DELETE', path, 200, undefined, headers(c));
        await req('customer-absent-' + rr, 'PlatformOperator', 'GET', path, 404);
        r.extraCustomers.find((x) => x.id === extra.id).deleted = true;
        ctx.save();
      }
    }
    const site = (
      await req('site-extra', role, 'POST', '/api/v1/admin/sites', 201, {
        customerId: customers[0].id,
        name: prefix + '-unused',
      })
    ).data;
    ctx.sites.push(site);
    ctx.save();
    const sp = '/api/v1/admin/sites/' + site.id;
    await req(
      'assignment-operator',
      'PlatformOperator',
      'POST',
      '/api/v1/admin/devices/' + devices[3] + '/assignment',
      200,
      { customerId: customers[0].id, siteId: site.id, reason: prefix },
    );
    proof(
      'operator-assignment-readback',
      (await get('operator-assignment-get', role, '/api/v1/admin/devices/' + devices[3])).site?.id === site.id,
    );
    await req(
      'assignment-operator-restore',
      'PlatformOperator',
      'POST',
      '/api/v1/admin/devices/' + devices[3] + '/assignment',
      200,
      { customerId: customers[0].id, siteId: ctx.sites[0].id, reason: prefix },
    );
    await req('site-deactivate-super', role, 'POST', sp + '/deactivate', 200, { reason: prefix }, headers(site));
    const sv = await get('site-readback', role, sp);
    await req('site-delete-operator', 'PlatformOperator', 'DELETE', sp, 200, undefined, headers(sv));
    await req('site-gone', 'PlatformOperator', 'GET', sp, 404);
    ctx.sites.splice(ctx.sites.indexOf(site), 1);
    r.legalWrites = 'PASS';
  } catch (e) {
    r.legalWrites = 'FAIL';
    r.failureCode = e.code ?? (/^[A-Z_]+$/.test(e.message) ? e.message : 'REMAINING_WRITES_FAILED');
  }
  try {
    const before = await db('business-baseline');
    r.writeBoundaries = await runWriteBoundaryProbes({ receipt: ctx }, api, sessions, (id, ok) => proof(id, ok));
    const after = await db('business-baseline');
    proof(
      'invalid-writes-no-business-effects',
      JSON.stringify(before.counts) === JSON.stringify(after.counts) &&
        JSON.stringify(before.businessFingerprints) === JSON.stringify(after.businessFingerprints),
    );
    const audit = await req('audit', 'PlatformSuperAdmin', 'GET', '/api/v1/admin/audit-logs?limit=100', 200);
    const raw = JSON.stringify(audit);
    proof(
      'audit-no-token-private-key',
      !/-----BEGIN [A-Z ]*PRIVATE KEY|\bBearer [A-Za-z0-9._~-]+|\beyJ[\w-]+\.[\w-]+\.[\w-]+/.test(raw) &&
        ![...sessions.values()].some((s) => raw.includes(s.idToken)) &&
        !credentialCanaries.some((x) => raw.includes(x)),
    );
    proof(
      'all-write-boundaries',
      r.writeBoundaries.rows.every((x) => x.result === 'PASS') &&
        r.writeBoundaries.jwt.every((x) => x.result === 'PASS'),
    );
    r.security = 'PASS';
  } catch (e) {
    r.security = 'FAIL';
    r.securityFailure = e.code ?? 'SECURITY_TARGET_FAILED';
  }
  try {
    for (const rr of ['PlatformSuperAdmin', 'PlatformOperator']) {
      const to = new Date(),
        from = new Date(to.getTime() - 60000);
      const job = (
        await req('replay-create-' + rr, rr, 'POST', '/api/v1/admin/replay/jobs', 201, {
          customerId: customers[0].id,
          deviceId: devices[0],
          topicType: 'telemetry',
          from: from.toISOString(),
          to: to.toISOString(),
        })
      ).data;
      let value;
      for (let n = 0; n < 48; n++) {
        value = await get('replay-poll-' + rr + '-' + n, rr, '/api/v1/admin/replay/jobs/' + job.jobId);
        if (['COMPLETED', 'FAILED'].includes(value.status)) break;
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }
      proof(
        'empty-owned-replay-completed-' + rr,
        value.status === 'COMPLETED' &&
          value.scope.customerId === customers[0].id &&
          value.scope.deviceId === devices[0],
      );
      (r.replayJobs ??= []).push({
        jobId: job.jobId,
        role: rr,
        resultSummary: value.resultSummary,
        provesMessageReplay: false,
      });
    }
    for (const rr of ['Auditor', 'CustomerAdmin']) {
      for (const kind of ['activity', 'esg']) {
        const path =
          kind === 'activity'
            ? '/api/v1/admin/devices/' + devices[0] + '/activities/export'
            : '/api/v1/admin/esg/exports';
        const job = (
          await req(
            kind + '-export-' + rr,
            rr,
            'POST',
            path,
            202,
            kind === 'activity' ? {} : { dataset: 'HOURLY', deviceId: devices[0] },
          )
        ).data;
        semanticExports.push({ id: job.exportId, kind });
        ctx.save();
        const readPath =
          kind === 'activity'
            ? '/api/v1/admin/activity-exports/' + job.exportId
            : '/api/v1/admin/esg/exports/' + job.exportId;
        let value;
        for (let n = 0; n < 48; n++) {
          value = await get(kind + '-poll-' + rr + '-' + n, rr, readPath);
          if (['COMPLETED', 'FAILED'].includes(value.status)) break;
          await new Promise((resolve) => setTimeout(resolve, 5000));
        }
        proof(kind + '-completed-' + rr, value.status === 'COMPLETED');
        if (kind === 'esg' && rr === 'CustomerAdmin') {
          requireReadback(
            CURRENT_TEST_CONFIG.authorization.ownFixtureFaults.actions.includes('EXPIRED_ESG_EXPORT_LEASE'),
          );
          const injected = await db('business-inject-export-lease', undefined, {
            exportId: job.exportId,
            faultAuthorization: 'USER_CONFIRMED_OWN_FIXTURE_ONLY_2026_10_03',
          });
          proof('own-lease-expired', injected.exportLease.expired === true);
          for (let n = 0; n < 48; n++) {
            value = await get('lease-recovery-' + n, rr, readPath);
            if (['COMPLETED', 'FAILED'].includes(value.status)) break;
            await new Promise((resolve) => setTimeout(resolve, 5000));
          }
          proof('expired-lease-recovered', value.status === 'COMPLETED');
        }
        const response = await fetch(value.downloadUrl, { signal: AbortSignal.timeout(20000) });
        const bytes = Buffer.from(await response.arrayBuffer());
        proof(kind + '-download-' + rr, response.status === 200 && bytes.length > 0 && bytes.length < 1048576);
        proof(
          kind + '-csv-row-count-' + rr,
          Number.isInteger(value.rowCount) &&
            value.rowCount >= 0 &&
            bytes.toString('utf8').trim().split('\n').length - 1 === value.rowCount,
        );
        const csvReceipt = ctx.receiptPath + '.' + kind + '-' + rr + '.csv';
        writeFileSync(csvReceipt, bytes);
        r.checks.push({
          id: kind + '-csv-' + rr,
          result: 'PASS',
          csvReceipt,
          sha256: createHash('sha256').update(bytes).digest('hex'),
          bytes: bytes.length,
          rowCount: value.rowCount,
        });
      }
    }
    r.recovery = 'PASS';
  } catch (e) {
    r.recovery = 'FAIL';
    r.recoveryFailure = e.code ?? (/^[A-Z_]+$/.test(e.message) ? e.message : 'RECOVERY_TARGET_FAILED');
  }
  r.gate = [r.legalWrites, r.security, r.recovery].every((x) => x === 'PASS') ? 'PASS' : 'FAIL';
  return r;
}
