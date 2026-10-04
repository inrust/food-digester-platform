import { Button, Input } from '../../components/ui.js';
import { translate } from '../../i18n/i18n.js';
/**
 * FE-17 合约详情页（/contracts/detail）：合约信息、动作矩阵（编辑/激活/续约/终止）、
 * 关联设备表（Region/Subregion/Site/ID/别名/四轴状态/固件 + 租期展示值）、绑定/解绑与关联历史。
 *
 * - 所有写操作携带 version（If-Match 乐观锁）+ 强制原因；contract:write 仅 PlatformSuperAdmin；
 * - DEC-007：合约状态与 License 授权状态并列展示且标签不同（“合约状态” vs “授权状态”）；
 *   解绑不撤销 License——前端不得擅自变更 License 展示，仅提示服务端权威；
 * - 设备仅从 eligible 列表选择（绑定 Modal 实时加载）；重叠租期/跨 Customer/重复关联 → 409 呈现；
 * - contact 最小权限：Auditor 视图为 null（显示“最小权限不可见”），不伪造。
 */
import { useRef, useState } from 'react';
import type { Role } from '@fdp/auth/browser';
import { ConfirmDialog } from '../../components/ConfirmDialog.js';
import { ErrorNotice } from '../../components/ErrorNotice.js';
import { FourAxisBadges } from '../../components/FourAxisBadge.js';
import { Modal } from '../../components/Modal.js';
import { TimeText } from '../../components/TimeText.js';
import { LicenseSummary } from '../licenses/LicenseSummary.js';
import type { DeviceLicenseSummaryView } from '../devices/types.js';
import {
  ASSOCIATION_STATUS_LABELS,
  CONTRACT_STATUS_LABELS,
  formatServicePeriod,
  gateContractAction,
  validateContractForm,
  validateRenew,
} from './contract-state.js';
import type { ContractFormDraft } from './contract-state.js';
import type { ContractUpdateInput } from './contracts-api.js';
import type {
  AvailableDeviceView,
  ContractDeviceAssociationView,
  ContractDeviceDetailView,
  ContractView,
} from './types.js';
export interface ContractDetailPageProps {
  readonly role: Role;
  readonly contract: ContractView | null;
  readonly contractError?: unknown;
  /** 客户目录解析名（缺省显示 customerId）。 */
  readonly customerName?: string | null;
  readonly devices: {
    readonly rows: readonly ContractDeviceDetailView[] | null;
    readonly error?: unknown;
  };
  readonly associations: readonly ContractDeviceAssociationView[] | null;
  /** 每设备 License 摘要（独立授权轴；DEC-007 并列展示，不联动修改）。 */
  readonly licenses?: Readonly<Record<string, DeviceLicenseSummaryView | null>>;
  readonly licenseError?: unknown;
  readonly onOpenLicense: (licenseId: string) => void;
  readonly onListAvailable: () => Promise<readonly AvailableDeviceView[]>;
  readonly onEdit: (input: ContractUpdateInput, version: number) => Promise<ContractView>;
  readonly onActivate: (reason: string, version: number) => Promise<ContractView>;
  readonly onRenew: (newEndAt: string, reason: string, version: number) => Promise<ContractView>;
  readonly onTerminate: (reason: string, version: number) => Promise<ContractView>;
  readonly onBind: (deviceIds: readonly string[], reason: string) => Promise<readonly string[]>;
  readonly onUnbind: (deviceIds: readonly string[], reason: string) => Promise<readonly string[]>;
  readonly onBack: () => void;
  readonly onRefresh: () => void;
}
type ConfirmTarget =
  | {
      readonly kind: 'activate';
    }
  | {
      readonly kind: 'terminate';
    }
  | {
      readonly kind: 'unbind';
      readonly deviceIds: readonly string[];
    };
export function ContractDetailPage({
  role,
  contract,
  contractError,
  customerName,
  devices,
  associations,
  licenses,
  licenseError,
  onOpenLicense,
  onListAvailable,
  onEdit,
  onActivate,
  onRenew,
  onTerminate,
  onBind,
  onUnbind,
  onBack,
  onRefresh,
}: ContractDetailPageProps) {
  const [editDraft, setEditDraft] = useState<ContractFormDraft | null>(null);
  const [editReason, setEditReason] = useState('');
  const [renewEndAt, setRenewEndAt] = useState<string | null>(null);
  const [renewReason, setRenewReason] = useState('');
  const [confirm, setConfirm] = useState<ConfirmTarget | null>(null);
  const [bindOpen, setBindOpen] = useState(false);
  const [available, setAvailable] = useState<readonly AvailableDeviceView[] | null>(null);
  const [bindSelected, setBindSelected] = useState<readonly string[]>([]);
  const [bindReason, setBindReason] = useState('');
  const [unbindSelected, setUnbindSelected] = useState<readonly string[]>([]);
  const [actionError, setActionError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const runAction = async (execute: () => Promise<string>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setActionError(null);
    try {
      setNotice(await execute());
      setConfirm(null);
      onRefresh();
    } catch (err) {
      setActionError(err);
      setConfirm(null);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  if (contractError !== undefined) {
    return (
      <div className="contract-detail-page" data-testid="contract-detail-page">
        <Button type="button" data-testid="contract-detail-back" onClick={onBack}>
          {translate('page.11d024154013')}
        </Button>
        <ErrorNotice error={contractError} onRefresh={onRefresh} />
      </div>
    );
  }
  if (contract === null) {
    return (
      <div className="contract-detail-page" data-testid="contract-detail-page" role="status">
        {translate('page.300ee3dee4dc')}
      </div>
    );
  }
  const status = contract.derivedStatus;
  const gate = (action: Parameters<typeof gateContractAction>[0]) => gateContractAction(action, status, role);
  const editFieldErrors =
    editDraft !== null ? validateContractForm({ ...editDraft, customerId: contract.customerId }) : null;
  const renewError = renewEndAt !== null ? validateRenew(renewEndAt, contract.endAt) : null;
  const openBind = () => {
    setBindOpen(true);
    setAvailable(null);
    setBindSelected([]);
    setBindReason('');
    void onListAvailable()
      .then(setAvailable)
      .catch((err: unknown) => setActionError(err));
  };
  const submitEdit = () =>
    runAction(async () => {
      if (editDraft === null || editFieldErrors !== null) return '';
      const input: ContractUpdateInput = {
        name: editDraft.name.trim(),
        contact: editDraft.contact.trim() === '' ? null : editDraft.contact.trim(),
        reason: editReason.trim(),
        ...(status === 'DRAFT' ? { startAt: editDraft.startAt, endAt: editDraft.endAt } : {}),
      };
      await onEdit(input, contract.version);
      setEditDraft(null);
      setEditReason('');
      return translate('page.d23dcff81ad3');
    });
  const submitRenew = () =>
    runAction(async () => {
      if (renewEndAt === null || renewError !== null) return '';
      await onRenew(renewEndAt, renewReason.trim(), contract.version);
      setRenewEndAt(null);
      setRenewReason('');
      return translate('page.58d9c1174d71');
    });
  const submitConfirm = (reason: string) =>
    runAction(async () => {
      if (confirm === null) return '';
      if (confirm.kind === 'activate') {
        await onActivate(reason, contract.version);
        return translate('page.fb102df42b45');
      }
      if (confirm.kind === 'terminate') {
        await onTerminate(reason, contract.version);
        return translate('page.4756cd8c8d38');
      }
      const unbound = await onUnbind(confirm.deviceIds, reason);
      setUnbindSelected([]);
      return translate('page.5a10408b3625') + ' ' + unbound.length + (' ' + translate('page.c03d33d5de04'));
    });
  const submitBind = () =>
    runAction(async () => {
      if (bindSelected.length === 0) return '';
      const bound = await onBind(bindSelected, bindReason.trim());
      setBindOpen(false);
      return translate('page.1efeec44018f') + ' ' + bound.length + (' ' + translate('page.ff58c8e551d7'));
    });
  return (
    <div className="contract-detail-page" data-testid="contract-detail-page">
      <div className="page-header">
        <Button type="button" data-testid="contract-detail-back" onClick={onBack}>
          {translate('page.11d024154013')}
        </Button>
        <h3>
          {translate('page.d21ae30b3f47')}
          {contract.contractNumber}
        </h3>
      </div>

      {notice !== null ? (
        <p className="action-notice" role="status" data-testid="action-notice">
          {notice}
        </p>
      ) : null}
      {actionError !== null ? <ErrorNotice error={actionError} onRefresh={onRefresh} /> : null}

      <section data-testid="contract-summary" aria-label={translate('page.82fe9340d299')}>
        <dl>
          <dt>{translate('page.e732638998ba')}</dt>
          <dd>{contract.contractNumber}</dd>
          <dt>{translate('page.eec5002799b1')}</dt>
          <dd>{contract.name}</dd>
          <dt>{translate('page.f20687060126')}</dt>
          <dd data-testid="contract-detail-customer">{customerName ?? contract.customerId}</dd>
          <dt>{translate('page.60beedc8f22b')}</dt>
          <dd data-testid="contract-detail-contact">{contract.contact ?? translate('page.10e96b649498')}</dd>
          <dt>{translate('page.1789ad816f47')}</dt>
          <dd>{formatServicePeriod(contract.startAt, contract.endAt)}</dd>
          <dt>{translate('page.b6ee2af15cf5')}</dt>
          <dd data-testid="contract-detail-status">{CONTRACT_STATUS_LABELS[status]}</dd>
          <dt>{translate('page.20de4a0b3abc')}</dt>
          <dd data-testid="contract-detail-version">v{contract.version}</dd>
          <dt>{translate('page.fcbd0932929e')}</dt>
          <dd>
            {contract.createdBy} · <TimeText iso={contract.createdAt} />
          </dd>
          <dt>{translate('page.d9db02d07adb')}</dt>
          <dd>
            <TimeText iso={contract.updatedAt} />
          </dd>
        </dl>
        <div className="action-row">
          <Button
            type="button"
            data-testid="contract-edit-open"
            disabled={busy || gate('edit') !== null}
            {...(gate('edit') !== null ? { title: gate('edit') ?? '' } : {})}
            onClick={() => {
              setEditDraft({
                contractNumber: contract.contractNumber,
                name: contract.name,
                customerId: contract.customerId,
                contact: contract.contact ?? '',
                startAt: contract.startAt,
                endAt: contract.endAt,
              });
              setEditReason('');
            }}
          >
            {translate('page.a7f814c0a40d')}
          </Button>
          <Button
            type="button"
            data-testid="contract-activate-open"
            disabled={busy || gate('activate') !== null}
            {...(gate('activate') !== null ? { title: gate('activate') ?? '' } : {})}
            onClick={() => setConfirm({ kind: 'activate' })}
          >
            {translate('page.4c25820818d6')}
          </Button>
          <Button
            type="button"
            data-testid="contract-renew-open"
            disabled={busy || gate('renew') !== null}
            {...(gate('renew') !== null ? { title: gate('renew') ?? '' } : {})}
            onClick={() => {
              setRenewEndAt('');
              setRenewReason('');
            }}
          >
            {translate('page.f7d3735c18eb')}
          </Button>
          <Button
            type="button"
            className="danger-button"
            data-testid="contract-terminate-open"
            disabled={busy || gate('terminate') !== null}
            {...(gate('terminate') !== null ? { title: gate('terminate') ?? '' } : {})}
            onClick={() => setConfirm({ kind: 'terminate' })}
          >
            {translate('page.2eee5759c39c')}
          </Button>
        </div>
      </section>

      <section data-testid="contract-devices-table" aria-label={translate('page.b113e4704c10')}>
        <div className="page-header">
          <h4>{translate('page.b113e4704c10')}</h4>
          <span className="action-row">
            <Button
              type="button"
              data-testid="contract-bind-open"
              disabled={busy || gate('bind') !== null}
              {...(gate('bind') !== null ? { title: gate('bind') ?? '' } : {})}
              onClick={openBind}
            >
              {translate('page.b113e4704c10')}
            </Button>
            <Button
              type="button"
              className="danger-button"
              data-testid="contract-unbind-open"
              disabled={busy || unbindSelected.length === 0 || gate('unbind') !== null}
              {...(gate('unbind') !== null ? { title: gate('unbind') ?? '' } : {})}
              onClick={() => setConfirm({ kind: 'unbind', deviceIds: unbindSelected })}
            >
              {translate('page.39bd5faf0fb5')}
            </Button>
          </span>
        </div>
        {devices.error !== undefined ? <ErrorNotice error={devices.error} onRefresh={onRefresh} /> : null}
        {licenseError !== undefined ? <ErrorNotice error={licenseError} onRefresh={onRefresh} /> : null}
        {devices.rows === null ? (
          <div role="status">{translate('page.300ee3dee4dc')}</div>
        ) : devices.rows.length === 0 ? (
          <p className="empty-state" data-testid="contract-devices-empty">
            {translate('page.d05230204feb')}
          </p>
        ) : (
          <div className="cursor-table">
            <table aria-label={translate('page.c6ba0d8ee216')}>
              <thead>
                <tr>
                  <th scope="col">{translate('page.70b208202ce5')}</th>
                  <th scope="col">{translate('page.95789af4f9fc')}</th>
                  <th scope="col">{translate('page.ec537c546d90')}</th>
                  <th scope="col">{translate('page.17fc93c9cdbb')}</th>
                  <th scope="col">{translate('page.e1973949d60a')}</th>
                  <th scope="col">{translate('page.619bc67325a4')}</th>
                  <th scope="col">{translate('page.d6ee5acd60f7')}</th>
                  <th scope="col">{translate('page.257e4bf4b3df')}</th>
                  <th scope="col">{translate('page.862d3ff54bf1')}</th>
                  <th scope="col">{translate('page.87d24fa26e57')}</th>
                </tr>
              </thead>
              <tbody>
                {devices.rows.map(({ association, device }) => (
                  <tr key={device.deviceId}>
                    <td>
                      {association.status === 'ACTIVE' ? (
                        <Input
                          type="checkbox"
                          aria-label={translate('page.70b208202ce5') + ' ' + device.deviceId}
                          data-testid={`contract-unbind-check-${device.deviceId}`}
                          checked={unbindSelected.includes(device.deviceId)}
                          onChange={(event) =>
                            setUnbindSelected(
                              event.target.checked
                                ? [...unbindSelected, device.deviceId]
                                : unbindSelected.filter((id) => id !== device.deviceId),
                            )
                          }
                        />
                      ) : (
                        '—'
                      )}
                    </td>
                    <td>{device.deviceId}</td>
                    <td>{device.alias ?? '—'}</td>
                    <td>{device.site?.region ?? '—'}</td>
                    <td>{device.site?.subregion ?? '—'}</td>
                    <td>{device.site?.name ?? '—'}</td>
                    <td>{device.firmwareVersion ?? '—'}</td>
                    <td>
                      <span data-testid={`contract-device-axes-${device.deviceId}`}>
                        <FourAxisBadges
                          status={{
                            connectivity: device.connectivity,
                            lifecycle: device.lifecycleStatus,
                            operational: device.operationalStatus,
                            license: device.licenseStatus,
                          }}
                        />
                      </span>
                    </td>
                    <td>
                      <LicenseSummary summary={licenses?.[device.deviceId] ?? null} onOpen={onOpenLicense} />
                    </td>
                    <td>
                      {association.validFrom.slice(0, 10)} ~ {association.validTo?.slice(0, 10) ?? '—'}（
                      {ASSOCIATION_STATUS_LABELS[association.status] ?? association.status}）
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section data-testid="contract-associations" aria-label={translate('page.79d0d3a35e71')}>
        <h4>{translate('page.79d0d3a35e71')}</h4>
        {associations === null ? (
          <div role="status">{translate('page.300ee3dee4dc')}</div>
        ) : associations.length === 0 ? (
          <p className="empty-state">{translate('page.f4d45621b3d2')}</p>
        ) : (
          <div className="cursor-table">
            <table aria-label={translate('page.b7fed88bb343')}>
              <thead>
                <tr>
                  <th scope="col">{translate('page.01f2c16cda65')}</th>
                  <th scope="col">{translate('page.a70a15135c37')}</th>
                  <th scope="col">{translate('page.62e951a692ff')}</th>
                  <th scope="col">{translate('page.fcbd0932929e')}</th>
                  <th scope="col">{translate('page.76b9880829e0')}</th>
                </tr>
              </thead>
              <tbody>
                {associations.map((association) => (
                  <tr key={association.associationId}>
                    <td>{association.deviceId}</td>
                    <td>
                      {association.validFrom.slice(0, 10)} ~ {association.validTo?.slice(0, 10) ?? '—'}
                    </td>
                    <td>{ASSOCIATION_STATUS_LABELS[association.status] ?? association.status}</td>
                    <td>
                      <TimeText iso={association.createdAt} />
                    </td>
                    <td>{association.endedAt !== null ? <TimeText iso={association.endedAt} /> : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <Modal
        open={editDraft !== null}
        title={translate('page.fe80a0e9972c')}
        testid="contract-edit-form"
        onClose={() => setEditDraft(null)}
      >
        {editDraft !== null ? (
          <div>
            <p className="field-hint">
              If-Match：v{contract.version}
              {translate('page.700f6ff8900c')}
            </p>
            <div className="dialog-field">
              <label htmlFor="contract-edit-name">{translate('page.eec5002799b1')}</label>
              <Input
                id="contract-edit-name"
                data-testid="contract-edit-name"
                maxLength={200}
                value={editDraft.name}
                onChange={(event) => setEditDraft({ ...editDraft, name: event.target.value })}
              />
            </div>
            <div className="dialog-field">
              <label htmlFor="contract-edit-contact">{translate('page.60beedc8f22b')}</label>
              <Input
                id="contract-edit-contact"
                data-testid="contract-edit-contact"
                maxLength={200}
                value={editDraft.contact}
                onChange={(event) => setEditDraft({ ...editDraft, contact: event.target.value })}
              />
            </div>
            {status === 'DRAFT' ? (
              <div className="dialog-field">
                <label htmlFor="contract-edit-start">{translate('page.0ed8daddc54b')}</label>
                <Input
                  id="contract-edit-start"
                  data-testid="contract-edit-start"
                  value={editDraft.startAt}
                  onChange={(event) => setEditDraft({ ...editDraft, startAt: event.target.value })}
                />
                <label htmlFor="contract-edit-end">{translate('page.a1bf0b770919')}</label>
                <Input
                  id="contract-edit-end"
                  data-testid="contract-edit-end"
                  value={editDraft.endAt}
                  onChange={(event) => setEditDraft({ ...editDraft, endAt: event.target.value })}
                />
              </div>
            ) : null}
            {editFieldErrors !== null && editFieldErrors['period'] !== undefined ? (
              <p className="field-hint" data-testid="contract-edit-error-period">
                {editFieldErrors['period']}
              </p>
            ) : null}
            <div className="dialog-field">
              <label htmlFor="contract-edit-reason">{translate('page.c25db741afe8')}</label>
              <Input
                id="contract-edit-reason"
                data-testid="contract-edit-reason"
                maxLength={500}
                value={editReason}
                onChange={(event) => setEditReason(event.target.value)}
              />
            </div>
            <div className="dialog-actions">
              <Button
                type="button"
                className="primary-button"
                data-testid="contract-edit-submit"
                disabled={busy || editFieldErrors !== null || editReason.trim() === ''}
                onClick={() => void submitEdit()}
              >
                {translate('page.fadf24dbc5a9')}
              </Button>
            </div>
          </div>
        ) : null}
      </Modal>

      <Modal
        open={renewEndAt !== null}
        title={translate('page.71549b1a320e')}
        testid="contract-renew-form"
        onClose={() => setRenewEndAt(null)}
      >
        {renewEndAt !== null ? (
          <div>
            <p className="field-hint">
              If-Match：v{contract.version}
              {translate('page.8ca11a88bfcc')}
              {contract.endAt.slice(0, 10)}）。
            </p>
            <div className="dialog-field">
              <label htmlFor="contract-renew-end">{translate('page.540c7d9c2407')}</label>
              <Input
                id="contract-renew-end"
                data-testid="contract-renew-end"
                value={renewEndAt}
                onChange={(event) => setRenewEndAt(event.target.value)}
              />
            </div>
            {renewError !== null ? (
              <p className="field-hint" data-testid="contract-renew-error">
                {renewError}
              </p>
            ) : null}
            <div className="dialog-field">
              <label htmlFor="contract-renew-reason">{translate('page.c25db741afe8')}</label>
              <Input
                id="contract-renew-reason"
                data-testid="contract-renew-reason"
                maxLength={500}
                value={renewReason}
                onChange={(event) => setRenewReason(event.target.value)}
              />
            </div>
            <div className="dialog-actions">
              <Button
                type="button"
                className="primary-button"
                data-testid="contract-renew-submit"
                disabled={busy || renewError !== null || renewReason.trim() === ''}
                onClick={() => void submitRenew()}
              >
                {translate('page.2326e59ede1d')}
              </Button>
            </div>
          </div>
        ) : null}
      </Modal>

      <Modal
        open={bindOpen}
        title={translate('page.d3ca3e6b7106')}
        testid="contract-bind-form"
        onClose={() => setBindOpen(false)}
      >
        <p className="field-hint">{translate('page.816ff488d0a0')}</p>
        {available === null ? (
          <div role="status" data-testid="contract-bind-loading">
            {translate('page.d360706fdd30')}
          </div>
        ) : available.length === 0 ? (
          <p className="empty-state" data-testid="contract-bind-empty">
            {translate('page.941fc73da805')}
          </p>
        ) : (
          <div role="group" aria-label={translate('page.16c798774b40')} data-testid="contract-bind-list">
            {available.map((device) => (
              <label key={device.deviceId}>
                <Input
                  type="checkbox"
                  data-testid={`contract-bind-check-${device.deviceId}`}
                  checked={bindSelected.includes(device.deviceId)}
                  onChange={(event) =>
                    setBindSelected(
                      event.target.checked
                        ? [...bindSelected, device.deviceId]
                        : bindSelected.filter((id) => id !== device.deviceId),
                    )
                  }
                />
                {device.alias ?? device.serialNumber}（{device.model}）
              </label>
            ))}
          </div>
        )}
        <div className="dialog-field">
          <label htmlFor="contract-bind-reason">{translate('page.c25db741afe8')}</label>
          <Input
            id="contract-bind-reason"
            data-testid="contract-bind-reason"
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
            disabled={busy || bindSelected.length === 0 || bindReason.trim() === ''}
            onClick={() => void submitBind()}
          >
            {translate('page.1d5832409c92')}
          </Button>
        </div>
      </Modal>

      <ConfirmDialog
        open={confirm !== null}
        title={
          confirm?.kind === 'activate'
            ? translate('page.1c55a604270f')
            : confirm?.kind === 'terminate'
              ? translate('page.cec6d632492e')
              : translate('page.80d59b5959b1') +
                ' ' +
                (confirm?.deviceIds.length ?? 0) +
                (' ' + translate('page.e431f5fd249e'))
        }
        description={
          confirm?.kind === 'activate'
            ? translate('page.dea92f2f9b00')
            : confirm?.kind === 'terminate'
              ? translate('page.f75beec79678')
              : translate('page.42f65445dc0f')
        }
        requireReason
        {...(confirm?.kind !== 'activate' ? { danger: true } : {})}
        confirmText={
          confirm?.kind === 'activate'
            ? translate('page.427c6f9a814c')
            : confirm?.kind === 'terminate'
              ? translate('page.b7b8c9af1c75')
              : translate('page.e92f73a9b9df')
        }
        onConfirm={(reason) => void submitConfirm(reason)}
        onCancel={() => setConfirm(null)}
      />
    </div>
  );
}
