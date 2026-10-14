// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import { LoginPage } from '../src/app/LoginPage.js';
import type { AuthFlow } from '../src/auth/auth-flow.js';
import { CognitoIdpError } from '../src/auth/cognito-idp.js';
import { I18nProvider } from '../src/i18n/i18n.js';

afterEach(cleanup);

test.each([
  ['zh-CN', '邮箱', '已有重置验证码', '新密码', '验证码', '设置新密码', '登录'],
  ['en', 'Email', 'Already have a reset code', 'New password', 'Verification code', 'Set new password', 'Login'],
] as const)(
  '管理员邮件验证码：%s 直接确认新密码，不重发或尝试用验证码登录',
  async (language, usernameLabel, haveCode, passwordLabel, codeLabel, submitLabel, loginLabel) => {
    const user = userEvent.setup();
    const auth = {
      login: vi.fn(),
      forgotPassword: vi.fn(),
      confirmForgotPassword: vi.fn().mockResolvedValue(undefined),
    };
    const onAuthenticated = vi.fn();
    render(
      <I18nProvider initialLanguage={language}>
        <LoginPage auth={auth as unknown as AuthFlow} onAuthenticated={onAuthenticated} />
      </I18nProvider>,
    );
    await user.type(screen.getByLabelText(usernameLabel), 'reset@example.com');
    await user.click(screen.getByRole('button', { name: haveCode }));
    expect(screen.getByRole('status').textContent).toContain(
      language === 'zh-CN' ? '不能作为登录密码' : 'not a sign-in password',
    );
    await user.type(screen.getByLabelText(passwordLabel), 'NewPass123');
    await user.type(screen.getByLabelText(codeLabel), '654321');
    await user.click(screen.getByRole('button', { name: submitLabel }));
    expect(auth.confirmForgotPassword).toHaveBeenCalledWith('reset@example.com', '654321', 'NewPass123');
    expect(auth.forgotPassword).not.toHaveBeenCalled();
    expect(auth.login).not.toHaveBeenCalled();
    expect(onAuthenticated).not.toHaveBeenCalled();
    expect(await screen.findByRole('button', { name: loginLabel })).toBeDefined();
    expect((screen.getByLabelText(language === 'zh-CN' ? '密码' : 'Password') as HTMLInputElement).value).toBe('');
  },
);

test('登录遇到 RESET_REQUIRED 自动转到验证码确认页且保留邮箱，不另发验证码', async () => {
  const user = userEvent.setup();
  const auth = {
    login: vi.fn().mockRejectedValue(new CognitoIdpError('PASSWORD_RESET_REQUIRED', 'reset required')),
    forgotPassword: vi.fn(),
  };
  render(
    <I18nProvider initialLanguage="zh-CN">
      <LoginPage auth={auth as unknown as AuthFlow} onAuthenticated={vi.fn()} />
    </I18nProvider>,
  );
  await user.type(screen.getByLabelText('邮箱'), 'reset@example.com');
  await user.type(screen.getByLabelText('密码'), '654321');
  await user.click(screen.getByRole('button', { name: '登录' }));
  expect(await screen.findByRole('heading', { name: '使用邮件验证码设置新密码' })).toBeDefined();
  expect((screen.getByLabelText('邮箱') as HTMLInputElement).value).toBe('reset@example.com');
  expect((screen.getByLabelText('新密码') as HTMLInputElement).value).toBe('');
  expect(auth.forgotPassword).not.toHaveBeenCalled();
});

test.each(['CODE_MISMATCH', 'CODE_EXPIRED'] as const)(
  '重置失败 %s：保留确认流程、清除密码且可重新获取验证码',
  async (errorCode) => {
    const user = userEvent.setup();
    const auth = {
      confirmForgotPassword: vi.fn().mockRejectedValue(new CognitoIdpError(errorCode, 'provider error')),
      forgotPassword: vi.fn().mockResolvedValue(undefined),
    };
    render(
      <I18nProvider initialLanguage="zh-CN">
        <LoginPage auth={auth as unknown as AuthFlow} onAuthenticated={vi.fn()} />
      </I18nProvider>,
    );
    await user.type(screen.getByLabelText('邮箱'), 'reset@example.com');
    await user.click(screen.getByRole('button', { name: '已有重置验证码' }));
    await user.type(screen.getByLabelText('新密码'), 'NewPass123');
    await user.type(screen.getByLabelText('验证码'), '000000');
    await user.click(screen.getByRole('button', { name: '设置新密码' }));
    expect((await screen.findByRole('alert')).textContent).toContain(
      errorCode === 'CODE_EXPIRED' ? '已过期' : '不正确',
    );
    expect((screen.getByLabelText('新密码') as HTMLInputElement).value).toBe('');
    await user.click(screen.getByRole('button', { name: '重新获取验证码' }));
    await user.click(screen.getByRole('button', { name: '发送验证码' }));
    expect(auth.forgotPassword).toHaveBeenCalledWith('reset@example.com');
    expect(((await screen.findByLabelText('验证码')) as HTMLInputElement).value).toBe('');
  },
);

test('临时密码登录后突出显示首次登录改密说明与明确提交动作', async () => {
  const user = userEvent.setup();
  const login = vi.fn().mockResolvedValue({ status: 'new-password-required' });
  const auth = { login } as unknown as AuthFlow;

  render(
    <I18nProvider initialLanguage="zh-CN">
      <LoginPage auth={auth} onAuthenticated={vi.fn()} />
    </I18nProvider>,
  );

  expect(screen.queryByTestId('new-password-notice')).toBeNull();
  await user.type(screen.getByLabelText('邮箱'), 'new-user@example.com');
  await user.type(screen.getByLabelText('密码'), 'Temporary-Password-1');
  await user.click(screen.getByRole('button', { name: '登录' }));

  const notice = await screen.findByTestId('new-password-notice');
  expect(within(notice).getByText('首次登录')).toBeDefined();
  expect(within(notice).getByRole('heading', { name: '请设置新的登录密码' })).toBeDefined();
  expect(notice.textContent).toContain('临时密码已验证');
  expect(screen.getByLabelText('创建新密码')).toBeDefined();
  expect(screen.getByRole('button', { name: '设置新密码并登录' })).toBeDefined();
});

test('设置新密码失败时显示具体规则且不暴露身份服务英文错误', async () => {
  const user = userEvent.setup();
  const auth = {
    login: vi.fn().mockResolvedValue({ status: 'new-password-required' }),
    submitNewPassword: vi
      .fn()
      .mockRejectedValue(new CognitoIdpError('PASSWORD_REQUIRES_NUMBER', 'The new password requires a number')),
  } as unknown as AuthFlow;

  render(
    <I18nProvider initialLanguage="zh-CN">
      <LoginPage auth={auth} onAuthenticated={vi.fn()} />
    </I18nProvider>,
  );

  await user.type(screen.getByLabelText('邮箱'), 'new-user@example.com');
  await user.type(screen.getByLabelText('密码'), 'Temporary-Password-1');
  await user.click(screen.getByRole('button', { name: '登录' }));
  await user.type(await screen.findByLabelText('创建新密码'), 'No-Numbers');
  await user.click(screen.getByRole('button', { name: '设置新密码并登录' }));

  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toBe('新密码必须至少包含一个数字（0–9）。');
  expect(alert.textContent).not.toContain('identity provider');
});
