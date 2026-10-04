import { Icon } from '../components/Icon.js';
import { Button, Input } from '../components/ui.js';
import { translate } from '../i18n/i18n.js';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { AuthFlowError } from '../auth/auth-flow.js';
import type { AuthFlow, LoginOutcome } from '../auth/auth-flow.js';
import { CognitoIdpError } from '../auth/cognito-idp.js';
import type { CognitoErrorCode } from '../auth/cognito-idp.js';
import { SessionEstablishError } from '../session/session-manager.js';
export interface LoginPageProps {
  readonly auth: AuthFlow;
  readonly onAuthenticated: () => void;
}
type LoginStep = 'credentials' | 'mfa' | 'new-password' | 'forgot' | 'confirm-forgot';

const COGNITO_ERROR_MESSAGE_KEYS: Readonly<Partial<Record<CognitoErrorCode, string>>> = {
  INVALID_CREDENTIALS: 'auth.error.invalidCredentials',
  PASSWORD_RESET_REQUIRED: 'auth.error.passwordResetRequired',
  USER_NOT_CONFIRMED: 'auth.error.userNotConfirmed',
  CODE_MISMATCH: 'auth.error.codeMismatch',
  CODE_EXPIRED: 'auth.error.codeExpired',
  PASSWORD_TOO_SHORT: 'auth.error.passwordTooShort',
  PASSWORD_REQUIRES_UPPERCASE: 'auth.error.passwordRequiresUppercase',
  PASSWORD_REQUIRES_LOWERCASE: 'auth.error.passwordRequiresLowercase',
  PASSWORD_REQUIRES_NUMBER: 'auth.error.passwordRequiresNumber',
  PASSWORD_REQUIRES_SYMBOL: 'auth.error.passwordRequiresSymbol',
  PASSWORD_POLICY_VIOLATION: 'auth.error.passwordPolicyViolation',
  PASSWORD_REUSE_NOT_ALLOWED: 'auth.error.passwordReuseNotAllowed',
  RATE_LIMITED: 'auth.error.rateLimited',
  NETWORK: 'auth.error.network',
};

export function loginErrorMessage(error: unknown, step: LoginStep): string {
  if (error instanceof CognitoIdpError) {
    const key = COGNITO_ERROR_MESSAGE_KEYS[error.code];
    if (key !== undefined) return translate(key);
    return translate(step === 'new-password' ? 'auth.error.newPasswordUnknown' : 'auth.error.unknown');
  }
  if (error instanceof AuthFlowError) return translate('auth.error.flowExpired');
  if (error instanceof SessionEstablishError) return translate('auth.error.accountConfiguration');
  return translate('auth.error.unknown');
}

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
      setMessage(loginErrorMessage(error, step));
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="login-page">
      <section className="login-intro">
        <span className="login-eyebrow">
          <Icon name="leaf" />
          {translate('design.console')}
        </span>
        <h2>{translate('design.loginTitle')}</h2>
        <p>{translate('design.loginDescription')}</p>
        <div className="login-capabilities">
          {['device', 'leaf', 'shield'].map((name, index) => (
            <div key={name}>
              <Icon name={name} />
              <span>{translate(`design.capability${index}`)}</span>
            </div>
          ))}
        </div>
        <div className="login-art" aria-hidden="true">
          <Icon name="leaf" />
          <span />
          <span />
        </div>
      </section>
      <form className="login-card" onSubmit={(event) => void submit(event)}>
        <h1>{translate('ui.702005aecd7f')}</h1>
        <p>{translate('ui.3504cf6398a8')}</p>
        {step === 'new-password' ? (
          <section
            className="login-challenge-notice"
            role="status"
            aria-labelledby="new-password-title"
            data-testid="new-password-notice"
          >
            <span className="login-step-badge">{translate('auth.newPassword.badge')}</span>
            <h2 id="new-password-title">{translate('auth.newPassword.title')}</h2>
            <p>{translate('auth.newPassword.description')}</p>
          </section>
        ) : null}
        <label htmlFor="username">{translate('page.a1aaf352cb07')}</label>
        <Input
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
              {step === 'credentials'
                ? translate('ui.c839a8ff1788')
                : step === 'new-password'
                  ? translate('auth.newPassword.label')
                  : translate('page.d22c9c008539')}
            </label>
            <Input
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
            <Input
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
        <Button className="primary-button" type="submit" disabled={busy}>
          {busy
            ? translate('ui.1cac8ac7f58f')
            : step === 'credentials'
              ? translate('ui.21f1e88275aa')
              : step === 'forgot'
                ? translate('ui.42e8edb226ec')
                : step === 'new-password'
                  ? translate('auth.newPassword.submit')
                  : translate('ui.09cbc97ae2ac')}
        </Button>
        {step === 'credentials' ? (
          <Button type="button" className="link-button" onClick={() => setStep('forgot')}>
            {translate('ui.2e90a4906264')}
          </Button>
        ) : (
          <Button
            type="button"
            className="link-button"
            onClick={() => {
              setStep('credentials');
              setMessage(null);
            }}
          >
            {translate('ui.f2fe4ecc0f4b')}
          </Button>
        )}
      </form>
    </main>
  );
}
