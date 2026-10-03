import test from 'node:test';
import assert from 'node:assert/strict';
import { createTestDb } from '../apps/cloud-api/test/helpers.ts';
import { createAdminLicenseHandlers } from '../apps/cloud-api/src/admin/license/handler.ts';
import { runTargetLicenseLifecycle } from './qa09-license-lifecycle.mjs';
test('target License wire sequence proves ExpiringSoon renewal and Renewed activation using real handlers and PostgreSQL', async () => {
  const { pg, prisma } = await createTestDb(),
    now = Date.parse('2026-10-03T01:00:00Z');
  try {
    const c = await prisma.customer.create({ data: { name: 'qa09-local-license' } });
    const s = await prisma.site.create({ data: { name: 'qa09-local-site', customerId: c.id } });
    await prisma.device.create({
      data: {
        id: 'qa09-local-device',
        serialNumber: 'qa09-local-device',
        model: 'BNX-100',
        hardwareVersion: '1',
        manufacturer: 'Bio-Nexa',
        manufactureDate: new Date('2026-01-01'),
        lifecycleStatus: 'Assigned',
        customerId: c.id,
        siteId: s.id,
      },
    });
    const h = createAdminLicenseHandlers({
      client: prisma,
      signingKey: 'qa09-local-signing-key',
      now: () => new Date(now),
    });
    const actor = {
      actorId: 'qa09-local-operator',
      username: 'qa09-local-operator',
      actorType: 'platform',
      roles: ['PlatformOperator'],
      customerId: null,
      tokenUse: 'id',
    };
    const rows = [];
    const api = async (id, role, method, path, expected, body, headers = {}) => {
      assert.equal(role, 'PlatformOperator');
      const parts = path.split('/'),
        licenseId = parts[5];
      const action = method === 'GET' ? (parts[6] === 'history' ? 'history' : 'detail') : (parts[6] ?? 'create');
      const req = {
        actor,
        requestId: 'qa09-local-' + id,
        headers,
        params: { licenseId },
        ...(body === undefined ? {} : { body }),
      };
      if (id === 'license-before-renew-evaluate') {
        const before = await prisma.licenseHistory.count();
        const rejected = await h.renew({ ...req, body: { newValidTo: new Date(now + 86400000 * 60).toISOString() } });
        assert.equal(rejected.status, 409);
        assert.equal(rejected.body.error.code, 'DEVICE_STATE_NOT_ALLOWED');
        assert.equal(await prisma.licenseHistory.count(), before);
      }
      const response = await h[action](req);
      assert.equal(response.status, expected, JSON.stringify(response.body));
      rows.push({ id, status: response.body.data?.status, replayed: response.body.data?.replayed });
      return response.body;
    };
    await runTargetLicenseLifecycle(api, {
      deviceId: 'qa09-local-device',
      prefix: 'qa09-local',
      now,
      from: new Date(now - 86400000).toISOString(),
      to: new Date(now + 86400000 * 30).toISOString(),
    });
    assert.equal(rows.find((x) => x.id === 'license-before-renew-evaluate').status, 'ExpiringSoon');
    assert.equal(rows.find((x) => x.id === 'license-renew-replay').replayed, true);
    assert.equal(rows.find((x) => x.id === 'license-reactivate-renewed').status, 'Active');
    assert.equal((await prisma.license.findFirst()).status, 'Revoked');
    assert.equal(await prisma.licenseHistory.count(), 7);
  } finally {
    await prisma.$disconnect();
    await pg.close();
  }
});
