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
  | { readonly kind: 'none' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly error: unknown }
  | { readonly kind: 'ready'; readonly request: OnboardingRequestView };

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

type PendingAction = { kind: 'approve' } | { kind: 'reject' };

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
      <div className="status-tabs" role="tablist" aria-label="申请状态">
        {STATUS_TABS.map((status) => (
          <button
            key={status}
            type="button"
            role="tab"
            aria-selected={status === activeStatus}
            data-testid={`tab-${status}`}
            onClick={() => onFilterStatus(status)}
          >
            {ONBOARDING_STATUS_LABELS[status]}
          </button>
        ))}
      </div>

      <CursorTable
        ariaLabel="新增设备请求"
        columns={[
          { key: 'serialNumber', header: '设备唯一ID（序列号）', render: (r) => r.serialNumber },
          { key: 'model', header: '型号', render: (r) => r.model },
          { key: 'manufacturer', header: '厂商', render: (r) => r.manufacturer },
          {
            key: 'createdAt',
            header: '申请日期',
            render: (r) => <TimeText iso={r.createdAt} />,
          },
          {
            key: 'status',
            header: '状态',
            render: (r) => <span data-testid={`status-${r.requestId}`}>{ONBOARDING_STATUS_LABELS[r.status]}</span>,
          },
          {
            key: 'actions',
            header: '操作',
            render: (r) => (
              <button type="button" data-testid={`detail-${r.requestId}`} onClick={() => onSelect(r.requestId)}>
                详细信息
              </button>
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
        emptyText="暂无新增设备请求"
      />

      {detail.kind === 'loading' ? (
        <div role="status" data-testid="detail-loading">
          加载中…
        </div>
      ) : null}
      {detail.kind === 'error' ? <ErrorNotice error={detail.error} onRefresh={onRefresh} /> : null}

      {request !== null ? (
        <aside className="request-detail" data-testid="request-detail" aria-label="申请详情">
          <h4>设备资料</h4>
          <dl>
            <dt>设备唯一ID（序列号）</dt>
            <dd>{request.serialNumber}</dd>
            <dt>型号</dt>
            <dd>{request.model}</dd>
            <dt>硬件版本</dt>
            <dd>{request.hardwareVersion}</dd>
            <dt>厂商</dt>
            <dd>{request.manufacturer}</dd>
            <dt>生产日期</dt>
            <dd>{request.manufactureDate}</dd>
          </dl>
          <h4>申请信息</h4>
          <dl>
            <dt>申请时间</dt>
            <dd>
              <TimeText iso={request.createdAt} />
            </dd>
            <dt>录入人/来源</dt>
            <dd data-testid="detail-submitted-by">{request.submittedBy}</dd>
            <dt>证书发放状态</dt>
            <dd data-testid="detail-certificate-status">{request.certificateProvisioningStatus}</dd>
            <dt>状态</dt>
            <dd data-testid="detail-status">{ONBOARDING_STATUS_LABELS[request.status]}</dd>
            {(request.status === 'REJECTED' || request.status === 'TIMED_OUT') && request.rejectReason !== null ? (
              <>
                <dt>{request.status === 'TIMED_OUT' ? '超时原因' : '拒绝原因'}</dt>
                <dd data-testid="detail-reject-reason">{request.rejectReason}</dd>
              </>
            ) : null}
            {request.reviewedBy !== null ? (
              <>
                <dt>审批人</dt>
                <dd>{request.reviewedBy}</dd>
              </>
            ) : null}
            {request.reviewedAt !== null ? (
              <>
                <dt>审批时间</dt>
                <dd>
                  <TimeText iso={request.reviewedAt} />
                </dd>
              </>
            ) : null}
          </dl>

          {actionError !== null ? <ErrorNotice error={actionError} onRefresh={onRefresh} /> : null}

          <div className="detail-actions">
            <button type="button" onClick={onCloseDetail}>
              关闭
            </button>
            {canReview && isReviewable(request.status) ? (
              <>
                <button
                  type="button"
                  className="primary-button"
                  data-testid="approve-button"
                  disabled={busy}
                  onClick={() => setPendingAction({ kind: 'approve' })}
                >
                  批准
                </button>
                <button
                  type="button"
                  className="danger-button"
                  data-testid="reject-button"
                  disabled={busy}
                  onClick={() => setPendingAction({ kind: 'reject' })}
                >
                  拒绝
                </button>
              </>
            ) : null}
          </div>
        </aside>
      ) : null}

      <ConfirmDialog
        open={pendingAction?.kind === 'approve'}
        title="批准新增设备申请"
        {...(request !== null
          ? {
              description: `批准后将触发证书发放流程（设备自行领取证书包，页面不展示私钥），设备：${request.serialNumber}`,
            }
          : {})}
        confirmText="确认批准"
        onConfirm={() => void runAction({ kind: 'approve' }, '')}
        onCancel={() => setPendingAction(null)}
      />
      <ConfirmDialog
        open={pendingAction?.kind === 'reject'}
        title="拒绝新增设备申请"
        danger
        requireReason
        reasonLabel="拒绝原因"
        confirmText="确认拒绝"
        onConfirm={(reason) => void runAction({ kind: 'reject' }, reason)}
        onCancel={() => setPendingAction(null)}
      />
    </section>
  );
}
