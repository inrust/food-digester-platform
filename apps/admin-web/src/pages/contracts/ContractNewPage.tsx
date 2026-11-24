import { Button, Input } from '../../components/ui.js';
import { translate } from '../../i18n/i18n.js';
/**
 * FE-17 新建合约页（/contracts/new）：结构化表单 + 两步设备关联。
 *
 * - 字段：合约编号（全局唯一，重复 → 409 呈现）、名称、Customer（客户目录结构化选择，
 *   不能自由文本制造新客户/地域）、有效期（上海业务日期）、联系方式（可选）；
 * - 创建为 DRAFT 且不自动激活 License（DEC-007）；
 * - 设备关联为第二步：创建成功后从 eligible 列表（listAvailableDevices：同 Customer、
 *   非 Retired、无 ACTIVE 关联）选择并批量关联（全成或全败；重叠租期 → 409）；
 *   eligible 之外的设备不可选（无自由文本入口）。
 */
import { useRef, useState } from 'react';
import { ApiClientError } from '../../api/errors.js';
import { customerNameKey, customerOptionLabels } from '../customers/customer-options.js';
import { ErrorNotice } from '../../components/ErrorNotice.js';
import { validateContractForm } from './contract-state.js';
import type { ContractFormDraft } from './contract-state.js';
import type { ContractCreateInput } from './contracts-api.js';
import type { AvailableDeviceView, ContractView } from './types.js';
import type { CustomerOption } from './ContractsPage.js';
export interface ContractNewPageProps {
  readonly customerOptions: readonly CustomerOption[];
  readonly customersLoading?: boolean;
  readonly customersError?: unknown;
  readonly canCreateCustomer: boolean;
  readonly onRefreshCustomers: () => Promise<void>;
  readonly onFindContract: (contractNumber: string) => Promise<ContractView | null>;
  readonly onOpenContract: (contractId: string) => void;
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
  startDate: '',
  endDate: '',
};
export function ContractNewPage({
  customerOptions,
  customersLoading = false,
  customersError,
  canCreateCustomer,
  onRefreshCustomers,
  onFindContract,
  onOpenContract,
  onCreate,
  onListAvailable,
  onBind,
  onCancel,
  onDone,
}: ContractNewPageProps) {
  const [draft, setDraft] = useState<ContractFormDraft>(EMPTY_DRAFT);
  const [customerMode, setCustomerMode] = useState<'existing' | 'new'>('existing');
  const [newCustomerName, setNewCustomerName] = useState('');
  const [allowDuplicateName, setAllowDuplicateName] = useState(false);
  const [foundContract, setFoundContract] = useState<ContractView | null>(null);
  const [lookupError, setLookupError] = useState<unknown>(null);
  const [lookupStatus, setLookupStatus] = useState<'idle' | 'loading' | 'missing'>('idle');
  const lookupGeneration = useRef(0);
  const [created, setCreated] = useState<ContractView | null>(null);
  const [available, setAvailable] = useState<
    | { kind: 'loading' }
    | { kind: 'ready'; devices: readonly AvailableDeviceView[] }
    | { kind: 'failed'; error: unknown }
  >({ kind: 'loading' });
  const [selected, setSelected] = useState<readonly string[]>([]);
  const [bindReason, setBindReason] = useState('');
  const [actionError, setActionError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const isNewCustomer = canCreateCustomer && customerMode === 'new';
  const fieldErrors = validateContractForm(draft, undefined, isNewCustomer ? newCustomerName : undefined);
  const customerLabels = customerOptionLabels(
    customerOptions,
    (option) => option.customerId,
    (option) => option.name,
  );
  const nameKey = customerNameKey(newCustomerName);
  const sameName =
    isNewCustomer && nameKey ? customerOptions.filter((option) => customerNameKey(option.name) === nameKey) : [];
  const missingExisting = !isNewCustomer && !customerOptions.some((item) => item.customerId === draft.customerId);
  const checkSavedContract = async (contractNumber: string) => {
    const generation = ++lookupGeneration.current;
    setLookupError(null);
    setLookupStatus('loading');
    try {
      const match = await onFindContract(contractNumber);
      if (generation !== lookupGeneration.current) return;
      setFoundContract(match);
      setLookupStatus(match ? 'idle' : 'missing');
    } catch (error) {
      if (generation !== lookupGeneration.current) return;
      setLookupError(error);
      setLookupStatus('idle');
    }
  };
  const loadAvailable = async (contractId: string) => {
    setAvailable({ kind: 'loading' });
    setSelected([]);
    try {
      setAvailable({ kind: 'ready', devices: await onListAvailable(contractId) });
    } catch (error) {
      setAvailable({ kind: 'failed', error });
    }
  };
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
      lookupGeneration.current += 1;
      setFoundContract(null);
      setLookupError(null);
      setLookupStatus('idle');
      const input: ContractCreateInput = {
        contractNumber: draft.contractNumber.trim(),
        name: draft.name.trim(),
        ...(isNewCustomer
          ? {
              newCustomer: {
                name: newCustomerName.trim(),
                ...(allowDuplicateName ? { allowDuplicateName: true } : {}),
              },
            }
          : { customerId: draft.customerId }),
        startDate: draft.startDate,
        endDate: draft.endDate,
        ...(draft.contact.trim() !== '' ? { contact: draft.contact.trim() } : {}),
      };
      let contract: ContractView;
      try {
        contract = await onCreate(input);
      } catch (error) {
        if (error instanceof ApiClientError && error.status === 409) {
          await Promise.all([checkSavedContract(input.contractNumber), onRefreshCustomers()]);
        }
        throw error;
      }
      setCreated(contract);
      void loadAvailable(contract.contractId);
      return translate('contract.draftSaved', { number: contract.contractNumber });
    });
  const submitBind = () =>
    runAction(async () => {
      if (created === null || selected.length === 0) return '';
      const bound = await onBind(created.contractId, selected, bindReason.trim());
      setBindReason('');
      void loadAvailable(created.contractId);
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
        {created === null ? (
          <Button type="button" data-testid="contract-create-cancel" onClick={onCancel}>
            {translate('page.11d024154013')}
          </Button>
        ) : null}
      </div>

      {notice !== null ? (
        <p className="action-notice" role="status" data-testid="action-notice">
          {notice}
        </p>
      ) : null}
      {actionError !== null ? <ErrorNotice error={actionError} /> : null}
      {lookupError !== null ? <ErrorNotice error={lookupError} /> : null}
      {created === null && lookupStatus === 'missing' ? (
        <p role="status">{translate('contract.noSavedContract')}</p>
      ) : null}
      {created === null && foundContract !== null ? (
        <div className="action-row" data-testid="contract-number-conflict">
          <p>{translate('contract.numberConflict', { number: foundContract.contractNumber })}</p>
          <Button
            type="button"
            data-testid="contract-open-existing"
            onClick={() => onOpenContract(foundContract.contractId)}
          >
            {translate('contract.openExisting')}
          </Button>
        </div>
      ) : null}
      {created === null && actionError !== null && foundContract === null && draft.contractNumber.trim() !== '' ? (
        <Button
          type="button"
          data-testid="contract-check-saved"
          disabled={busy || lookupStatus === 'loading'}
          onClick={() => void checkSavedContract(draft.contractNumber.trim())}
        >
          {translate('contract.checkSaved')}
        </Button>
      ) : null}

      <section data-testid="contract-form" aria-label={translate('page.82fe9340d299')}>
        <div className="dialog-field">
          <label htmlFor="contract-number-input">{translate('page.e732638998ba')}</label>
          <Input
            id="contract-number-input"
            data-testid="contract-number-input"
            maxLength={100}
            disabled={created !== null || busy}
            value={draft.contractNumber}
            onChange={(event) => {
              lookupGeneration.current += 1;
              setFoundContract(null);
              setLookupError(null);
              setLookupStatus('idle');
              setDraft({ ...draft, contractNumber: event.target.value });
            }}
          />
          {fieldError('contractNumber')}
        </div>
        <div className="dialog-field">
          <label htmlFor="contract-name-input">{translate('page.eec5002799b1')}</label>
          <Input
            id="contract-name-input"
            data-testid="contract-name-input"
            maxLength={200}
            disabled={created !== null || busy}
            value={draft.name}
            onChange={(event) => setDraft({ ...draft, name: event.target.value })}
          />
          {fieldError('name')}
        </div>
        {canCreateCustomer ? (
          <div className="dialog-field">
            <label htmlFor="contract-customer-mode">{translate('contract.customerMode')}</label>
            <select
              id="contract-customer-mode"
              data-testid="contract-customer-mode"
              value={customerMode}
              disabled={created !== null || busy}
              onChange={(event) => {
                setCustomerMode(event.target.value === 'new' ? 'new' : 'existing');
                setAllowDuplicateName(false);
              }}
            >
              <option value="existing">{translate('contract.chooseExistingCustomer')}</option>
              <option value="new">{translate('contract.createNewCustomer')}</option>
            </select>
          </div>
        ) : null}
        {customersError !== undefined && created === null ? (
          <div>
            <ErrorNotice error={customersError} />
            <Button
              type="button"
              data-testid="contract-customers-retry"
              disabled={customersLoading}
              onClick={() => void onRefreshCustomers()}
            >
              {translate('detail.retry')}
            </Button>
          </div>
        ) : null}
        {customersLoading ? <p role="status">{translate('page.300ee3dee4dc')}</p> : null}
        {isNewCustomer ? (
          <div className="dialog-field">
            <label htmlFor="contract-new-customer-name">{translate('contract.newCustomerName')}</label>
            <Input
              id="contract-new-customer-name"
              data-testid="contract-new-customer-name"
              maxLength={200}
              value={newCustomerName}
              disabled={created !== null || busy}
              onChange={(event) => {
                setNewCustomerName(event.target.value);
                setAllowDuplicateName(false);
              }}
            />
            {fieldError('newCustomer')}
            {created === null && sameName.length > 0 ? (
              <div data-testid="contract-same-name-customers">
                <p>{translate('contract.sameNameCustomers')}</p>
                {sameName.map((customer) => (
                  <Button
                    type="button"
                    key={customer.customerId}
                    data-testid={`contract-use-customer-${customer.customerId}`}
                    disabled={busy}
                    onClick={() => {
                      setDraft({ ...draft, customerId: customer.customerId });
                      setCustomerMode('existing');
                      setAllowDuplicateName(false);
                    }}
                  >
                    {translate('contract.useCustomer', { name: customer.name, id: customer.customerId })}
                  </Button>
                ))}
                <label>
                  <Input
                    type="checkbox"
                    data-testid="contract-confirm-duplicate-customer"
                    checked={allowDuplicateName}
                    disabled={busy}
                    onChange={(event) => setAllowDuplicateName(event.target.checked)}
                  />
                  {translate('contract.confirmDuplicateCustomer')}
                </label>
              </div>
            ) : null}
          </div>
        ) : (
          <div className="dialog-field">
            <label htmlFor="contract-customer-select">{translate('page.ccaf386a064a')}</label>
            <select
              id="contract-customer-select"
              data-testid="contract-customer-select"
              disabled={created !== null || busy || customersLoading}
              value={draft.customerId}
              onChange={(event) => setDraft({ ...draft, customerId: event.target.value })}
            >
              <option value="">{translate('page.382f4b5559b3')}</option>
              {customerOptions.map((customer) => (
                <option key={customer.customerId} value={customer.customerId}>
                  {customerLabels.get(customer.customerId)}
                </option>
              ))}
            </select>
            {fieldError('customerId')}
          </div>
        )}
        <div className="dialog-field">
          <label htmlFor="contract-start-input">{translate('page.0ed8daddc54b')}</label>
          <Input
            id="contract-start-input"
            type="date"
            data-testid="contract-start-input"
            disabled={created !== null || busy}
            value={draft.startDate}
            onChange={(event) => setDraft({ ...draft, startDate: event.target.value })}
          />
          <label htmlFor="contract-end-input">{translate('page.a1bf0b770919')}</label>
          <Input
            id="contract-end-input"
            type="date"
            data-testid="contract-end-input"
            disabled={created !== null || busy}
            value={draft.endDate}
            onChange={(event) => setDraft({ ...draft, endDate: event.target.value })}
          />
          <p className="field-hint">{translate('contract.dateBasis')}</p>
          {fieldError('period')}
        </div>
        <div className="dialog-field">
          <label htmlFor="contract-contact-input">{translate('page.85e5fa1b0c95')}</label>
          <Input
            id="contract-contact-input"
            data-testid="contract-contact-input"
            maxLength={200}
            disabled={created !== null || busy}
            value={draft.contact}
            onChange={(event) => setDraft({ ...draft, contact: event.target.value })}
          />
          {fieldError('contact')}
        </div>
        {created === null ? (
          <div className="dialog-actions">
            <Button
              type="button"
              className="primary-button"
              data-testid="contract-create-submit"
              disabled={
                busy ||
                fieldErrors !== null ||
                (!isNewCustomer && (customersLoading || missingExisting)) ||
                (isNewCustomer && sameName.length > 0 && !allowDuplicateName)
              }
              onClick={() => void submitCreate()}
            >
              {translate('page.68b24eeb6f4e')}
            </Button>
          </div>
        ) : null}
      </section>

      {created !== null ? (
        <section data-testid="contract-new-devices" aria-label={translate('page.a638180058f8')}>
          <h4>{translate('page.e70a3aa701a1')}</h4>
          {available.kind === 'loading' ? (
            <div role="status">{translate('page.d360706fdd30')}</div>
          ) : available.kind === 'failed' ? (
            <div>
              <ErrorNotice error={available.error} />
              <Button
                type="button"
                data-testid="contract-new-devices-retry"
                onClick={() => void loadAvailable(created.contractId)}
              >
                {translate('detail.retry')}
              </Button>
            </div>
          ) : available.devices.length === 0 ? (
            <p className="empty-state" data-testid="contract-new-devices-empty">
              {translate('page.941fc73da805')}
            </p>
          ) : (
            <div role="group" aria-label={translate('page.16c798774b40')} data-testid="contract-new-device-list">
              {available.devices.map((device) => (
                <label key={device.deviceId}>
                  <Input
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
            <Input
              id="contract-bind-reason"
              data-testid="contract-bind-reason"
              required
              maxLength={500}
              value={bindReason}
              onChange={(event) => setBindReason(event.target.value)}
            />
          </div>
          <div className="dialog-actions">
            <Button
              type="button"
              className="primary-button"
              data-testid="contract-bind-submit"
              disabled={busy || selected.length === 0 || bindReason.trim() === ''}
              onClick={() => void submitBind()}
            >
              {translate('page.381ba5101f1c')}
            </Button>
            <Button type="button" data-testid="contract-new-done" onClick={onDone}>
              {translate('page.11d024154013')}
            </Button>
          </div>
        </section>
      ) : null}
    </div>
  );
}
