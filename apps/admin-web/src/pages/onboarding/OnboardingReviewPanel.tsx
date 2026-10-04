import { Button } from '../../components/ui.js';
import { translate } from '../../i18n/i18n.js';
/**
 * FE-04 Onboarding 审批面板（原型“设备群管理 → 新增设备请求”区域，FE-06 嵌入 /devices/groups）。
 *
 * - 列表：状态筛选（待审批/已通过/已拒绝/已超时）+ 游标分页（CursorTable）；
 * - 详情：设备资料 + 申请信息（录入来源与证书发放状态来自 BE-ONB-02；不显示私钥/Token）；
 * - 审批：仅 canReview（PlatformSuperAdmin）且 PENDING 可见操作；批准→确认框；拒绝→原因必填；
 *   If-Match 并发冲突经 ErrorNotice(version-conflict) 提示刷新；提交期间按钮禁用防重复点击；
 * - 批准成功后跳转设备详情（/devices/manage?serialNumber=…），不在前端伪造设备记录；
 * - 页面不渲染任何 privateKey/Token 字段（契约已排除，测试快照为 0）。
 */
import { useRef, useState } from 'react';
import { ConfirmDialog } from '../../components/ConfirmDialog.js';
import { CursorTable } from '../../components/CursorTable.js';
import { ErrorNotice } from '../../components/ErrorNotice.js';
import { TimeText } from '../../components/TimeText.js';
import { isReviewable, ONBOARDING_STATUS_LABELS } from './onboarding-state.js';
import type { OnboardingRequestView, OnboardingStatus } from './types.js';
export type DetailState =
  | {
      readonly kind: 'none';
    }
  | {
      readonly kind: 'loading';
    }
  | {
      readonly kind: 'error';
      readonly error: unknown;
    }
  | {
      readonly kind: 'ready';
      readonly request: OnboardingRequestView;
    };
export interface OnboardingReviewPanelProps {
  readonly activeStatus: OnboardingStatus;
  readonly onFilterStatus: (status: OnboardingStatus) => void;
  readonly list: {
    readonly rows: readonly OnboardingRequestView[] | null;
    readonly loading?: boolean;
    readonly error?: unknown;
    readonly nextCursor?: string | null;
    readonly stale?: boolean;
    readonly dataUpdatedAt?: string;
    readonly hasPrevPage?: boolean;
  };
  readonly onLoadMore: (cursor: string) => void;
  readonly onLoadPrevious?: () => void;
  readonly onRefresh: () => void;
  readonly detail: DetailState;
  readonly onSelect: (requestId: string) => void;
  readonly onCloseDetail: () => void;
  /** 仅 PlatformSuperAdmin 为 true（前端隐藏按钮不替代后端授权，BE-ONB-02 强制 onboarding:approve）。 */
  readonly canReview: boolean;
  readonly onApprove: (request: OnboardingRequestView) => Promise<OnboardingRequestView>;
  readonly onReject: (request: OnboardingRequestView, reason: string) => Promise<OnboardingRequestView>;
  /** 批准成功后跳转设备详情。 */
  readonly onNavigate: (path: string) => void;
}
type PendingAction =
  | {
      kind: 'approve';
    }
  | {
      kind: 'reject';
    };
const STATUS_TABS: readonly OnboardingStatus[] = ['PENDING', 'APPROVED', 'REJECTED', 'TIMED_OUT'];
export function OnboardingReviewPanel({
  activeStatus,
  onFilterStatus,
  list,
  onLoadMore,
  onLoadPrevious,
  onRefresh,
  detail,
  onSelect,
  onCloseDetail,
  canReview,
  onApprove,
  onReject,
  onNavigate,
}: OnboardingReviewPanelProps) {
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [actionError, setActionError] = useState<unknown>(null);
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);
  const request = detail.kind === 'ready' ? detail.request : null;
  const runAction = async (action: PendingAction, reason: string) => {
    // 防重复点击：在途请求直接忽略（后端 If-Match 兜底）
    if (inFlight.current || request === null) return;
    inFlight.current = true;
    setBusy(true);
    setPendingAction(null);
    setActionError(null);
    try {
      if (action.kind === 'approve') {
        const approved = await onApprove(request);
        onNavigate(`/devices/manage?serialNumber=${encodeURIComponent(approved.serialNumber)}`);
      } else {
        await onReject(request, reason);
        onRefresh();
      }
    } catch (err) {
      setActionError(err);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };
  return (
    <section className="onboarding-review" data-testid="onboarding-review">
      <div className="status-tabs" role="tablist" aria-label={translate('page.8a6d566d7686')}>
        {STATUS_TABS.map((status) => (
          <Button
            key={status}
            type="button"
            role="tab"
            aria-selected={status === activeStatus}
            data-testid={`tab-${status}`}
            onClick={() => onFilterStatus(status)}
          >
            {ONBOARDING_STATUS_LABELS[status]}
          </Button>
        ))}
      </div>

      <CursorTable
        ariaLabel={translate('page.ac8962435f91')}
        columns={[
          { key: 'serialNumber', header: translate('page.02a7858abc0f'), render: (r) => r.serialNumber },
          { key: 'model', header: translate('page.0132ce7298ec'), render: (r) => r.model },
          { key: 'manufacturer', header: translate('page.0c131e3964eb'), render: (r) => r.manufacturer },
          {
            key: 'createdAt',
            header: translate('page.2c346345746e'),
            render: (r) => <TimeText iso={r.createdAt} />,
          },
          {
            key: 'status',
            header: translate('page.62e951a692ff'),
            render: (r) => <span data-testid={`status-${r.requestId}`}>{ONBOARDING_STATUS_LABELS[r.status]}</span>,
          },
          {
            key: 'actions',
            header: translate('page.f3ea6d345e2a'),
            render: (r) => (
              <Button type="button" data-testid={`detail-${r.requestId}`} onClick={() => onSelect(r.requestId)}>
                {translate('page.b6e664d7362f')}
              </Button>
            ),
          },
        ]}
        rows={list.rows === null ? null : [...list.rows]}
        rowKey={(r) => r.requestId}
        {...(list.loading !== undefined ? { loading: list.loading } : {})}
        {...(list.error !== undefined ? { error: list.error } : {})}
        {...(list.nextCursor !== undefined ? { nextCursor: list.nextCursor } : {})}
        {...(list.stale !== undefined ? { stale: list.stale } : {})}
        {...(list.dataUpdatedAt !== undefined ? { dataUpdatedAt: list.dataUpdatedAt } : {})}
        {...(list.hasPrevPage !== undefined ? { hasPrevPage: list.hasPrevPage } : {})}
        onNextPage={onLoadMore}
        {...(onLoadPrevious !== undefined ? { onPrevPage: onLoadPrevious } : {})}
        onRefresh={onRefresh}
        emptyText={translate('page.d7aaf21534d7')}
      />

      {detail.kind === 'loading' ? (
        <div role="status" data-testid="detail-loading">
          {translate('page.300ee3dee4dc')}
        </div>
      ) : null}
      {detail.kind === 'error' ? <ErrorNotice error={detail.error} onRefresh={onRefresh} /> : null}

      {request !== null ? (
        <aside className="request-detail" data-testid="request-detail" aria-label={translate('page.647fd881044d')}>
          <h4>{translate('page.1075726d7859')}</h4>
          <dl>
            <dt>{translate('page.02a7858abc0f')}</dt>
            <dd>{request.serialNumber}</dd>
            <dt>{translate('page.0132ce7298ec')}</dt>
            <dd>{request.model}</dd>
            <dt>{translate('page.ebc803567778')}</dt>
            <dd>{request.hardwareVersion}</dd>
            <dt>{translate('page.0c131e3964eb')}</dt>
            <dd>{request.manufacturer}</dd>
            <dt>{translate('page.8579e19406d9')}</dt>
            <dd>{request.manufactureDate}</dd>
          </dl>
          <h4>{translate('page.0822b2ec02ac')}</h4>
          <dl>
            <dt>{translate('page.e85ad6ea52fd')}</dt>
            <dd>
              <TimeText iso={request.createdAt} />
            </dd>
            <dt>{translate('page.09dd3737f0c0')}</dt>
            <dd data-testid="detail-submitted-by">{request.submittedBy}</dd>
            {request.publicKeyFingerprint ? (
              <>
                <dt>{translate('page.d35c11f5fa20')}</dt>
                <dd data-testid="detail-csr-fingerprint">{request.publicKeyFingerprint}</dd>
              </>
            ) : null}
            <dt>{translate('page.fe8993b21fdb')}</dt>
            <dd data-testid="detail-certificate-status">{request.certificateProvisioningStatus}</dd>
            <dt>{translate('page.62e951a692ff')}</dt>
            <dd data-testid="detail-status">{ONBOARDING_STATUS_LABELS[request.status]}</dd>
            {(request.status === 'REJECTED' || request.status === 'TIMED_OUT') && request.rejectReason !== null ? (
              <>
                <dt>
                  {request.status === 'TIMED_OUT' ? translate('page.ad7273034ec1') : translate('page.30cf083a31c8')}
                </dt>
                <dd data-testid="detail-reject-reason">{request.rejectReason}</dd>
              </>
            ) : null}
            {request.reviewedBy !== null ? (
              <>
                <dt>{translate('page.9b446de32478')}</dt>
                <dd>{request.reviewedBy}</dd>
              </>
            ) : null}
            {request.reviewedAt !== null ? (
              <>
                <dt>{translate('page.8df1c00436b1')}</dt>
                <dd>
                  <TimeText iso={request.reviewedAt} />
                </dd>
              </>
            ) : null}
          </dl>

          {actionError !== null ? <ErrorNotice error={actionError} onRefresh={onRefresh} /> : null}

          <div className="detail-actions">
            <Button type="button" onClick={onCloseDetail}>
              {translate('page.6c14bd7f6f9e')}
            </Button>
            {canReview && isReviewable(request.status) ? (
              <>
                <Button
                  type="button"
                  className="primary-button"
                  data-testid="approve-button"
                  disabled={busy}
                  onClick={() => setPendingAction({ kind: 'approve' })}
                >
                  {translate('page.62e26d21413f')}
                </Button>
                <Button
                  type="button"
                  className="danger-button"
                  data-testid="reject-button"
                  disabled={busy}
                  onClick={() => setPendingAction({ kind: 'reject' })}
                >
                  {translate('page.03e210a66d07')}
                </Button>
              </>
            ) : null}
          </div>
        </aside>
      ) : null}

      <ConfirmDialog
        open={pendingAction?.kind === 'approve'}
        title={translate('page.2208b8361b84')}
        {...(request !== null
          ? {
              description: translate('page.8783a79f7155') + request.serialNumber,
            }
          : {})}
        confirmText={translate('page.14399a781b56')}
        onConfirm={() => void runAction({ kind: 'approve' }, '')}
        onCancel={() => setPendingAction(null)}
      />
      <ConfirmDialog
        open={pendingAction?.kind === 'reject'}
        title={translate('page.01c92b795c11')}
        danger
        requireReason
        reasonLabel={translate('page.30cf083a31c8')}
        confirmText={translate('page.a25b138fcd8a')}
        onConfirm={(reason) => void runAction({ kind: 'reject' }, reason)}
        onCancel={() => setPendingAction(null)}
      />
    </section>
  );
}
