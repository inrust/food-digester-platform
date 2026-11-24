import { useRef, useState } from 'react';
import { ErrorNotice } from '../../components/ErrorNotice.js';
import { Modal } from '../../components/Modal.js';
import { TimeText } from '../../components/TimeText.js';
import { Button, TextArea } from '../../components/ui.js';
import { translate } from '../../i18n/i18n.js';
import {
  RUNTIME_STATUS_LABELS,
  SETTING_KEY_LABELS,
  SETTING_READONLY_KEYS,
  validateSettingJson,
} from './settings-state.js';
import type { SettingKey, SettingView } from './types.js';

export interface BusinessSettingsPageProps {
  readonly writeSettings: boolean;
  readonly settings: {
    readonly rows: readonly SettingView[] | null;
    readonly error?: unknown;
  };
  readonly onUpdateSetting: (key: SettingKey, value: unknown, version: number) => Promise<SettingView>;
  readonly onRefresh: () => void | Promise<void>;
}

export function BusinessSettingsPage({
  writeSettings,
  settings,
  onUpdateSetting,
  onRefresh,
}: BusinessSettingsPageProps) {
  const [settingEdit, setSettingEdit] = useState<{ setting: SettingView; raw: string } | null>(null);
  const [actionError, setActionError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const jsonError = settingEdit ? validateSettingJson(settingEdit.setting.key, settingEdit.raw) : null;

  const submitSetting = async () => {
    if (
      !writeSettings ||
      !settingEdit ||
      jsonError !== null ||
      inFlight.current ||
      SETTING_READONLY_KEYS.includes(settingEdit.setting.key)
    )
      return;
    inFlight.current = true;
    setBusy(true);
    setActionError(null);
    setNotice(null);
    try {
      const { setting, raw } = settingEdit;
      const updated = await onUpdateSetting(setting.key, JSON.parse(raw), setting.version);
      setSettingEdit(null);
      setNotice(
        translate('page.7debf9cb0372') +
          ' ' +
          SETTING_KEY_LABELS[updated.key] +
          ' ' +
          translate('page.3395e930dfa7') +
          updated.version +
          ' · ' +
          RUNTIME_STATUS_LABELS[updated.runtimeStatus],
      );
      await onRefresh();
    } catch (error) {
      setActionError(error);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  return (
    <div className="settings-page" data-testid="business-settings-page">
      <header className="page-header">
        <h1>{translate('menu.business-settings')}</h1>
        <Button type="button" data-testid="business-settings-refresh" disabled={busy} onClick={() => void onRefresh()}>
          {translate('common.refresh')}
        </Button>
      </header>
      {notice !== null ? (
        <p className="action-notice" role="status" data-testid="action-notice">
          {notice}
        </p>
      ) : null}
      <section
        className="detail-stack"
        data-testid="business-settings-content"
        aria-label={translate('menu.business-settings')}
      >
        {settings.error !== undefined ? (
          <ErrorNotice error={settings.error} onRefresh={onRefresh} />
        ) : settings.rows === null ? (
          <div role="status" data-testid="settings-loading">
            {translate('page.300ee3dee4dc')}
          </div>
        ) : settings.rows.length === 0 ? (
          <p className="empty-state">{translate('common.empty')}</p>
        ) : (
          <div className="detail-grid">
            {settings.rows.map((setting) => {
              const readonly = SETTING_READONLY_KEYS.includes(setting.key);
              const consumer = setting.runtimeConsumer;
              const activeConsumer = setting.runtimeStatus === 'ACTIVE' ? consumer : null;
              const effect =
                setting.key === 'alarm.thresholds' && activeConsumer === 'FE-18'
                  ? translate('settings.effect.FE-18')
                  : setting.key === 'command.confirmation' && activeConsumer === 'BE-CMD-01'
                    ? translate('settings.effect.BE-CMD-01')
                    : setting.runtimeStatus === 'STORED_ONLY'
                      ? translate('settings.effect.stored')
                      : null;
              return (
                <article key={setting.key} className="detail-card" data-testid={`setting-${setting.key}`}>
                  <h4>{SETTING_KEY_LABELS[setting.key]}</h4>
                  <code>{setting.key}</code>
                  <p>{translate(`settings.purpose.${setting.key}`)}</p>
                  <dl>
                    <dt>{translate('settings.runtime')}</dt>
                    <dd data-testid={`setting-runtime-${setting.key}`}>
                      <span className="detail-status-badge" data-enabled={setting.runtimeStatus === 'ACTIVE'}>
                        {RUNTIME_STATUS_LABELS[setting.runtimeStatus]}
                      </span>
                    </dd>
                    <dt>{translate('settings.consumer')}</dt>
                    <dd data-testid={`setting-consumer-${setting.key}`}>
                      {consumer === 'FE-18' || consumer === 'BE-CMD-01'
                        ? translate(`settings.consumer.${consumer}`)
                        : (consumer ?? translate('settings.consumer.none'))}
                    </dd>
                    <dt>{translate('settings.editability')}</dt>
                    <dd data-testid={`setting-access-${setting.key}`}>
                      {readonly ? (
                        <span data-testid={`setting-readonly-${setting.key}`}>{translate('page.f2b79f39e053')}</span>
                      ) : (
                        translate(writeSettings ? 'settings.editable' : 'settings.readOnlyForRole')
                      )}
                    </dd>
                  </dl>
                  {effect !== null ? <p className="field-hint">{effect}</p> : null}
                  <p className="field-hint">
                    v{setting.version} · {setting.updatedBy ?? '—'} · <TimeText iso={setting.updatedAt} />
                  </p>
                  <pre
                    className="setting-value"
                    tabIndex={0}
                    role="region"
                    aria-label={setting.key}
                    data-testid={`setting-value-${setting.key}`}
                  >
                    {JSON.stringify(setting.value, null, 2)}
                  </pre>
                  {!readonly ? (
                    <Button
                      type="button"
                      data-testid={`setting-edit-${setting.key}`}
                      disabled={!writeSettings || busy}
                      onClick={() => {
                        setActionError(null);
                        setSettingEdit({ setting, raw: JSON.stringify(setting.value, null, 2) });
                      }}
                    >
                      {translate('page.a7f814c0a40d')}
                    </Button>
                  ) : null}
                </article>
              );
            })}
          </div>
        )}
      </section>
      <Modal
        open={settingEdit !== null}
        title={
          settingEdit !== null
            ? translate('page.9596698bebd1') + SETTING_KEY_LABELS[settingEdit.setting.key]
            : translate('page.5c87c6154ebd')
        }
        testid="setting-edit-form"
        onClose={() => setSettingEdit(null)}
      >
        {settingEdit !== null ? (
          <div>
            {actionError !== null ? (
              <ErrorNotice
                error={actionError}
                onRefresh={() => {
                  setSettingEdit(null);
                  setActionError(null);
                  void onRefresh();
                }}
              />
            ) : null}
            <p className="field-hint">
              {translate('page.0239b8ffa350')}
              {settingEdit.setting.version}
              {translate('page.77df378c18b2')}
              {RUNTIME_STATUS_LABELS[settingEdit.setting.runtimeStatus]}。
            </p>
            <div className="dialog-field">
              <label htmlFor="setting-value-input">{translate('page.9ac6be10cbd4')}</label>
              <TextArea
                id="setting-value-input"
                data-testid="setting-value-input"
                rows={10}
                value={settingEdit.raw}
                onChange={(event) => setSettingEdit({ ...settingEdit, raw: event.target.value })}
              />
            </div>
            {jsonError !== null ? (
              <p className="field-hint" data-testid="setting-value-error">
                {jsonError}
              </p>
            ) : null}
            <div className="dialog-actions">
              <Button type="button" onClick={() => setSettingEdit(null)}>
                {translate('common.cancel')}
              </Button>
              <Button
                type="button"
                className="primary-button"
                data-testid="setting-submit"
                disabled={busy || jsonError !== null}
                onClick={() => void submitSetting()}
              >
                {translate('page.bb79ec7c152f')}
              </Button>
            </div>
          </div>
        ) : null}
      </Modal>
    </div>
  );
}
