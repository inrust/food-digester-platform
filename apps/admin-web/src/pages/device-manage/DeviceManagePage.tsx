/**
 * FE-07 设备生命周期操作页（/devices/manage）：Assignment、Suspend、Reactivate、Retire、
 * 别名修改（If-Match）、证书摘要与轮换请求（BE-CERT-03）。
 *
 * - 动作可用性 = LIFECYCLE_ACTION_MATRIX（契约转换条件）∩ 角色权限（AUTH-01/DOM-01）；
 *   非法操作按钮禁用并说明原因，后端拒绝（403/409）仍经 ErrorNotice 正确呈现；
 * - 危险操作（suspend/reactivate/retire/force-complete）要求原因 + 明确确认；
 *   Retire 展示不可恢复警告；成功后展示退役记录（PENDING_CONFIRMATION = 等待设备确认，
 *   DEC-014：72 小时窗口内证书保持 ACTIVE 且仅允许 Sync/Deactivate）；
 * - 不直接修改状态字段（无本地状态伪造，操作成功一律经 onRefresh 回源）；
 * - 证书区仅显示 ID/指纹/状态摘要，不展示/下载私钥；轮换按钮表达为“请求轮换”；
 * - FE-13：固件上传/同步更新跳转受控 OTA（/ota/packages、/ota/campaigns），不直接推送单设备。
 */
import { useRef, useState } from 'react';
import type { Role } from '@fdp/auth';
import { hasPermission } from '@fdp/auth';
import { ConfirmDialog } from '../../components/ConfirmDialog.js';
import { ErrorNotice } from '../../components/ErrorNotice.js';
import { FourAxisBadges } from '../../components/FourAxisBadge.js';
import { Modal } from '../../components/Modal.js';
import { TimeText } from '../../components/TimeText.js';
import type { FilterOption } from '../../components/ScopeFilter.js';
import type { DeviceView } from '../devices/types.js';
import {
  ASSIGNMENT_STATUS_LABELS,
  CERTIFICATE_STATUS_LABELS,
  COMPLETION_METHOD_LABELS,
  RETIREMENT_STATUS_LABELS,
  ROTATION_REQUEST_STATUS_LABELS,
  canForceComplete,
  gateAction,
} from './device-manage-state.js';
import type {
  DeviceAssignmentView,
  DeviceMetadataView,
  DeviceStatusResultView,
  RetirementRecordView,
  RetirementResultView,
  RotationRequestView,
} from './types.js';

export interface DeviceManagePageProps {
  readonly role: Role;
  /** 当前设备；null = 未加载完成。 */
  readonly device: DeviceView | null;
  readonly loading?: boolean;
  readonly loadError?: unknown;
  /** Assignment 历史（倒序，上限 50）；null = 加载中。 */
  readonly assignments: readonly DeviceAssignmentView[] | null;
  readonly assignmentsError?: unknown;
  /** 最近一次 retire/force-complete 响应中的退役记录（无 GET 来源；刷新后由父级按设备状态决定是否保留）。 */
  readonly retirement: RetirementRecordView | null;
  /** 最近一次证书轮换请求响应。 */
  readonly rotation: RotationRequestView | null;
  /** 分配表单的 Customer/Site 选项（site 选项携带所属 customerId）。 */
  readonly customers: readonly FilterOption[];
  readonly sites: readonly (FilterOption & { customerId: string })[];
  readonly onBack: () => void;
  /** 操作成功后回源：重新加载设备详情与 Assignment 历史。 */
  readonly onRefresh: () => void;
  readonly onAssign: (input: { customerId: string; siteId: string; reason?: string }) => Promise<DeviceAssignmentView>;
  readonly onSuspend: (reason: string) => Promise<DeviceStatusResultView>;
  readonly onReactivate: (reason: string) => Promise<DeviceStatusResultView>;
  readonly onRetire: (reason: string) => Promise<RetirementResultView>;
  readonly onForceComplete: (reason: string) => Promise<RetirementResultView>;
  /** alias 提交；If-Match 由父级以当前 device.updatedAt 注入。 */
  readonly onUpdateAlias: (alias: string | null) => Promise<DeviceMetadataView>;
  readonly onRequestRotation: () => Promise<RotationRequestView>;
  /** FE-13 OTA 入口跳转（/ota/packages、/ota/campaigns）。 */
  readonly onNavigate: (path: string) => void;
}

type PendingAction = 'suspend' | 'reactivate' | 'retire' | 'forceComplete';

export function DeviceManagePage({
  role,
  device,
  loading = false,
  loadError,
  assignments,
  assignmentsError,
  retirement,
  rotation,
  customers,
  sites,
  onBack,
  onRefresh,
  onAssign,
  onSuspend,
  onReactivate,
  onRetire,
  onForceComplete,
  onUpdateAlias,
  onRequestRotation,
  onNavigate,
}: DeviceManagePageProps) {
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [assignOpen, setAssignOpen] = useState(false);
  const [aliasEditing, setAliasEditing] = useState(false);
  const [aliasDraft, setAliasDraft] = useState('');
  const [actionError, setActionError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);

  const runAction = async (execute: () => Promise<unknown>, successText: string) => {
    // 防重复点击：在途请求直接忽略（后端幂等/条件更新兜底）
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setPendingAction(null);
    setAssignOpen(false);
    setActionError(null);
    setNotice(null);
    try {
      await execute();
      setNotice(successText);
      // 操作后回源：设备状态与 Assignment 历史刷新（验收基准）
      onRefresh();
    } catch (err) {
      setActionError(err);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  if (loading) {
    return (
      <div className="device-manage-page" data-testid="device-manage-page">
        <div role="status" data-testid="manage-loading">
          加载中…
        </div>
      </div>
    );
  }
  if (loadError !== undefined) {
    return (
      <div className="device-manage-page" data-testid="device-manage-page">
        <ErrorNotice error={loadError} onRefresh={onRefresh} />
      </div>
    );
  }
  if (device === null) {
    return (
      <div className="device-manage-page" data-testid="device-manage-page">
        <p className="empty-state">未找到设备</p>
      </div>
    );
  }

  const gate = (action: Parameters<typeof gateAction>[0]) => gateAction(action, device, role);
  const assignGate = gate('assign');
  const suspendGate = gate('suspend');
  const reactivateGate = gate('reactivate');
  const retireGate = gate('retire');
  const aliasGate = gate('editAlias');
  const rotationGate = gate('requestRotation');
  const forceGate = canForceComplete(device, retirement, role);

  const aliasTrimmed = aliasDraft.trim();
  const aliasInvalid = aliasTrimmed.length > 64;

  return (
    <div className="device-manage-page" data-testid="device-manage-page">
      <div className="manage-header">
        <button type="button" data-testid="manage-back" onClick={onBack}>
          返回
        </button>
        <h3>
          {device.alias ?? device.serialNumber}
          <span className="device-serial">（{device.serialNumber}）</span>
        </h3>
        <FourAxisBadges
          status={{
            connectivity: device.connectivity,
            lifecycle: device.lifecycleStatus,
            operational: device.operationalStatus,
            license: device.license?.status ?? null,
          }}
        />
      </div>

      {notice !== null ? (
        <p className="action-notice" role="status" data-testid="action-notice">
          {notice}
        </p>
      ) : null}
      {actionError !== null ? <ErrorNotice error={actionError} onRefresh={onRefresh} /> : null}

      <section data-testid="lifecycle-actions" aria-label="生命周期操作">
        <h4>生命周期操作</h4>
        <div className="action-row">
          <button
            type="button"
            data-testid="action-assign"
            disabled={!assignGate.enabled || busy}
            {...(assignGate.reason !== null ? { title: assignGate.reason } : {})}
            onClick={() => setAssignOpen(true)}
          >
            分配/调整归属
          </button>
          <button
            type="button"
            data-testid="action-suspend"
            disabled={!suspendGate.enabled || busy}
            {...(suspendGate.reason !== null ? { title: suspendGate.reason } : {})}
            onClick={() => setPendingAction('suspend')}
          >
            挂起
          </button>
          <button
            type="button"
            data-testid="action-reactivate"
            disabled={!reactivateGate.enabled || busy}
            {...(reactivateGate.reason !== null ? { title: reactivateGate.reason } : {})}
            onClick={() => setPendingAction('reactivate')}
          >
            恢复
          </button>
          <button
            type="button"
            className="danger-button"
            data-testid="action-retire"
            disabled={!retireGate.enabled || busy}
            {...(retireGate.reason !== null ? { title: retireGate.reason } : {})}
            onClick={() => setPendingAction('retire')}
          >
            退役
          </button>
        </div>
      </section>

      <section data-testid="ota-entry" aria-label="OTA 升级">
        <h4>OTA 升级</h4>
        <p className="field-hint">
          固件上传（预签名 URL + Hash/签名校验）与同步更新（受控 Campaign，首批 1 台灰度）均在 OTA 页完成；
          不直接向单设备推送未校验文件。
        </p>
        {hasPermission(role, 'ota:read') ? (
          <div className="action-row">
            <button type="button" data-testid="goto-ota-packages" onClick={() => onNavigate('/ota/packages')}>
              选择固件文件
            </button>
            <button type="button" data-testid="goto-ota-campaigns" onClick={() => onNavigate('/ota/campaigns')}>
              同步更新
            </button>
          </div>
        ) : (
          <p className="deny-reason" data-testid="ota-entry-deny">
            需要 OTA 读权限（ota:read）
          </p>
        )}
      </section>

      <section data-testid="alias-section" aria-label="设备别名">
        <h4>设备别名</h4>
        {aliasEditing ? (
          <div className="alias-form" data-testid="alias-form">
            <label htmlFor="alias-input">别名（1..64 字符，同客户内唯一）</label>
            <input
              id="alias-input"
              data-testid="alias-input"
              value={aliasDraft}
              onChange={(event) => setAliasDraft(event.target.value)}
            />
            {aliasInvalid ? <p className="field-hint">别名超长（最多 64 字符）</p> : null}
            <div className="action-row">
              <button
                type="button"
                className="primary-button"
                data-testid="alias-save"
                disabled={busy || aliasInvalid || aliasTrimmed.length === 0}
                onClick={() =>
                  void runAction(async () => {
                    await onUpdateAlias(aliasTrimmed);
                    setAliasEditing(false);
                  }, '别名已更新')
                }
              >
                保存
              </button>
              <button
                type="button"
                data-testid="alias-clear"
                disabled={busy}
                onClick={() =>
                  void runAction(async () => {
                    await onUpdateAlias(null);
                    setAliasEditing(false);
                  }, '别名已清除')
                }
              >
                清除别名
              </button>
              <button type="button" data-testid="alias-cancel" onClick={() => setAliasEditing(false)}>
                取消
              </button>
            </div>
          </div>
        ) : (
          <div className="alias-view">
            <span data-testid="alias-current">{device.alias ?? '—'}</span>
            <button
              type="button"
              data-testid="alias-edit"
              disabled={!aliasGate.enabled || busy}
              {...(aliasGate.reason !== null ? { title: aliasGate.reason } : {})}
              onClick={() => {
                setAliasDraft(device.alias ?? '');
                setAliasEditing(true);
              }}
            >
              修改别名
            </button>
          </div>
        )}
      </section>

      <section data-testid="cert-summary" aria-label="证书摘要">
        <h4>证书摘要</h4>
        {device.certificate !== null ? (
          <dl>
            <dt>证书 ID</dt>
            <dd data-testid="cert-id">{device.certificate.certificateId}</dd>
            <dt>指纹</dt>
            <dd data-testid="cert-fingerprint">{device.certificate.fingerprint}</dd>
            <dt>状态</dt>
            <dd data-testid="cert-status">
              {CERTIFICATE_STATUS_LABELS[device.certificate.status] ?? device.certificate.status}
            </dd>
          </dl>
        ) : (
          <p className="empty-state" data-testid="cert-empty">
            未颁发证书
          </p>
        )}
        {rotation !== null ? (
          <p className="rotation-result" data-testid="rotation-result">
            轮换请求已受理（{rotation.requestId}），当前状态：
            {ROTATION_REQUEST_STATUS_LABELS[rotation.requestStatus] ?? rotation.requestStatus}
            ；证书到期日 {rotation.expiryDate}。设备将自行完成密钥生成与领取，本页面不提供私钥。
          </p>
        ) : null}
        <button
          type="button"
          data-testid="cert-rotate"
          disabled={!rotationGate.enabled || busy}
          {...(rotationGate.reason !== null ? { title: rotationGate.reason } : {})}
          onClick={() => void runAction(onRequestRotation, '证书轮换请求已提交，等待设备领取新证书')}
        >
          请求轮换
        </button>
      </section>

      {device.lifecycleStatus === 'Retired' ? (
        <section className="retirement-panel" data-testid="retirement-panel" aria-label="退役状态">
          <h4>退役状态（不可恢复）</h4>
          {retirement !== null ? (
            <>
              <dl>
                <dt>状态</dt>
                <dd data-testid="retirement-status">{RETIREMENT_STATUS_LABELS[retirement.status]}</dd>
                <dt>发起时间</dt>
                <dd>
                  <TimeText iso={retirement.initiatedAt} />
                </dd>
                <dt>原因</dt>
                <dd>{retirement.reason}</dd>
                {retirement.completionMethod !== null ? (
                  <>
                    <dt>完成方式</dt>
                    <dd data-testid="retirement-method">
                      {COMPLETION_METHOD_LABELS[retirement.completionMethod] ?? retirement.completionMethod}
                    </dd>
                  </>
                ) : null}
                {retirement.certificateRevokedAt !== null ? (
                  <>
                    <dt>证书撤销时间</dt>
                    <dd>
                      <TimeText iso={retirement.certificateRevokedAt} />
                    </dd>
                  </>
                ) : null}
              </dl>
              {retirement.status === 'PENDING_CONFIRMATION' ? (
                <p className="retirement-waiting" data-testid="retirement-waiting">
                  等待设备确认：72 小时确认窗口内证书保持有效（ACTIVE），设备仅可执行同步/停用；
                  确认、强制完成或超时后立即撤销证书。
                </p>
              ) : null}
              <button
                type="button"
                className="danger-button"
                data-testid="retire-force-complete"
                disabled={!forceGate.enabled || busy}
                {...(forceGate.reason !== null ? { title: forceGate.reason } : {})}
                onClick={() => setPendingAction('forceComplete')}
              >
                强制完成退役
              </button>
            </>
          ) : (
            <p className="retirement-unknown" data-testid="retirement-unknown">
              设备已退役（Retired，不可恢复）。
            </p>
          )}
        </section>
      ) : null}

      <section data-testid="assignment-history" aria-label="分配历史">
        <h4>Assignment 历史</h4>
        {assignmentsError !== undefined ? <ErrorNotice error={assignmentsError} onRefresh={onRefresh} /> : null}
        {assignments === null ? (
          <div role="status" data-testid="assignments-loading">
            加载中…
          </div>
        ) : assignments.length === 0 ? (
          <p className="empty-state" data-testid="assignments-empty">
            暂无分配记录
          </p>
        ) : (
          <table aria-label="分配历史">
            <thead>
              <tr>
                <th scope="col">客户</th>
                <th scope="col">站点</th>
                <th scope="col">状态</th>
                <th scope="col">分配时间</th>
                <th scope="col">结束时间</th>
                <th scope="col">操作人</th>
                <th scope="col">原因</th>
              </tr>
            </thead>
            <tbody>
              {assignments.map((a) => (
                <tr key={a.assignmentId} data-testid={`assignment-${a.assignmentId}`}>
                  <td>{a.customerId}</td>
                  <td>{a.siteId}</td>
                  <td>{ASSIGNMENT_STATUS_LABELS[a.status] ?? a.status}</td>
                  <td>
                    <TimeText iso={a.assignedAt} />
                  </td>
                  <td>{a.endedAt !== null ? <TimeText iso={a.endedAt} /> : '—'}</td>
                  <td>{a.assignedBy}</td>
                  <td>{a.reason ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <Modal open={assignOpen} title="分配/调整设备归属" testid="assign-dialog" onClose={() => setAssignOpen(false)}>
        <AssignForm
          customers={customers}
          sites={sites}
          currentCustomerId={device.customer?.id ?? null}
          currentSiteId={device.site?.id ?? null}
          busy={busy}
          onSubmit={(input) =>
            void runAction(async () => {
              await onAssign(input);
            }, '分配已完成')
          }
        />
      </Modal>

      <ConfirmDialog
        open={pendingAction === 'suspend'}
        title="挂起设备"
        danger
        requireReason
        reasonLabel="挂起原因"
        description={`挂起后设备停止正常运行（Active→Suspended）。设备：${device.serialNumber}`}
        confirmText="确认挂起"
        onConfirm={(reason) => void runAction(() => onSuspend(reason), '设备已挂起')}
        onCancel={() => setPendingAction(null)}
      />
      <ConfirmDialog
        open={pendingAction === 'reactivate'}
        title="恢复设备"
        requireReason
        reasonLabel="恢复原因"
        description={`确认问题已解决后恢复（Suspended→Active），恢复原因与确认将写入审计。设备：${device.serialNumber}`}
        confirmText="确认恢复"
        onConfirm={(reason) => void runAction(() => onReactivate(reason), '设备已恢复')}
        onCancel={() => setPendingAction(null)}
      />
      <ConfirmDialog
        open={pendingAction === 'retire'}
        title="退役设备"
        danger
        requireReason
        reasonLabel="退役原因"
        description={`退役不可恢复：将撤销设备归属、授权与许可，并进入最长 72 小时的设备确认窗口。设备：${device.serialNumber}`}
        confirmText="确认退役（不可恢复）"
        onConfirm={(reason) => void runAction(() => onRetire(reason), '设备已退役，等待设备确认')}
        onCancel={() => setPendingAction(null)}
      />
      <ConfirmDialog
        open={pendingAction === 'forceComplete'}
        title="强制完成退役"
        danger
        requireReason
        reasonLabel="强制完成原因"
        description="适用于离线等无法自行确认的设备：立即完成退役并撤销证书，不再等待设备确认。"
        confirmText="确认强制完成"
        onConfirm={(reason) => void runAction(() => onForceComplete(reason), '退役已强制完成，证书已撤销')}
        onCancel={() => setPendingAction(null)}
      />
    </div>
  );
}

function AssignForm({
  customers,
  sites,
  currentCustomerId,
  currentSiteId,
  busy,
  onSubmit,
}: {
  readonly customers: readonly FilterOption[];
  readonly sites: readonly (FilterOption & { customerId: string })[];
  readonly currentCustomerId: string | null;
  readonly currentSiteId: string | null;
  readonly busy: boolean;
  readonly onSubmit: (input: { customerId: string; siteId: string; reason?: string }) => void;
}) {
  const [customerId, setCustomerId] = useState(currentCustomerId ?? '');
  const [siteId, setSiteId] = useState(currentSiteId ?? '');
  const [reason, setReason] = useState('');
  const siteOptions = sites.filter((s) => s.customerId === customerId);
  const reasonTrimmed = reason.trim();

  return (
    <div className="assign-form" data-testid="assign-form">
      <div className="dialog-field">
        <label htmlFor="assign-customer">所属客户</label>
        <select
          id="assign-customer"
          data-testid="assign-customer"
          value={customerId}
          onChange={(event) => {
            setCustomerId(event.target.value);
            setSiteId('');
          }}
        >
          <option value="">请选择客户</option>
          {customers.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
      </div>
      <div className="dialog-field">
        <label htmlFor="assign-site">所属站点（须属于所选客户）</label>
        <select
          id="assign-site"
          data-testid="assign-site"
          value={siteId}
          disabled={customerId === ''}
          onChange={(event) => setSiteId(event.target.value)}
        >
          <option value="">请选择站点</option>
          {siteOptions.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
      </div>
      <div className="dialog-field">
        <label htmlFor="assign-reason">分配原因（可选，写入审计）</label>
        <textarea
          id="assign-reason"
          data-testid="assign-reason"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
      </div>
      <div className="dialog-actions">
        <button
          type="button"
          className="primary-button"
          data-testid="assign-submit"
          disabled={busy || customerId === '' || siteId === ''}
          onClick={() =>
            onSubmit({
              customerId,
              siteId,
              ...(reasonTrimmed !== '' ? { reason: reasonTrimmed } : {}),
            })
          }
        >
          确认分配
        </button>
      </div>
    </div>
  );
}
