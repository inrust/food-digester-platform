import { expect } from '@playwright/test';
import { test } from './qa05-fixture.js';
import { FakeCognitoServer } from '../test/fake-cognito.js';
import { dashboard, json } from './qa05-api-fixtures.js';

for (const width of [375, 1440]) {
  test(`管理员邮件重置验证码 → 新密码 → 邮箱别名 SRP 登录 (${width}px)`, async ({ page, qa05 }) => {
    await page.setViewportSize({ width, height: 900 });
    const email = `${qa05.prefix.toLowerCase()}@example.com`;
    const internalUsername = `${qa05.prefix}-internal-reset-user`;
    const server = new FakeCognitoServer({
      userPoolId: 'us-east-1_local',
      users: {
        [email]: {
          cognitoUsername: internalUsername,
          password: 'OldPass123',
          groups: ['PlatformSuperAdmin'],
          resetRequired: true,
          resetCode: '654321',
        },
      },
    });
    await page.route('https://cognito-idp.us-east-1.amazonaws.com/', async (route) => {
      const operation = route.request().headers()['x-amz-target']?.split('.').at(-1) ?? '';
      const response = await server.fetch(operation, route.request().postDataJSON() as Record<string, unknown>);
      await json(route, response.body, response.status);
    });
    await page.route('**/api/v1/admin/dashboard/overview', (route) => json(route, { data: dashboard, meta: {} }));
    await page.goto('/login');
    await page.getByLabel('用户名').fill(email);
    await page.getByLabel('密码', { exact: true }).fill('654321');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.getByRole('heading', { name: '使用邮件验证码设置新密码' })).toBeVisible();
    await expect(page.getByRole('status')).toContainText('不能作为登录密码');
    expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
    await page.getByLabel('新密码', { exact: true }).fill('NewPass123');
    await page.getByLabel('验证码', { exact: true }).fill('654321');
    await page.getByRole('button', { name: '设置新密码', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('密码已重置');
    expect(server.calls.some((call) => call.operation === 'ForgotPassword')).toBe(false);
    expect(await page.evaluate(() => sessionStorage.getItem('fdp.admin.session.v1'))).toBeNull();
    await page.getByLabel('密码', { exact: true }).fill('OldPass123');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('用户名或密码错误');
    await page.getByLabel('密码', { exact: true }).fill('NewPass123');
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(page).toHaveURL(/\/dashboard$/);
    const challenges = server.calls.filter((call) => call.operation === 'RespondToAuthChallenge');
    expect(challenges.length).toBe(2);
    for (const call of challenges) {
      expect((call.payload['ChallengeResponses'] as Record<string, unknown>)['USERNAME']).toBe(internalUsername);
    }
    qa05.proof.passwordResetLogin = true;
    qa05.proof.canonicalUsername = true;
  });
}
