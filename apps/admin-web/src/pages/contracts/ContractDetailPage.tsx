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
import type { Role } from '@fdp/auth';
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
  readonly devices: { readonly rows: readonly ContractDeviceDetailView[] | null; readonly error?: unknown };
  readonly associations: readonly ContractDeviceAssociationView[] | null;
  /** 每设备 License 摘要（独立授权轴；DEC-007 并列展示，不联动修改）。 */
  readonly licenses?: Readonly<Record<string, DeviceLicenseSummaryView | null>>;
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
  | { readonly kind: 'activate' }
  | { readonly kind: 'terminate' }
  | { readonly kind: 'unbind'; readonly deviceIds: readonly string[] };

export function ContractDetailPage({
  role,
  contract,
  contractError,
  customerName,
  devices,
  associations,
  licenses,
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
        <button type="button" data-testid="contract-detail-back" onClick={onBack}>
          返回
        </button>
        <ErrorNotice error={contractError} onRefresh={onRefresh} />
      </div>
    );
  }
  if (contract === null) {
    return (
      <div className="contract-detail-page" data-testid="contract-detail-page" role="status">
        加载中…
      </div>
    );
  }

  const status = contract.derivedStatus;
  const gate = (action: Parameters<typeof gateContractAction>[0]) => gateContractAction(action, status, role);
  const editFieldErrors = editDraft !== null ? validateContractForm({ ...editDraft, customerId: contract.customerId }) : null;
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
      return '合约已更新';
    });

  const submitRenew = () =>
    runAction(async () => {
      if (renewEndAt === null || renewError !== null) return '';
      await onRenew(renewEndAt, renewReason.trim(), contract.version);
      setRenewEndAt(null);
      setRenewReason('');
      return '合约已续约（状态按新窗口重推导；不自动续期 License）';
    });

  const submitConfirm = (reason: string) =>
    runAction(async () => {
      if (confirm === null) return '';
      if (confirm.kind === 'activate') {
        await onActivate(reason, contract.version);
        return '合约已激活（DRAFT→生效中；不自动激活 License）';
      }
      if (confirm.kind === 'terminate') {
        await onTerminate(reason, contract.version);
        return '合约已终止（终态；不撤销 License）';
      }
      const unbound = await onUnbind(confirm.deviceIds, reason);
      setUnbindSelected([]);
      return `已解绑 ${unbound.length} 台设备（不撤销 License，授权状态不受影响）`;
    });

  const submitBind = () =>
    runAction(async () => {
      if (bindSelected.length === 0) return '';
      const bound = await onBind(bindSelected, bindReason.trim());
      setBindOpen(false);
      return `已关联 ${bound.length} 台设备（全成或全败；不代表 Entitlement）`;
    });

  return (
    <div className="contract-detail-page" data-testid="contract-detail-page">
      <div className="page-header">
        <button type="button" data-testid="contract-detail-back" onClick={onBack}>
          返回
        </button>
        <h3>合约详情：{contract.contractNumber}</h3>
      </div>

      {notice !== null ? (
        <p className="action-notice" role="status" data-testid="action-notice">
          {notice}
        </p>
      ) : null}
      {actionError !== null ? <ErrorNotice error={actionError} onRefresh={onRefresh} /> : null}

      <section data-testid="contract-summary" aria-label="合约信息">
        <dl>
          <dt>合约编号</dt>
          <dd>{contract.contractNumber}</dd>
          <dt>合约名称</dt>
          <dd>{contract.name}</dd>
          <dt>客户</dt>
          <dd data-testid="contract-detail-customer">{customerName ?? contract.customerId}</dd>
          <dt>联系方式</dt>
          <dd data-testid="contract-detail-contact">{contract.contact ?? '（最小权限不可见）'}</dd>
          <dt>服务期限</dt>
          <dd>{formatServicePeriod(contract.startAt, contract.endAt)}</dd>
          <dt>合约状态</dt>
          <dd data-testid="contract-detail-status">{CONTRACT_STATUS_LABELS[status]}</dd>
          <dt>版本（乐观锁）</dt>
          <dd data-testid="contract-detail-version">v{contract.version}</dd>
          <dt>创建</dt>
          <dd>
            {contract.createdBy} · <TimeText iso={contract.createdAt} />
          </dd>
          <dt>更新</dt>
          <dd>
            <TimeText iso={contract.updatedAt} />
          </dd>
        </dl>
        <div className="action-row">
          <button
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
            编辑
          </button>
          <button
            type="button"
            data-testid="contract-activate-open"
            disabled={busy || gate('activate') !== null}
            {...(gate('activate') !== null ? { title: gate('activate') ?? '' } : {})}
            onClick={() => setConfirm({ kind: 'activate' })}
          >
            激活
          </button>
          <button
            type="button"
            data-testid="contract-renew-open"
            disabled={busy || gate('renew') !== null}
            {...(gate('renew') !== null ? { title: gate('renew') ?? '' } : {})}
            onClick={() => {
              setRenewEndAt('');
              setRenewReason('');
            }}
          >
            续约
          </button>
          <button
            type="button"
            className="danger-button"
            data-testid="contract-terminate-open"
            disabled={busy || gate('terminate') !== null}
            {...(gate('terminate') !== null ? { title: gate('terminate') ?? '' } : {})}
            onClick={() => setConfirm({ kind: 'terminate' })}
          >
            终止
          </button>
        </div>
      </section>

      <section data-testid="contract-devices-table" aria-label="关联设备">
        <div className="page-header">
          <h4>关联设备</h4>
          <span className="action-row">
            <button
              type="button"
              data-testid="contract-bind-open"
              disabled={busy || gate('bind') !== null}
              {...(gate('bind') !== null ? { title: gate('bind') ?? '' } : {})}
              onClick={openBind}
            >
              关联设备
            </button>
            <button
              type="button"
              className="danger-button"
              data-testid="contract-unbind-open"
              disabled={busy || unbindSelected.length === 0 || gate('unbind') !== null}
              {...(gate('unbind') !== null ? { title: gate('unbind') ?? '' } : {})}
              onClick={() => setConfirm({ kind: 'unbind', deviceIds: unbindSelected })}
            >
              解绑所选（不撤销 License）
            </button>
          </span>
        </div>
        {devices.error !== undefined ? <ErrorNotice error={devices.error} onRefresh={onRefresh} /> : null}
        {devices.rows === null ? (
          <div role="status">加载中…</div>
        ) : devices.rows.length === 0 ? (
          <p className="empty-state" data-testid="contract-devices-empty">
            暂无关联设备
          </p>
        ) : (
          <table aria-label="关联设备列表">
            <thead>
              <tr>
                <th scope="col">选择</th>
                <th scope="col">唯一 ID</th>
                <th scope="col">别名</th>
                <th scope="col">区域</th>
                <th scope="col">子区域</th>
                <th scope="col">站点</th>
                <th scope="col">软件版本</th>
                <th scope="col">四轴状态</th>
                <th scope="col">授权状态（License，独立）</th>
                <th scope="col">租期</th>
              </tr>
            </thead>
            <tbody>
              {devices.rows.map(({ association, device }) => (
                <tr key={device.deviceId}>
                  <td>
                    {association.status === 'ACTIVE' ? (
                      <input
                        type="checkbox"
                        aria-label={`选择 ${device.deviceId}`}
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
                    <LicenseSummary summary={licenses?.[device.deviceId] ?? null} />
                  </td>
                  <td>
                    {association.validFrom.slice(0, 10)} ~ {association.validTo?.slice(0, 10) ?? '—'}（
                    {ASSOCIATION_STATUS_LABELS[association.status] ?? association.status}）
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section data-testid="contract-associations" aria-label="关联历史">
        <h4>关联历史</h4>
        {associations === null ? (
          <div role="status">加载中…</div>
        ) : associations.length === 0 ? (
          <p className="empty-state">暂无关联历史</p>
        ) : (
          <table aria-label="关联历史列表">
            <thead>
              <tr>
                <th scope="col">设备</th>
                <th scope="col">窗口</th>
                <th scope="col">状态</th>
                <th scope="col">创建</th>
                <th scope="col">结束</th>
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
        )}
      </section>

      <Modal open={editDraft !== null} title="编辑合约" testid="contract-edit-form" onClose={() => setEditDraft(null)}>
        {editDraft !== null ? (
          <div>
            <p className="field-hint">If-Match：v{contract.version}；startAt/endAt 仅草稿状态可改。</p>
            <div className="dialog-field">
              <label htmlFor="contract-edit-name">合约名称</label>
              <input
                id="contract-edit-name"
                data-testid="contract-edit-name"
                maxLength={200}
                value={editDraft.name}
                onChange={(event) => setEditDraft({ ...editDraft, name: event.target.value })}
              />
            </div>
            <div className="dialog-field">
              <label htmlFor="contract-edit-contact">联系方式</label>
              <input
                id="contract-edit-contact"
                data-testid="contract-edit-contact"
                maxLength={200}
                value={editDraft.contact}
                onChange={(event) => setEditDraft({ ...editDraft, contact: event.target.value })}
              />
            </div>
            {status === 'DRAFT' ? (
              <div className="dialog-field">
                <label htmlFor="contract-edit-start">有效期起（UTC）</label>
                <input
                  id="contract-edit-start"
                  data-testid="contract-edit-start"
                  value={editDraft.startAt}
                  onChange={(event) => setEditDraft({ ...editDraft, startAt: event.target.value })}
                />
                <label htmlFor="contract-edit-end">有效期止（UTC）</label>
                <input
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
              <label htmlFor="contract-edit-reason">原因（强制）</label>
              <input
                id="contract-edit-reason"
                data-testid="contract-edit-reason"
                maxLength={500}
                value={editReason}
                onChange={(event) => setEditReason(event.target.value)}
              />
            </div>
            <div className="dialog-actions">
              <button
                type="button"
                className="primary-button"
                data-testid="contract-edit-submit"
                disabled={busy || editFieldErrors !== null || editReason.trim() === ''}
                onClick={() => void submitEdit()}
              >
                保存
              </button>
            </div>
          </div>
        ) : null}
      </Modal>

      <Modal open={renewEndAt !== null} title="续约合约" testid="contract-renew-form" onClose={() => setRenewEndAt(null)}>
        {renewEndAt !== null ? (
          <div>
            <p className="field-hint">If-Match：v{contract.version}；新到期时间必须晚于当前（{contract.endAt.slice(0, 10)}）。</p>
            <div className="dialog-field">
              <label htmlFor="contract-renew-end">新到期时间（UTC）</label>
              <input
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
              <label htmlFor="contract-renew-reason">原因（强制）</label>
              <input
                id="contract-renew-reason"
                data-testid="contract-renew-reason"
                maxLength={500}
                value={renewReason}
                onChange={(event) => setRenewReason(event.target.value)}
              />
            </div>
            <div className="dialog-actions">
              <button
                type="button"
                className="primary-button"
                data-testid="contract-renew-submit"
                disabled={busy || renewError !== null || renewReason.trim() === ''}
                onClick={() => void submitRenew()}
              >
                确认续约
              </button>
            </div>
          </div>
        ) : null}
      </Modal>

      <Modal open={bindOpen} title="关联设备（eligible 列表）" testid="contract-bind-form" onClose={() => setBindOpen(false)}>
        <p className="field-hint">仅可关联列表内设备（同 Customer、非 Retired、无有效关联）；批量全成或全败。</p>
        {available === null ? (
          <div role="status" data-testid="contract-bind-loading">
            加载 eligible 设备中…
          </div>
        ) : available.length === 0 ? (
          <p className="empty-state" data-testid="contract-bind-empty">
            当前无可关联设备
          </p>
        ) : (
          <div role="group" aria-label="可关联设备" data-testid="contract-bind-list">
            {available.map((device) => (
              <label key={device.deviceId}>
                <input
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
          <label htmlFor="contract-bind-reason">原因（强制）</label>
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
            disabled={busy || bindSelected.length === 0 || bindReason.trim() === ''}
            onClick={() => void submitBind()}
          >
            关联所选
          </button>
        </div>
      </Modal>

      <ConfirmDialog
        open={confirm !== null}
        title={
          confirm?.kind === 'activate'
            ? '激活合约'
            : confirm?.kind === 'terminate'
              ? '终止合约'
              : `解绑 ${confirm?.deviceIds.length ?? 0} 台设备`
        }
        description={
          confirm?.kind === 'activate'
            ? '激活后进入生效中（不自动激活 License）。'
            : confirm?.kind === 'terminate'
              ? '终止为终态（不撤销 License）。'
              : '解绑闭合关联窗口（不撤销 License，授权状态不受影响）。'
        }
        requireReason
        {...(confirm?.kind !== 'activate' ? { danger: true } : {})}
        confirmText={confirm?.kind === 'activate' ? '确认激活' : confirm?.kind === 'terminate' ? '确认终止' : '确认解绑'}
        onConfirm={(reason) => void submitConfirm(reason)}
        onCancel={() => setConfirm(null)}
      />
    </div>
  );
}
