import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { main } from './run-qa09-ten-device-acceptance.mjs';
import { validateBusinessVersion } from './check-qa09-business-target.mjs';
const [mode, output, versionFile] = process.argv.slice(2);
if (!['csr', 'certificate'].includes(mode) || !output || !versionFile)
  throw Error('ENTITY_MODE_OUTPUT_VERSION_REQUIRED');
const version = JSON.parse(readFileSync(versionFile));
validateBusinessVersion(version, version.sourceCommit);
const paths = [
  'scripts/run-qa09-entity-semantics-target.mjs',
  'scripts/run-qa09-ten-device-acceptance.mjs',
  'scripts/qa09-version-inputs.mjs',
  'scripts/qa09-seed-recovery.mjs',
  'scripts/qa09-ten-device-db.mjs',
  'scripts/qa09-ten-device-bridge.mjs',
  'scripts/qa09-db-log-frames.mjs',
  'scripts/qa09-db-frame-wait.mjs',
  'scripts/qa09-archive-reader.mjs',
  'scripts/qa09-archive-probe.mjs',
  'scripts/qa09-own-s3-cli.mjs',
  'scripts/device-simulator/core.mjs',
  'scripts/qa09-current-environment.mjs',
  'infra/environments/qa09-current-test.json',
];
const source = paths.map((path) => {
  const b = readFileSync(path);
  return { path, sha256: createHash('sha256').update(b).digest('hex'), sourceBase64: b.toString('base64') };
});
writeFileSync(output + '.sources.json', JSON.stringify({ task: 'QA-09', sources: source }, null, 2) + '\n');
const { chromium, expect } = createRequire(new URL('../apps/admin-web/package.json', import.meta.url))(
  '@playwright/test',
);
const r = {
  task: 'QA-09',
  scope: 'REAL_NONACTIVE_ENTITY_' + mode.toUpperCase(),
  sourceCommit: version.sourceCommit,
  apiMock: false,
  credentialsExported: false,
  fullQa09Accepted: false,
  startedAt: new Date().toISOString(),
  executions: [],
  layouts: [],
  gate: 'RUNNING',
};
const save = () => writeFileSync(output, JSON.stringify(r, null, 2) + '\n');
save();
async function pageFor(width, login, fn) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width, height: 900 }, locale: 'zh-CN' });
  const page = await context.newPage();
  try {
    await page.goto('https://admin.bio-nexa.com/login');
    await page.getByLabel('用户名').fill(login.username);
    await page.getByLabel('密码', { exact: true }).fill(login.password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.waitForURL('**/dashboard', { timeout: 30000 });
    await fn(page);
    await page.waitForLoadState('networkidle');
    const dimensions = await page.evaluate(() => ({
      viewport: window.innerWidth,
      document: document.documentElement.scrollWidth,
      body: document.body.scrollWidth,
    }));
    const layout = {
      width,
      ...dimensions,
      result: Math.max(dimensions.document, dimensions.body) <= width + 1 ? 'PASS' : 'FAIL',
    };
    r.layouts.push(layout);
    save();
    if (layout.result !== 'PASS') throw Error('ENTITY_VIEWPORT_OVERFLOW');
  } finally {
    await context.close();
    await browser.close();
  }
}
const extension = async (ctx) => {
  if (mode !== 'certificate') throw Error('REVIEW_ONLY_EXTENSION_MUST_NOT_ENTER_DEVICE_WAVE');
  r.prefix = ctx.receipt.prefix;
  ctx.receipt.batchArchiveCleanup = true;
  for (const [i, width] of [375, 1440].entries()) {
    const own = ctx.receipt.devices[i],
      row = { group: 'device-manage.certificate', width, deviceId: own, result: 'RUNNING' };
    r.executions.push(row);
    save();
    await pageFor(width, ctx.browserLogin, async (page) => {
      const before = (await ctx.api('entity-cert-before-' + width, 'GET', '/api/v1/admin/devices/' + own, 200)).data;
      if (
        before.lifecycleStatus === 'Active' ||
        before.certificate?.status !== 'ACTIVE' ||
        !before.certificate.mqttVerifiedAt ||
        !before.certificate.restVerifiedAt
      )
        throw Error('REAL_NONACTIVE_CERTIFICATE_REQUIRED');
      await page.goto('https://admin.bio-nexa.com/devices/manage?deviceId=' + own);
      await expect(page.getByTestId('cert-id')).toHaveText(before.certificate.certificateId);
      await expect(page.getByTestId('cert-fingerprint')).toHaveText(before.certificate.fingerprint);
      const pending = page.waitForResponse(
        (res) =>
          res.request().method() === 'POST' &&
          new URL(res.url()).pathname === '/api/v1/admin/devices/' + own + '/certificate-rotation-requests',
      );
      await page.getByTestId('cert-rotate').click();
      const response = await pending;
      if (![200, 201].includes(response.status())) throw Error('ROTATION_REQUEST_FAILED');
      const request = (await response.json()).data;
      await expect(page.getByTestId('rotation-result')).toContainText(request.requestId);
      const replay = (
        await ctx.api(
          'entity-cert-rotation-replay-' + width,
          'POST',
          '/api/v1/admin/devices/' + own + '/certificate-rotation-requests',
          200,
        )
      ).data;
      if (
        request.requestId !== replay.requestId ||
        request.requestStatus !== 'PENDING' ||
        request.certificateId !== before.certificate.certificateId
      )
        throw Error('ROTATION_READBACK_FAILED');
      Object.assign(row, {
        result: 'PASS',
        certificateId: before.certificate.certificateId,
        fingerprint: before.certificate.fingerprint,
        rotationRequestId: request.requestId,
        gatewayRequestId: response.headers()['x-amzn-requestid'],
        requestId: response.headers()['x-amzn-requestid'],
        method: 'POST',
        role: 'PlatformSuperAdmin',
        path: '/api/v1/admin/devices/' + own + '/certificate-rotation-requests',
        status: response.status(),
        proof: 'REAL_CERTIFICATE_DETAILS_AND_IDEMPOTENT_PENDING_ROTATION_INTENT_NOT_COMPLETED_ROTATION',
      });
      save();
    });
  }
};
extension.beforeApproval = async (ctx) => {
  if (mode !== 'csr') throw Error('WRONG_ENTITY_REVIEW_MODE');
  r.prefix = ctx.prefix;
  const index = ctx.devices.indexOf(ctx.id);
  if (index > 3) return;
  const width = index % 2 ? 1440 : 375,
    decision = index < 2 ? 'approve' : 'reject';
  const row = {
    group: 'device-group.onboarding',
    width,
    decision,
    deviceId: ctx.id,
    requestId: ctx.requestId,
    result: 'RUNNING',
  };
  r.executions.push(row);
  save();
  await pageFor(width, ctx.browserLogin, async (page) => {
    await page.goto('https://admin.bio-nexa.com/devices/groups');
    await expect(page.getByTestId('detail-' + ctx.requestId)).toBeVisible();
    const table = page.getByTestId('onboarding-review');
    await expect(table.getByRole('columnheader', { name: '设备唯一ID（序列号）', exact: true })).toBeVisible();
    await expect(table.getByRole('columnheader', { name: '申请日期', exact: true })).toBeVisible();
    await page.getByTestId('detail-' + ctx.requestId).click();
    await expect(page.getByTestId('request-detail')).toContainText(ctx.id);
    await expect(page.getByTestId('detail-csr-fingerprint')).toHaveText(ctx.detail.publicKeyFingerprint);
    await page.getByTestId(decision === 'approve' ? 'approve-button' : 'reject-button').click();
    const dialog = page.getByTestId('confirm-dialog');
    await expect(dialog).toBeVisible();
    if (decision === 'reject') {
      await expect(dialog.locator('.dialog-actions button').last()).toBeDisabled();
      await dialog.locator('textarea').fill(ctx.prefix + '-browser-reject');
    }
    const pending = page.waitForResponse(
      (res) =>
        res.request().method() === 'POST' &&
        new URL(res.url()).pathname === '/api/v1/admin/onboarding/requests/' + ctx.requestId + '/' + decision,
    );
    await dialog.locator('.dialog-actions button').last().click();
    const response = await pending;
    if (response.status() !== 200) throw Error('CSR_BROWSER_REVIEW_FAILED');
    const result = (
      await ctx.api('entity-csr-readback-' + index, 'GET', '/api/v1/admin/onboarding/requests/' + ctx.requestId, 200)
    ).data;
    if (
      result.status !== (decision === 'approve' ? 'APPROVED' : 'REJECTED') ||
      result.version <= ctx.detail.version ||
      (decision === 'reject' && result.rejectReason !== ctx.prefix + '-browser-reject')
    )
      throw Error('CSR_DECISION_NOT_PERSISTED');
    Object.assign(row, {
      result: 'PASS',
      version: result.version,
      gatewayRequestId: response.headers()['x-amzn-requestid'],
      httpRequestId: response.headers()['x-amzn-requestid'],
      method: 'POST',
      role: 'PlatformSuperAdmin',
      path: '/api/v1/admin/onboarding/requests/' + ctx.requestId + '/' + decision,
      httpStatus: response.status(),
      ifMatch: response.request().headers()['if-match'],
      status: result.status,
      proof: 'GENUINE_LOCAL_CSR_REAL_BROWSER_DECISION_API_READBACK',
    });
    save();
  });
};
let parent;
try {
  parent = await main(output + '.devices.json', versionFile, extension, { reviewOnly: mode === 'csr' });
  r.prefix = parent.prefix;
  r.parentReceipt = output + '.devices.json';
  r.parentReceiptSha256 = createHash('sha256').update(readFileSync(r.parentReceipt)).digest('hex');
  if (parent.gate !== 'PASS' || parent.cleanup.some((x) => x.result !== 'PASS'))
    throw Error('ENTITY_PARENT_OR_CLEANUP_FAILED');
  if (source.some((s) => createHash('sha256').update(readFileSync(s.path)).digest('hex') !== s.sha256))
    throw Error('ENTITY_EXECUTOR_SOURCE_DRIFT');
  if (
    mode === 'csr' &&
    [375, 1440].some((width) =>
      ['approve', 'reject'].some(
        (decision) => !r.executions.some((x) => x.width === width && x.decision === decision && x.result === 'PASS'),
      ),
    )
  )
    throw Error('CSR_BOTH_DECISIONS_AND_VIEWPORTS_REQUIRED');
  if (
    mode === 'certificate' &&
    [375, 1440].some((width) => !r.executions.some((x) => x.width === width && x.result === 'PASS'))
  )
    throw Error('CERTIFICATE_BOTH_VIEWPORTS_REQUIRED');
  r.gate = 'PASS';
  r.cleanupVerified = true;
} catch (e) {
  r.gate = 'FAIL';
  r.errorCode = /^[A-Z_]+$/.test(e.message) ? e.message : 'ENTITY_TARGET_FAILED';
} finally {
  r.finishedAt = new Date().toISOString();
  save();
}
console.log(
  JSON.stringify({ gate: r.gate, prefix: r.prefix, executions: r.executions.length, errorCode: r.errorCode }),
);
process.exitCode = r.gate === 'PASS' ? 0 : 1;
