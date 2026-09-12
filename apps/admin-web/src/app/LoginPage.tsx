import { translate } from '../i18n/i18n.js';
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
    else setMessage(translate('ui.d29606ff7a62'));
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
        setMessage(translate('ui.6aba39d50872'));
      } else {
        await auth.confirmForgotPassword(username.trim(), code.trim(), password);
        setPassword('');
        setCode('');
        setStep('credentials');
        setMessage(translate('ui.88029caf2e3c'));
      }
    } catch (error) {
      setPassword('');
      setMessage(error instanceof Error ? error.message : translate('ui.539830fdf386'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="login-page">
      <form className="login-card" onSubmit={(event) => void submit(event)}>
        <h1>{translate('ui.702005aecd7f')}</h1>
        <p>{translate('ui.3504cf6398a8')}</p>
        <label htmlFor="username">{translate('page.a1aaf352cb07')}</label>
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
            <label htmlFor="password">
              {step === 'credentials' ? translate('ui.c839a8ff1788') : translate('page.d22c9c008539')}
            </label>
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
            <label htmlFor="confirmation-code">{translate('ui.3e3d59a25863')}</label>
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
          {busy
            ? translate('ui.1cac8ac7f58f')
            : step === 'credentials'
              ? translate('ui.21f1e88275aa')
              : step === 'forgot'
                ? translate('ui.42e8edb226ec')
                : translate('ui.09cbc97ae2ac')}
        </button>
        {step === 'credentials' ? (
          <button type="button" className="link-button" onClick={() => setStep('forgot')}>
            {translate('ui.2e90a4906264')}
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
            {translate('ui.f2fe4ecc0f4b')}
          </button>
        )}
      </form>
    </main>
  );
}
