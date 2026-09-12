import { translate } from '../../i18n/i18n.js';
/**
 * FE-17 新建合约页（/contracts/new）：结构化表单 + 两步设备关联。
 *
 * - 字段：合约编号（全局唯一，重复 → 409 呈现）、名称、Customer（客户目录结构化选择，
 *   不能自由文本制造新客户/地域）、有效期（UTC，startAt<endAt）、联系方式（可选）；
 * - 创建为 DRAFT 且不自动激活 License（DEC-007）；
 * - 设备关联为第二步：创建成功后从 eligible 列表（listAvailableDevices：同 Customer、
 *   非 Retired、无 ACTIVE 关联）选择并批量关联（全成或全败；重叠租期 → 409）；
 *   eligible 之外的设备不可选（无自由文本入口）。
 */
import { useRef, useState } from 'react';
import { ErrorNotice } from '../../components/ErrorNotice.js';
import { validateContractForm } from './contract-state.js';
import type { ContractFormDraft } from './contract-state.js';
import type { ContractCreateInput } from './contracts-api.js';
import type { AvailableDeviceView, ContractView } from './types.js';
import type { CustomerOption } from './ContractsPage.js';
export interface ContractNewPageProps {
  readonly customerOptions: readonly CustomerOption[];
  readonly onCreate: (input: ContractCreateInput) => Promise<ContractView>;
  /** 创建后加载 eligible 设备列表。 */
  readonly onListAvailable: (contractId: string) => Promise<readonly AvailableDeviceView[]>;
  /** 批量关联（deviceIds ≥1 + 强制原因；窗口缺省为合同窗口）。 */
  readonly onBind: (contractId: string, deviceIds: readonly string[], reason: string) => Promise<readonly string[]>;
  readonly onCancel: () => void;
  /** 完成（创建并可选关联后）返回列表。 */
  readonly onDone: () => void;
}
const EMPTY_DRAFT: ContractFormDraft = {
  contractNumber: '',
  name: '',
  customerId: '',
  contact: '',
  startAt: '',
  endAt: '',
};
export function ContractNewPage({
  customerOptions,
  onCreate,
  onListAvailable,
  onBind,
  onCancel,
  onDone,
}: ContractNewPageProps) {
  const [draft, setDraft] = useState<ContractFormDraft>(EMPTY_DRAFT);
  const [created, setCreated] = useState<ContractView | null>(null);
  const [available, setAvailable] = useState<readonly AvailableDeviceView[] | null>(null);
  const [selected, setSelected] = useState<readonly string[]>([]);
  const [bindReason, setBindReason] = useState('');
  const [actionError, setActionError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const fieldErrors = validateContractForm(draft);
  const runAction = async (execute: () => Promise<string>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setActionError(null);
    try {
      setNotice(await execute());
    } catch (err) {
      setActionError(err);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  const submitCreate = () =>
    runAction(async () => {
      if (fieldErrors !== null) throw new Error(Object.values(fieldErrors)[0] ?? translate('page.0b8b9963d904'));
      const input: ContractCreateInput = {
        contractNumber: draft.contractNumber.trim(),
        name: draft.name.trim(),
        customerId: draft.customerId,
        startAt: draft.startAt,
        endAt: draft.endAt,
        ...(draft.contact.trim() !== '' ? { contact: draft.contact.trim() } : {}),
      };
      const contract = await onCreate(input);
      setCreated(contract);
      setAvailable(await onListAvailable(contract.contractId));
      return translate('page.72045015ab9e') + ' ' + contract.contractNumber + (' ' + translate('page.3eb57b0d80cc'));
    });
  const submitBind = () =>
    runAction(async () => {
      if (created === null || selected.length === 0) return '';
      const bound = await onBind(created.contractId, selected, bindReason.trim());
      setSelected([]);
      setAvailable(await onListAvailable(created.contractId));
      return translate('page.1efeec44018f') + ' ' + bound.length + (' ' + translate('page.c109982ccfd5'));
    });
  const fieldError = (key: string) =>
    fieldErrors !== null && fieldErrors[key] !== undefined ? (
      <span className="field-hint" data-testid={`contract-error-${key}`}>
        {fieldErrors[key]}
      </span>
    ) : null;
  return (
    <div className="contract-new-page" data-testid="contract-new-page">
      <div className="page-header">
        <h3>{translate('page.44c75e312909')}</h3>
        <button type="button" data-testid="contract-create-cancel" onClick={onCancel}>
          {translate('page.11d024154013')}
        </button>
      </div>

      {notice !== null ? (
        <p className="action-notice" role="status" data-testid="action-notice">
          {notice}
        </p>
      ) : null}
      {actionError !== null ? <ErrorNotice error={actionError} /> : null}

      <section data-testid="contract-form" aria-label={translate('page.82fe9340d299')}>
        <div className="dialog-field">
          <label htmlFor="contract-number-input">{translate('page.e732638998ba')}</label>
          <input
            id="contract-number-input"
            data-testid="contract-number-input"
            maxLength={100}
            disabled={created !== null}
            value={draft.contractNumber}
            onChange={(event) => setDraft({ ...draft, contractNumber: event.target.value })}
          />
          {fieldError('contractNumber')}
        </div>
        <div className="dialog-field">
          <label htmlFor="contract-name-input">{translate('page.eec5002799b1')}</label>
          <input
            id="contract-name-input"
            data-testid="contract-name-input"
            maxLength={200}
            disabled={created !== null}
            value={draft.name}
            onChange={(event) => setDraft({ ...draft, name: event.target.value })}
          />
          {fieldError('name')}
        </div>
        <div className="dialog-field">
          <label htmlFor="contract-customer-select">{translate('page.ccaf386a064a')}</label>
          <select
            id="contract-customer-select"
            data-testid="contract-customer-select"
            disabled={created !== null}
            value={draft.customerId}
            onChange={(event) => setDraft({ ...draft, customerId: event.target.value })}
          >
            <option value="">{translate('page.382f4b5559b3')}</option>
            {customerOptions.map((customer) => (
              <option key={customer.customerId} value={customer.customerId}>
                {customer.name}
              </option>
            ))}
          </select>
          {fieldError('customerId')}
        </div>
        <div className="dialog-field">
          <label htmlFor="contract-start-input">{translate('page.0ed8daddc54b')}</label>
          <input
            id="contract-start-input"
            type="datetime-local"
            data-testid="contract-start-input"
            disabled={created !== null}
            value={draft.startAt}
            onChange={(event) => setDraft({ ...draft, startAt: event.target.value })}
          />
          <label htmlFor="contract-end-input">{translate('page.a1bf0b770919')}</label>
          <input
            id="contract-end-input"
            type="datetime-local"
            data-testid="contract-end-input"
            disabled={created !== null}
            value={draft.endAt}
            onChange={(event) => setDraft({ ...draft, endAt: event.target.value })}
          />
          {fieldError('period')}
        </div>
        <div className="dialog-field">
          <label htmlFor="contract-contact-input">{translate('page.85e5fa1b0c95')}</label>
          <input
            id="contract-contact-input"
            data-testid="contract-contact-input"
            maxLength={200}
            disabled={created !== null}
            value={draft.contact}
            onChange={(event) => setDraft({ ...draft, contact: event.target.value })}
          />
          {fieldError('contact')}
        </div>
        {created === null ? (
          <div className="dialog-actions">
            <button
              type="button"
              className="primary-button"
              data-testid="contract-create-submit"
              disabled={busy || fieldErrors !== null}
              onClick={() => void submitCreate()}
            >
              {translate('page.68b24eeb6f4e')}
            </button>
          </div>
        ) : null}
      </section>

      {created !== null ? (
        <section data-testid="contract-new-devices" aria-label={translate('page.a638180058f8')}>
          <h4>{translate('page.e70a3aa701a1')}</h4>
          {available === null ? (
            <div role="status">{translate('page.d360706fdd30')}</div>
          ) : available.length === 0 ? (
            <p className="empty-state" data-testid="contract-new-devices-empty">
              {translate('page.941fc73da805')}
            </p>
          ) : (
            <div role="group" aria-label={translate('page.16c798774b40')} data-testid="contract-new-device-list">
              {available.map((device) => (
                <label key={device.deviceId}>
                  <input
                    type="checkbox"
                    data-testid={`contract-new-device-${device.deviceId}`}
                    checked={selected.includes(device.deviceId)}
                    onChange={(event) =>
                      setSelected(
                        event.target.checked
                          ? [...selected, device.deviceId]
                          : selected.filter((id) => id !== device.deviceId),
                      )
                    }
                  />
                  {device.alias ?? device.serialNumber}（{device.model}
                  {device.site !== null
                    ? `，${device.site.region ?? '—'}/${device.site.subregion ?? '—'}/${device.site.name}`
                    : ''}
                  ）
                </label>
              ))}
            </div>
          )}
          <div className="dialog-field">
            <label htmlFor="contract-bind-reason">{translate('page.45ec50c74ef1')}</label>
            <input
              id="contract-bind-reason"
              data-testid="contract-bind-reason"
              maxLength={500}
              value={bindReason}
              onChange={(event) => setBindReason(event.target.value)}
            />
          </div>
          <div className="dialog-actions">
            <button
              type="button"
              className="primary-button"
              data-testid="contract-bind-submit"
              disabled={busy || selected.length === 0 || bindReason.trim() === ''}
              onClick={() => void submitBind()}
            >
              {translate('page.381ba5101f1c')}
            </button>
            <button type="button" data-testid="contract-new-done" onClick={onDone}>
              {translate('page.33246f6a5e5b')}
            </button>
          </div>
        </section>
      ) : null}
    </div>
  );
}
