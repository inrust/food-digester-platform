import { Button, Input, TextArea } from '../../components/ui.js';
import { translate } from '../../i18n/i18n.js';
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
import type { Role } from '@fdp/auth/browser';
import { hasPermission } from '@fdp/auth/browser';
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
  readonly sites: readonly (FilterOption & {
    customerId: string;
  })[];
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
          {translate('page.300ee3dee4dc')}
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
        <p className="empty-state">{translate('page.6302de6c963f')}</p>
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
  const aliasTrimmed = aliasDraft.trim().normalize('NFC');
  const aliasLength = [...aliasTrimmed].length;
  const aliasInvalid = aliasLength > 64;
  return (
    <div className="device-manage-page" data-testid="device-manage-page">
      <div className="manage-header">
        <Button type="button" data-testid="manage-back" onClick={onBack}>
          {translate('page.11d024154013')}
        </Button>
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

      <section data-testid="lifecycle-actions" aria-label={translate('page.e4c42ba44ddc')}>
        <h4>{translate('page.e4c42ba44ddc')}</h4>
        <div className="action-row">
          <Button
            type="button"
            data-testid="action-assign"
            disabled={!assignGate.enabled || busy}
            {...(assignGate.reason !== null ? { title: assignGate.reason } : {})}
            onClick={() => setAssignOpen(true)}
          >
            {translate('page.9b3626b5d30f')}
          </Button>
          <Button
            type="button"
            data-testid="action-suspend"
            disabled={!suspendGate.enabled || busy}
            {...(suspendGate.reason !== null ? { title: suspendGate.reason } : {})}
            onClick={() => setPendingAction('suspend')}
          >
            {translate('page.b16ccb7bb587')}
          </Button>
          <Button
            type="button"
            data-testid="action-reactivate"
            disabled={!reactivateGate.enabled || busy}
            {...(reactivateGate.reason !== null ? { title: reactivateGate.reason } : {})}
            onClick={() => setPendingAction('reactivate')}
          >
            {translate('page.79748ca1c6e5')}
          </Button>
          <Button
            type="button"
            className="danger-button"
            data-testid="action-retire"
            disabled={!retireGate.enabled || busy}
            {...(retireGate.reason !== null ? { title: retireGate.reason } : {})}
            onClick={() => setPendingAction('retire')}
          >
            {translate('page.a3a128e21ebb')}
          </Button>
        </div>
      </section>

      {hasPermission(role, 'config:read') ? (
        <section data-testid="configuration-entry" aria-label={translate('qa08.configurationEntry')}>
          <h4>{translate('qa08.configurationEntry')}</h4>
          <Button type="button" data-testid="goto-current-config" onClick={() => onNavigate('/configurations')}>
            {translate('qa08.viewConfiguration')}
          </Button>
          {hasPermission(role, 'config:publish') ? (
            <Button type="button" data-testid="goto-publish-config" onClick={() => onNavigate('/configurations')}>
              {translate('qa08.updateConfiguration')}
            </Button>
          ) : null}
        </section>
      ) : null}
      <section data-testid="ota-entry" aria-label={translate('page.bdb9a2faeb72')}>
        <h4>{translate('page.bdb9a2faeb72')}</h4>
        <p className="field-hint">{translate('page.cee3cff2e854')}</p>
        {hasPermission(role, 'ota:read') ? (
          <div className="action-row">
            <Button type="button" data-testid="goto-ota-packages" onClick={() => onNavigate('/ota/packages')}>
              {translate('page.35ae8f161851')}
            </Button>
            <Button type="button" data-testid="goto-ota-campaigns" onClick={() => onNavigate('/ota/campaigns')}>
              {translate('page.51e6d9eba498')}
            </Button>
          </div>
        ) : (
          <p className="deny-reason" data-testid="ota-entry-deny">
            {translate('page.350bcf58b643')}
          </p>
        )}
      </section>

      <section data-testid="alias-section" aria-label={translate('page.270ec5a97320')}>
        <h4>{translate('page.270ec5a97320')}</h4>
        {aliasEditing ? (
          <div className="alias-form" data-testid="alias-form">
            <label htmlFor="alias-input">{translate('page.00029c8b5033')}</label>
            <Input
              id="alias-input"
              data-testid="alias-input"
              value={aliasDraft}
              onChange={(event) => setAliasDraft(event.target.value)}
            />
            {aliasInvalid ? (
              <p className="field-hint">
                {translate('page.16f069f04aeb') + ' '}
                {aliasLength}）
              </p>
            ) : null}
            <div className="action-row">
              <Button
                type="button"
                className="primary-button"
                data-testid="alias-save"
                disabled={busy || aliasInvalid || aliasTrimmed.length === 0}
                onClick={() =>
                  void runAction(async () => {
                    await onUpdateAlias(aliasTrimmed);
                    setAliasEditing(false);
                  }, translate('page.d3fbefdac5ea'))
                }
              >
                {translate('page.fadf24dbc5a9')}
              </Button>
              <Button
                type="button"
                data-testid="alias-clear"
                disabled={busy}
                onClick={() =>
                  void runAction(async () => {
                    await onUpdateAlias(null);
                    setAliasEditing(false);
                  }, translate('page.2fd846713a4f'))
                }
              >
                {translate('page.6b9da041716c')}
              </Button>
              <Button type="button" data-testid="alias-cancel" onClick={() => setAliasEditing(false)}>
                {translate('page.4d0b4688c787')}
              </Button>
            </div>
          </div>
        ) : (
          <div className="alias-view">
            <span data-testid="alias-current">{device.alias ?? '—'}</span>
            <Button
              type="button"
              data-testid="alias-edit"
              disabled={!aliasGate.enabled || busy}
              {...(aliasGate.reason !== null ? { title: aliasGate.reason } : {})}
              onClick={() => {
                setAliasDraft(device.alias ?? '');
                setAliasEditing(true);
              }}
            >
              {translate('page.3ea46b0c32d9')}
            </Button>
          </div>
        )}
      </section>

      <section data-testid="cert-summary" aria-label={translate('page.4b495b5f07a2')}>
        <h4>{translate('page.4b495b5f07a2')}</h4>
        {device.certificate !== null ? (
          <dl>
            <dt>{translate('page.d23c1047e613')}</dt>
            <dd data-testid="cert-id">{device.certificate.certificateId}</dd>
            <dt>{translate('page.3852a0ca8422')}</dt>
            <dd data-testid="cert-fingerprint">{device.certificate.fingerprint}</dd>
            <dt>{translate('certificate.mqttVerifiedAt')}</dt>
            <dd data-testid="cert-mqttVerifiedAt">
              {device.certificate.mqttVerifiedAt ? <TimeText iso={device.certificate.mqttVerifiedAt} /> : '—'}
            </dd>
            <dt>{translate('certificate.restVerifiedAt')}</dt>
            <dd data-testid="cert-restVerifiedAt">
              {device.certificate.restVerifiedAt ? <TimeText iso={device.certificate.restVerifiedAt} /> : '—'}
            </dd>
            <dt>{translate('certificate.rotationDeadlineAt')}</dt>
            <dd data-testid="cert-rotationDeadlineAt">
              {device.certificate.rotationDeadlineAt ? <TimeText iso={device.certificate.rotationDeadlineAt} /> : '—'}
            </dd>
            <dt>{translate('certificate.rotationConfirmedAt')}</dt>
            <dd data-testid="cert-rotationConfirmedAt">
              {device.certificate.rotationConfirmedAt ? <TimeText iso={device.certificate.rotationConfirmedAt} /> : '—'}
            </dd>

            <dt>{translate('page.62e951a692ff')}</dt>
            <dd data-testid="cert-status">
              {CERTIFICATE_STATUS_LABELS[device.certificate.status] ?? device.certificate.status}
            </dd>
          </dl>
        ) : (
          <p className="empty-state" data-testid="cert-empty">
            {translate('page.3f40287353ef')}
          </p>
        )}
        {rotation !== null ? (
          <p className="rotation-result" data-testid="rotation-result">
            {translate('page.0c47b7e799bb')}
            {rotation.requestId}
            {translate('page.d5ed0bbbb522')}
            {ROTATION_REQUEST_STATUS_LABELS[rotation.requestStatus] ?? rotation.requestStatus}
            {translate('page.99d48c052cc1') + ' '}
            {rotation.expiryDate}
            {translate('page.038d6c10a99a')}
          </p>
        ) : null}
        <Button
          type="button"
          data-testid="cert-rotate"
          disabled={!rotationGate.enabled || busy}
          {...(rotationGate.reason !== null ? { title: rotationGate.reason } : {})}
          onClick={() => void runAction(onRequestRotation, translate('page.64f4faf010d5'))}
        >
          {translate('page.c1ba7b23295a')}
        </Button>
      </section>

      {device.lifecycleStatus === 'Retired' ? (
        <section
          className="retirement-panel"
          data-testid="retirement-panel"
          aria-label={translate('page.acc3e1a08536')}
        >
          <h4>{translate('page.fd3f7462f968')}</h4>
          {retirement !== null ? (
            <>
              <dl>
                <dt>{translate('page.62e951a692ff')}</dt>
                <dd data-testid="retirement-status">{RETIREMENT_STATUS_LABELS[retirement.status]}</dd>
                <dt>{translate('page.44042ce0bc0b')}</dt>
                <dd>
                  <TimeText iso={retirement.initiatedAt} />
                </dd>
                <dt>{translate('page.1ff9c3d00112')}</dt>
                <dd>{retirement.reason}</dd>
                {retirement.completionMethod !== null ? (
                  <>
                    <dt>{translate('page.4ebbeb4ef7dc')}</dt>
                    <dd data-testid="retirement-method">
                      {COMPLETION_METHOD_LABELS[retirement.completionMethod] ?? retirement.completionMethod}
                    </dd>
                  </>
                ) : null}
                {retirement.certificateRevokedAt !== null ? (
                  <>
                    <dt>{translate('page.131d45c13e61')}</dt>
                    <dd>
                      <TimeText iso={retirement.certificateRevokedAt} />
                    </dd>
                  </>
                ) : null}
              </dl>
              {retirement.status === 'PENDING_CONFIRMATION' ? (
                <p className="retirement-waiting" data-testid="retirement-waiting">
                  {translate('page.336a1135b5c3')}
                </p>
              ) : null}
              <Button
                type="button"
                className="danger-button"
                data-testid="retire-force-complete"
                disabled={!forceGate.enabled || busy}
                {...(forceGate.reason !== null ? { title: forceGate.reason } : {})}
                onClick={() => setPendingAction('forceComplete')}
              >
                {translate('page.041739719cce')}
              </Button>
            </>
          ) : (
            <p className="retirement-unknown" data-testid="retirement-unknown">
              {translate('page.b2426c60f69f')}
            </p>
          )}
        </section>
      ) : null}

      <section data-testid="assignment-history" aria-label={translate('page.c9a07e5c1fbd')}>
        <h4>{translate('page.3ee61bf72aad')}</h4>
        {assignmentsError !== undefined ? <ErrorNotice error={assignmentsError} onRefresh={onRefresh} /> : null}
        {assignments === null ? (
          <div role="status" data-testid="assignments-loading">
            {translate('page.300ee3dee4dc')}
          </div>
        ) : assignments.length === 0 ? (
          <p className="empty-state" data-testid="assignments-empty">
            {translate('page.0db96f789d1f')}
          </p>
        ) : (
          <div
            className="table-scroll"
            role="region"
            aria-label={translate('page.c9a07e5c1fbd')}
            tabIndex={0}
            data-testid="assignment-history-scroll"
          >
            <table aria-label={translate('page.c9a07e5c1fbd')}>
              <thead>
                <tr>
                  <th scope="col">{translate('page.f20687060126')}</th>
                  <th scope="col">{translate('page.619bc67325a4')}</th>
                  <th scope="col">{translate('page.62e951a692ff')}</th>
                  <th scope="col">{translate('page.af2cdb23eed1')}</th>
                  <th scope="col">{translate('page.a0bb9f49abc5')}</th>
                  <th scope="col">{translate('page.06858dfbbcb4')}</th>
                  <th scope="col">{translate('page.1ff9c3d00112')}</th>
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
          </div>
        )}
      </section>

      <Modal
        open={assignOpen}
        title={translate('page.37326f4772d8')}
        testid="assign-dialog"
        onClose={() => setAssignOpen(false)}
      >
        <AssignForm
          customers={customers}
          sites={sites}
          currentCustomerId={device.customer?.id ?? null}
          currentSiteId={device.site?.id ?? null}
          busy={busy}
          onSubmit={(input) =>
            void runAction(async () => {
              await onAssign(input);
            }, translate('page.173f47097d59'))
          }
        />
      </Modal>

      <ConfirmDialog
        open={pendingAction === 'suspend'}
        title={translate('page.cb0f58a33c0f')}
        danger
        requireReason
        reasonLabel={translate('page.d17bba9b7631')}
        description={translate('page.3977395b600e') + device.serialNumber}
        confirmText={translate('page.ef13323b55d6')}
        onConfirm={(reason) => void runAction(() => onSuspend(reason), translate('page.546c9c47553c'))}
        onCancel={() => setPendingAction(null)}
      />
      <ConfirmDialog
        open={pendingAction === 'reactivate'}
        title={translate('page.a52000036bec')}
        requireReason
        reasonLabel={translate('page.f567e1a0848b')}
        description={translate('page.31bab33038cf') + device.serialNumber}
        confirmText={translate('page.b537457e26cc')}
        onConfirm={(reason) => void runAction(() => onReactivate(reason), translate('page.04714f3f9280'))}
        onCancel={() => setPendingAction(null)}
      />
      <ConfirmDialog
        open={pendingAction === 'retire'}
        title={translate('page.e8c560c46be1')}
        danger
        requireReason
        reasonLabel={translate('page.023f28c06231')}
        description={translate('page.1430cba69a22') + device.serialNumber}
        confirmText={translate('page.f6142648d366')}
        onConfirm={(reason) => void runAction(() => onRetire(reason), translate('page.741c15ed4519'))}
        onCancel={() => setPendingAction(null)}
      />
      <ConfirmDialog
        open={pendingAction === 'forceComplete'}
        title={translate('page.041739719cce')}
        danger
        requireReason
        reasonLabel={translate('page.9e8278dca2fe')}
        description={translate('page.1668433dcb49')}
        confirmText={translate('page.54a43c8c9b92')}
        onConfirm={(reason) => void runAction(() => onForceComplete(reason), translate('page.4bfb33fc17ba'))}
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
  readonly sites: readonly (FilterOption & {
    customerId: string;
  })[];
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
        <label htmlFor="assign-customer">{translate('page.467c1137f479')}</label>
        <select
          id="assign-customer"
          data-testid="assign-customer"
          value={customerId}
          onChange={(event) => {
            setCustomerId(event.target.value);
            setSiteId('');
          }}
        >
          <option value="">{translate('page.6bdb05d6eeeb')}</option>
          {customers.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
      </div>
      <div className="dialog-field">
        <label htmlFor="assign-site">{translate('page.b3f43665d556')}</label>
        <select
          id="assign-site"
          data-testid="assign-site"
          value={siteId}
          disabled={customerId === ''}
          onChange={(event) => setSiteId(event.target.value)}
        >
          <option value="">{translate('page.283600ae452c')}</option>
          {siteOptions.map((s) => (
            <option key={s.value} value={s.value}>
              {s.label}
            </option>
          ))}
        </select>
      </div>
      <div className="dialog-field">
        <label htmlFor="assign-reason">{translate('page.f4d149ac018b')}</label>
        <TextArea
          id="assign-reason"
          data-testid="assign-reason"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
      </div>
      <div className="dialog-actions">
        <Button
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
          {translate('page.1485e5902972')}
        </Button>
      </div>
    </div>
  );
}
