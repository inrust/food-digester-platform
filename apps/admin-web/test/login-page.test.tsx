// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import { LoginPage } from '../src/app/LoginPage.js';
import type { AuthFlow } from '../src/auth/auth-flow.js';
import { I18nProvider } from '../src/i18n/i18n.js';

afterEach(cleanup);

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
  await user.type(screen.getByLabelText('用户名'), 'new-user@example.com');
  await user.type(screen.getByLabelText('密码'), 'Temporary-Password-1');
  await user.click(screen.getByRole('button', { name: '登录' }));

  const notice = await screen.findByTestId('new-password-notice');
  expect(within(notice).getByText('首次登录')).toBeDefined();
  expect(within(notice).getByRole('heading', { name: '请设置新的登录密码' })).toBeDefined();
  expect(notice.textContent).toContain('临时密码已验证');
  expect(screen.getByLabelText('创建新密码')).toBeDefined();
  expect(screen.getByRole('button', { name: '设置新密码并登录' })).toBeDefined();
});
