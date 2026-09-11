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
      if (fieldErrors !== null) throw new Error(Object.values(fieldErrors)[0] ?? '表单校验失败');
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
      return `合约 ${contract.contractNumber} 已创建（草稿；不自动激活 License）。可从 eligible 列表关联设备`;
    });

  const submitBind = () =>
    runAction(async () => {
      if (created === null || selected.length === 0) return '';
      const bound = await onBind(created.contractId, selected, bindReason.trim());
      setSelected([]);
      setAvailable(await onListAvailable(created.contractId));
      return `已关联 ${bound.length} 台设备（全成或全败）`;
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
        <h3>新建合约</h3>
        <button type="button" data-testid="contract-create-cancel" onClick={onCancel}>
          返回
        </button>
      </div>

      {notice !== null ? (
        <p className="action-notice" role="status" data-testid="action-notice">
          {notice}
        </p>
      ) : null}
      {actionError !== null ? <ErrorNotice error={actionError} /> : null}

      <section data-testid="contract-form" aria-label="合约信息">
        <div className="dialog-field">
          <label htmlFor="contract-number-input">合约编号</label>
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
          <label htmlFor="contract-name-input">合约名称</label>
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
          <label htmlFor="contract-customer-select">客户（客户目录选择）</label>
          <select
            id="contract-customer-select"
            data-testid="contract-customer-select"
            disabled={created !== null}
            value={draft.customerId}
            onChange={(event) => setDraft({ ...draft, customerId: event.target.value })}
          >
            <option value="">请选择</option>
            {customerOptions.map((customer) => (
              <option key={customer.customerId} value={customer.customerId}>
                {customer.name}
              </option>
            ))}
          </select>
          {fieldError('customerId')}
        </div>
        <div className="dialog-field">
          <label htmlFor="contract-start-input">有效期起（UTC）</label>
          <input
            id="contract-start-input"
            type="datetime-local"
            data-testid="contract-start-input"
            disabled={created !== null}
            value={draft.startAt}
            onChange={(event) => setDraft({ ...draft, startAt: event.target.value })}
          />
          <label htmlFor="contract-end-input">有效期止（UTC）</label>
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
          <label htmlFor="contract-contact-input">联系方式（可选）</label>
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
              确定（创建草稿，不自动激活 License）
            </button>
          </div>
        ) : null}
      </section>

      {created !== null ? (
        <section data-testid="contract-new-devices" aria-label="关联设备选择">
          <h4>关联设备（eligible：同 Customer、非 Retired、无有效关联）</h4>
          {available === null ? (
            <div role="status">加载 eligible 设备中…</div>
          ) : available.length === 0 ? (
            <p className="empty-state" data-testid="contract-new-devices-empty">
              当前无可关联设备
            </p>
          ) : (
            <div role="group" aria-label="可关联设备" data-testid="contract-new-device-list">
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
                  {device.site !== null ? `，${device.site.region ?? '—'}/${device.site.subregion ?? '—'}/${device.site.name}` : ''}）
                </label>
              ))}
            </div>
          )}
          <div className="dialog-field">
            <label htmlFor="contract-bind-reason">关联原因（强制）</label>
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
              关联所选设备
            </button>
            <button type="button" data-testid="contract-new-done" onClick={onDone}>
              完成
            </button>
          </div>
        </section>
      ) : null}
    </div>
  );
}
