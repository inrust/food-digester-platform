import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runSignedSessionTarget } from './run-qa09-signed-session-target.mjs';
import { runFixture } from './qa09-ten-device-bridge.mjs';
import { validatePlan, PROJECT } from './qa09-ten-device-db.mjs';
import { runUserCloseoutBrowser } from './qa09-user-closeout-browser.mjs';

/** Only test fixture preparation; no invitation API, email, Active or authentication shortcut. */
export async function provisionSuppressedOwnUser(
  { prefix, own, customers, call, sdk, receipt, save },
  fixture = runFixture,
) {
  const userId = randomUUID();
  const planFor = (cognitoSub) => ({
    action: 'business-seed-user',
    prefix,
    customers,
    devices: Array.from({ length: 10 }, (_, i) => `${prefix}-${String(i + 1).padStart(2, '0')}`),
    ownUser: {
      userId,
      email: own.email,
      role: own.role,
      customerId: own.customerId,
      cognitoSub,
      identityProvisioning: 'COGNITO_SUPPRESS_REAL_SUBJECT',
    },
  });
  validatePlan(planFor(randomUUID())); // Validate ownership before any external mutation.
  const password = 'A!z9' + randomBytes(24).toString('base64url');
  const created = await call(sdk.AdminCreateUserCommand, {
    Username: own.email,
    MessageAction: 'SUPPRESS',
    TemporaryPassword: password,
    UserAttributes: [
      { Name: 'email', Value: own.email },
      { Name: 'email_verified', Value: 'true' },
      ...(own.customerId ? [{ Name: 'custom:customer_id', Value: own.customerId }] : []),
    ],
  });
  const sub = created.User?.Attributes?.find((a) => a.Name === 'sub')?.Value;
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(sub ?? ''))
    throw Error('REAL_COGNITO_SUBJECT_REQUIRED');
  await call(sdk.AdminAddUserToGroupCommand, { Username: own.email, GroupName: own.role });
  own.preparedUserId = userId;
  save();
  const plan = planFor(sub);
  validatePlan(plan);
  const path = receipt.outputPath + '.seed-' + own.role + '.json';
  (receipt.fixtureBuilds ??= []).push({ action: plan.action, role: own.role, receipt: path, gate: 'RUNNING' });
  save();
  const sourceHash = createHash('sha256')
    .update(readFileSync(new URL('./qa09-ten-device-db.mjs', import.meta.url)))
    .digest('hex');
  let result;
  try {
    result = await fixture(plan, path, () => save());
  } catch (error) {
    const row = receipt.fixtureBuilds.at(-1);
    row.gate = 'FAIL';
    // Preserve the original receipt and never re-submit a Plan with unknown start outcome.
    let original;
    try {
      original = JSON.parse(readFileSync(path));
    } catch {
      /* no receipt available */
    }
    if (original?.failure?.startedBuildMayStillRun || original?.failure?.kind === 'START_OUTCOME_UNCONFIRMED') {
      row.startGate = 'UNKNOWN';
      save();
      throw Error('UNKNOWN_USER_SEED_START_NO_RESTART');
    }
    save();
    throw error;
  }
  if (
    result.gate !== 'PASS' ||
    result.sourceHash !== sourceHash ||
    result.result?.sourceHash !== sourceHash ||
    result.build?.status !== 'SUCCEEDED' ||
    !result.build.id?.startsWith(PROJECT + ':') ||
    result.build.serviceRole !== 'arn:aws:iam::065986019555:role/fdp-test-migration-runner-role' ||
    result.result?.prefix !== prefix ||
    result.result?.action !== plan.action ||
    result.result?.user?.userId !== userId ||
    result.result.invitationSent !== false ||
    result.result.user.status !== 'INVITED'
  )
    throw Error('OWN_USER_FIXTURE_NOT_BOUND');
  receipt.fixtureBuilds.at(-1).gate = 'PASS';
  receipt.fixtureBuilds.at(-1).buildId = result.build.id;
  receipt.fixtureBuilds.at(-1).sha256 = createHash('sha256').update(readFileSync(path)).digest('hex');
  own.userId = userId;
  save();
  return result.result.user;
}
export async function runUserCloseout(output, versionPath) {
  // Keep the receipt path in metadata; credentials remain in memory only.
  return runSignedSessionTarget(output, versionPath, {
    beforeUserDisable: runUserCloseoutBrowser,
    provisionWithoutNotification: async (ctx) => {
      ctx.receipt.outputPath = output;
      return provisionSuppressedOwnUser(ctx);
    },
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [output, version] = process.argv.slice(2);
  if (!output || !version) throw Error('OUTPUT_AND_VERSION_REQUIRED');
  const result = await runUserCloseout(output, version);
  process.exitCode = result.gate.startsWith('PASS_') ? 0 : 1;
}
