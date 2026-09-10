import { useState } from 'react';
import type { FormEvent } from 'react';
import type { AuthFlow, LoginOutcome } from '../auth/auth-flow.js';

export interface LoginPageProps {
  readonly auth: AuthFlow;
  readonly onAuthenticated: () => void;
}

type LoginStep = 'credentials' | 'mfa' | 'new-password' | 'forgot' | 'confirm-forgot';

export function LoginPage({ auth, onAuthenticated }: LoginPageProps) {
  const [step, setStep] = useState<LoginStep>('credentials');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const handleOutcome = (outcome: LoginOutcome) => {
    setPassword('');
    if (outcome.status === 'authenticated') onAuthenticated();
    else if (outcome.status === 'mfa-required') setStep('mfa');
    else if (outcome.status === 'new-password-required') setStep('new-password');
    else setMessage('账号需要先完成 MFA 绑定，请联系管理员。');
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      if (step === 'credentials') handleOutcome(await auth.login(username.trim(), password));
      else if (step === 'mfa') handleOutcome(await auth.submitMfaCode(code.trim()));
      else if (step === 'new-password') handleOutcome(await auth.submitNewPassword(password));
      else if (step === 'forgot') {
        await auth.forgotPassword(username.trim());
        setStep('confirm-forgot');
        setMessage('验证码已发送。');
      } else {
        await auth.confirmForgotPassword(username.trim(), code.trim(), password);
        setPassword('');
        setCode('');
        setStep('credentials');
        setMessage('密码已重置，请重新登录。');
      }
    } catch (error) {
      setPassword('');
      setMessage(error instanceof Error ? error.message : '操作失败，请稍后重试。');
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="login-page">
      <form className="login-card" onSubmit={(event) => void submit(event)}>
        <h1>厨余机云平台</h1>
        <p>管理后台</p>
        <label htmlFor="username">用户名</label>
        <input
          id="username"
          autoComplete="username"
          value={username}
          disabled={step === 'mfa' || step === 'new-password'}
          onChange={(event) => setUsername(event.target.value)}
          required
        />
        {step === 'credentials' || step === 'new-password' || step === 'confirm-forgot' ? (
          <>
            <label htmlFor="password">{step === 'credentials' ? '密码' : '新密码'}</label>
            <input
              id="password"
              type="password"
              autoComplete={step === 'credentials' ? 'current-password' : 'new-password'}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
            />
          </>
        ) : null}
        {step === 'mfa' || step === 'confirm-forgot' ? (
          <>
            <label htmlFor="confirmation-code">验证码</label>
            <input
              id="confirmation-code"
              inputMode="numeric"
              autoComplete="one-time-code"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              required
            />
          </>
        ) : null}
        {message !== null ? (
          <div className="login-message" role="alert">
            {message}
          </div>
        ) : null}
        <button className="primary-button" type="submit" disabled={busy}>
          {busy ? '处理中…' : step === 'credentials' ? '登录' : step === 'forgot' ? '发送验证码' : '提交'}
        </button>
        {step === 'credentials' ? (
          <button type="button" className="link-button" onClick={() => setStep('forgot')}>
            忘记密码
          </button>
        ) : (
          <button
            type="button"
            className="link-button"
            onClick={() => {
              setStep('credentials');
              setMessage(null);
            }}
          >
            返回登录
          </button>
        )}
      </form>
    </main>
  );
}
