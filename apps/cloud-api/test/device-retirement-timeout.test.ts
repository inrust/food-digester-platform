/** DEC-014 72 小时退役超时评估器验收。 */
import { afterAll, beforeAll, describe, test } from 'vitest';
import { assert } from 'vitest';
import type { PrismaClient } from '@fdp/database';
import {
  COMPLETION_DEVICE_CONFIRM,
  COMPLETION_FORCE_COMPLETE,
  completeRetirementStep,
  evaluateRetirementTimeouts,
} from '../src/index.js';
import { createTestDb } from './helpers.js';

const NOW = new Date('2026-09-04T12:00:00Z');
const HOUR_MS = 60 * 60 * 1000;
let pg: Awaited<ReturnType<typeof createTestDb>>['pg'];
let prisma: InstanceType<typeof PrismaClient>;
let seq = 0;

beforeAll(async () => {
  ({ pg, prisma } = await createTestDb());
}, 60_000);

afterAll(async () => {
  await prisma.$disconnect();
  await pg.close();
});

async function seedPending(hoursAgo: number): Promise<{ deviceId: string; certificateId: string }> {
  seq += 1;
  const deviceId = `dev-timeout-${seq}`;
  const certificateId = `cert-timeout-${seq}`;
  await prisma.device.create({
    data: {
      id: deviceId,
      serialNumber: `SN-TIMEOUT-${seq}`,
      model: 'BNX-100',
      hardwareVersion: 'HW1',
      manufacturer: 'Hiddenjoy',
      manufactureDate: new Date('2026-01-01T00:00:00Z'),
      lifecycleStatus: 'Retired',
    },
  });
  await prisma.deviceCertificate.create({
    data: {
      id: certificateId,
      deviceId,
      fingerprint: `${seq}`.padStart(64, '0'),
      status: 'ACTIVE',
      notBefore: new Date('2026-01-01T00:00:00Z'),
      notAfter: new Date('2027-01-01T00:00:00Z'),
    },
  });
  await prisma.deviceRetirement.create({
    data: {
      deviceId,
      reason: 'offline retirement',
      initiatedBy: 'admin',
      initiatedAt: new Date(NOW.getTime() - hoursAgo * HOUR_MS),
    },
  });
  return { deviceId, certificateId };
}

describe('evaluateRetirementTimeouts', () => {
  test('72 小时前不处理；精确边界完成、撤证并记录稳定审计', async () => {
    const early = await seedPending(71);
    const due = await seedPending(72);

    const result = await evaluateRetirementTimeouts(prisma, { now: NOW });
    assert.equal(result.completed, 1);
    assert.deepEqual(result.completedDeviceIds, [due.deviceId]);

    const earlyRetirement = await prisma.deviceRetirement.findUniqueOrThrow({ where: { deviceId: early.deviceId } });
    assert.equal(earlyRetirement.status, 'PENDING_CONFIRMATION');
    const dueRetirement = await prisma.deviceRetirement.findUniqueOrThrow({ where: { deviceId: due.deviceId } });
    assert.equal(dueRetirement.status, 'CONFIRMED');
    assert.equal(dueRetirement.completionMethod, 'UNCONFIRMED_TIMEOUT');
    assert.equal(dueRetirement.confirmedAt?.toISOString(), NOW.toISOString());
    const cert = await prisma.deviceCertificate.findUniqueOrThrow({ where: { id: due.certificateId } });
    assert.equal(cert.status, 'REVOKED');

    const audits = await prisma.auditLog.findMany({
      where: { objectId: due.deviceId, action: 'device.retire.timeout' },
    });
    assert.equal(audits.length, 1);
    assert.equal(audits[0]?.reason, 'UNCONFIRMED_TIMEOUT');
    assert.equal(audits[0]?.result, 'SUCCESS');
  });

  test('重复调度幂等：不重复撤证或审计', async () => {
    const due = await seedPending(80);
    const first = await evaluateRetirementTimeouts(prisma, { now: NOW });
    const second = await evaluateRetirementTimeouts(prisma, { now: NOW });
    assert.isTrue(first.completedDeviceIds.includes(due.deviceId));
    assert.equal(second.completed, 0);
    assert.equal(
      await prisma.auditLog.count({ where: { objectId: due.deviceId, action: 'device.retire.timeout' } }),
      1,
    );
  });

  test('并发评估只有一个胜出者和一条审计', async () => {
    const due = await seedPending(90);
    const results = await Promise.all([
      evaluateRetirementTimeouts(prisma, { now: NOW }),
      evaluateRetirementTimeouts(prisma, { now: NOW }),
    ]);
    assert.equal(
      results.reduce((sum, item) => sum + item.completed, 0),
      1,
    );
    assert.equal(
      await prisma.auditLog.count({ where: { objectId: due.deviceId, action: 'device.retire.timeout' } }),
      1,
    );
  });

  test('并发 Deactivate/force-complete 只有一个完成方式胜出并仅撤证一次', async () => {
    const due = await seedPending(1);
    const results = await Promise.all([
      completeRetirementStep(prisma, {
        deviceId: due.deviceId,
        at: NOW,
        completionMethod: COMPLETION_DEVICE_CONFIRM,
      }),
      completeRetirementStep(prisma, {
        deviceId: due.deviceId,
        at: NOW,
        completionMethod: COMPLETION_FORCE_COMPLETE,
      }),
    ]);
    assert.equal(results.filter((result) => result.confirmed).length, 1);
    assert.equal(
      results.reduce((count, result) => count + result.revoked.length, 0),
      1,
    );
    const retirement = await prisma.deviceRetirement.findUniqueOrThrow({ where: { deviceId: due.deviceId } });
    assert.include([COMPLETION_DEVICE_CONFIRM, COMPLETION_FORCE_COMPLETE], retirement.completionMethod);
    assert.equal(await prisma.deviceCertificate.count({ where: { deviceId: due.deviceId, status: 'REVOKED' } }), 1);
  });
});
