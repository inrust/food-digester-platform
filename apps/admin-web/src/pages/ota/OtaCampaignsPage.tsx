/**
 * FE-13 OTA Campaign 页（/ota/campaigns）：创建（VERIFIED 包 + 首批恰好 1 台灰度）、
 * 扩大批次（默认禁止全选合格设备）、暂停/恢复/取消/失败重试、目标状态看板（targetCounts）。
 *
 * - 原型“升级”（dashboard）/“同步更新”（设备管理）均跳转本页创建受控 Campaign，
 *   禁止直接向单设备推送未校验文件；
 * - 包必须 VERIFIED（坏包/未校验包不在可选列表；装配层与服务端双重拒绝）；
 * - 首批强制恰好 1 台（UI 单选 + 校验 + API 装配守卫，服务端 400 兜底）；
 * - pause/resume/cancel 幂等回放；暂停/取消后不得产生新下发（提示文案）；
 * - 失败重试：缺省重试全部 FAILED，可勾选子集（targetIds）；
 * - 功能边界：不控制设备端安装/回滚（状态由设备回报推进）。
 */
import { useRef, useState } from 'react';
import type { Role } from '@fdp/auth';
import { ConfirmDialog } from '../../components/ConfirmDialog.js';
import { CursorTable } from '../../components/CursorTable.js';
import { ErrorNotice } from '../../components/ErrorNotice.js';
import { Modal } from '../../components/Modal.js';
import { TimeText } from '../../components/TimeText.js';
import type { CampaignListFilter, OtaCampaignCreateInput, TargetListFilter } from './ota-api.js';
import {
  CAMPAIGN_ACTION_LABELS,
  CAMPAIGN_STATUS_LABELS,
  CAMPAIGN_STATUS_OPTIONS,
  PACKAGE_TYPE_LABELS,
  TARGET_STATUS_LABELS,
  TARGET_STATUS_OPTIONS,
  gateCampaignAction,
  validateBatchExpand,
  validateCampaignCreate,
} from './ota-state.js';
import type { CampaignAction } from './ota-state.js';
import type {
  FirmwarePackageView,
  OtaBatchExpandResult,
  OtaCampaignDetailView,
  OtaCampaignStatus,
  OtaCampaignView,
  OtaListState,
  OtaRetryResult,
  OtaTargetStatus,
  OtaTargetView,
} from './types.js';

export interface EligibleDeviceOption {
  readonly deviceId: string;
  readonly label: string;
}

export type CampaignDetailState =
  | { readonly kind: 'none' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly error: unknown }
  | {
      readonly kind: 'ready';
      readonly campaign: OtaCampaignDetailView;
      readonly targets: OtaListState<OtaTargetView>;
    };

export interface OtaCampaignsPageProps {
  readonly role: Role;
  readonly campaigns: OtaListState<OtaCampaignView>;
  readonly filter: CampaignListFilter;
  readonly onApplyFilter: (filter: CampaignListFilter) => void;
  readonly onLoadMore: (cursor: string) => void;
  readonly detail: CampaignDetailState;
  readonly onSelectCampaign: (campaignId: string) => void;
  readonly onCloseDetail: () => void;
  readonly onLoadMoreTargets: (cursor: string) => void;
  readonly onApplyTargetFilter: (filter: TargetListFilter) => void;
  /** 可发布（VERIFIED）包集合：创建 Campaign 的唯一可选来源（坏包/未校验包不可选）。 */
  readonly verifiedPackages: readonly FirmwarePackageView[];
  /** 合格设备（型号匹配 + Active/Maintenance + OTA_UPDATE Entitlement），由容器装配。 */
  readonly eligibleDevices: readonly EligibleDeviceOption[];
  readonly onCreateCampaign: (input: OtaCampaignCreateInput) => Promise<OtaCampaignView>;
  readonly onExpandBatch: (campaignId: string, deviceIds: readonly string[]) => Promise<OtaBatchExpandResult>;
  readonly onPause: (campaignId: string) => Promise<OtaCampaignView>;
  readonly onResume: (campaignId: string) => Promise<OtaCampaignView>;
  readonly onCancel: (campaignId: string) => Promise<OtaCampaignView>;
  /** targetIds 缺省/空 = 重试全部 FAILED。 */
  readonly onRetry: (campaignId: string, targetIds?: readonly string[]) => Promise<OtaRetryResult>;
  readonly onNavigate: (path: string) => void;
  readonly onRefresh: () => void;
}

export function OtaCampaignsPage({
  role,
  campaigns,
  filter,
  onApplyFilter,
  onLoadMore,
  detail,
  onSelectCampaign,
  onCloseDetail,
  onLoadMoreTargets,
  onApplyTargetFilter,
  verifiedPackages,
  eligibleDevices,
  onCreateCampaign,
  onExpandBatch,
  onPause,
  onResume,
  onCancel,
  onRetry,
  onNavigate,
  onRefresh,
}: OtaCampaignsPageProps) {
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState('');
  const [packageId, setPackageId] = useState('');
  const [deviceId, setDeviceId] = useState('');
  const [expandOpen, setExpandOpen] = useState(false);
  const [expandSelected, setExpandSelected] = useState<readonly string[]>([]);
  const [retryOpen, setRetryOpen] = useState(false);
  const [retrySelected, setRetrySelected] = useState<readonly string[]>([]);
  const [cancelConfirm, setCancelConfirm] = useState(false);
  const [actionError, setActionError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [draftFilter, setDraftFilter] = useState<CampaignListFilter>(filter);
  const [draftTargetStatus, setDraftTargetStatus] = useState<OtaTargetStatus | ''>('');
  const [draftBatchNo, setDraftBatchNo] = useState('');
  const inFlight = useRef(false);
  const [busy, setBusy] = useState(false);

  const readyDetail = detail.kind === 'ready' ? detail : null;
  const campaign = readyDetail?.campaign ?? null;
  const failedTargets = readyDetail?.targets.rows?.filter((t) => t.status === 'FAILED') ?? [];

  const runAction = async (execute: () => Promise<void>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setActionError(null);
    setNotice(null);
    try {
      await execute();
    } catch (err) {
      setActionError(err);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  const verifiedPackageIds = verifiedPackages.map((p) => p.packageId);
  const createError = validateCampaignCreate(
    { name, packageId, deviceIds: deviceId === '' ? [] : [deviceId] },
    verifiedPackageIds,
  );
  const expandError = validateBatchExpand(expandSelected, eligibleDevices.length);

  const submitCreate = () =>
    runAction(async () => {
      if (createError !== null) return;
      const created = await onCreateCampaign({ name: name.trim(), packageId, deviceIds: [deviceId] });
      setCreateOpen(false);
      setName('');
      setPackageId('');
      setDeviceId('');
      setNotice(
        `Campaign 已创建（${created.campaignId}，${CAMPAIGN_STATUS_LABELS[created.status]}，策略 CANARY）；首批 1 台进入灰度`,
      );
      onRefresh();
    });

  const submitExpand = () =>
    runAction(async () => {
      if (campaign === null || expandError !== null) return;
      const result = await onExpandBatch(campaign.campaignId, expandSelected);
      setExpandOpen(false);
      setExpandSelected([]);
      setNotice(
        `批次 ${result.batchNo} 已扩大：新增 ${result.addedCount} 台` +
          (result.skippedExistingCount > 0 ? `，幂等跳过已在 Campaign 的 ${result.skippedExistingCount} 台` : ''),
      );
      onRefresh();
    });

  const submitRetry = () =>
    runAction(async () => {
      if (campaign === null) return;
      const result = await onRetry(campaign.campaignId, retrySelected.length > 0 ? retrySelected : undefined);
      setRetryOpen(false);
      setRetrySelected([]);
      setNotice(`已重试 ${result.retriedCount} 个失败 target（重置为待下发，重新进入下发队列）`);
      onRefresh();
    });

  const transition = (action: 'pause' | 'resume' | 'cancel') =>
    runAction(async () => {
      if (campaign === null) return;
      const execute = action === 'pause' ? onPause : action === 'resume' ? onResume : onCancel;
      const updated = await execute(campaign.campaignId);
      const suffix =
        action === 'cancel'
          ? '；未完成 target 已级联取消，不再产生新下发'
          : action === 'pause'
            ? '；暂停后不再产生新下发'
            : '';
      setNotice(
        `${CAMPAIGN_ACTION_LABELS[action]}成功（幂等回放），当前状态：${CAMPAIGN_STATUS_LABELS[updated.status]}${suffix}`,
      );
      onRefresh();
    });

  const actionButton = (action: CampaignAction, onClick: () => void, testid: string) => {
    if (campaign === null) return null;
    const gate = gateCampaignAction(action, campaign.status, role);
    return (
      <span key={action} className="action-item">
        <button
          type="button"
          data-testid={testid}
          disabled={!gate.allowed || busy}
          {...(gate.reason !== null ? { title: gate.reason } : {})}
          onClick={onClick}
        >
          {CAMPAIGN_ACTION_LABELS[action]}
        </button>
        {!gate.allowed && gate.reason !== null ? (
          <span className="deny-reason" data-testid={`${testid}-deny`}>
            {gate.reason}
          </span>
        ) : null}
      </span>
    );
  };

  return (
    <div className="ota-campaigns-page" data-testid="ota-campaigns-page">
      <div className="page-header">
        <h3>OTA 升级</h3>
        <button type="button" data-testid="goto-ota-packages" onClick={() => onNavigate('/ota/packages')}>
          固件包管理
        </button>
      </div>

      <section data-testid="campaign-create-section" aria-label="创建 Campaign">
        <h4>创建 Campaign（灰度）</h4>
        <p className="field-hint">
          仅可发布（VERIFIED）包可创建；首批强制恰好 1 台灰度，验证后经“扩大批次”逐步放量（禁止全量强制升级）。
        </p>
        <button
          type="button"
          className="primary-button"
          data-testid="campaign-create-open"
          disabled={busy || verifiedPackages.length === 0 || eligibleDevices.length === 0}
          {...(verifiedPackages.length === 0 ? { title: '暂无可发布（VERIFIED）包' } : {})}
          {...(verifiedPackages.length > 0 && eligibleDevices.length === 0 ? { title: '暂无合格设备' } : {})}
          onClick={() => {
            setCreateOpen(true);
            setActionError(null);
          }}
        >
          创建 Campaign
        </button>
        {verifiedPackages.length === 0 ? (
          <span className="deny-reason" data-testid="create-no-package">
            暂无可发布（VERIFIED）包，请先在固件包管理完成上传校验
          </span>
        ) : null}
      </section>

      {notice !== null ? (
        <p className="action-notice" role="status" data-testid="action-notice">
          {notice}
        </p>
      ) : null}
      {actionError !== null ? <ErrorNotice error={actionError} onRefresh={onRefresh} /> : null}

      <Modal
        open={createOpen}
        title="创建 OTA Campaign"
        testid="campaign-create-form"
        onClose={() => setCreateOpen(false)}
      >
        <div className="dialog-field">
          <label htmlFor="campaign-name">名称（≤128 字符）</label>
          <input
            id="campaign-name"
            data-testid="campaign-name"
            maxLength={128}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <div className="dialog-field">
          <label htmlFor="campaign-package">固件包（仅可发布 VERIFIED）</label>
          <select
            id="campaign-package"
            data-testid="campaign-package"
            value={packageId}
            onChange={(event) => setPackageId(event.target.value)}
          >
            <option value="">请选择</option>
            {verifiedPackages.map((p) => (
              <option key={p.packageId} value={p.packageId}>
                {p.model} {p.version}（{PACKAGE_TYPE_LABELS[p.packageType]}）
              </option>
            ))}
          </select>
        </div>
        <div className="dialog-field">
          <label htmlFor="campaign-device">首批灰度设备（恰好 1 台）</label>
          <select
            id="campaign-device"
            data-testid="campaign-device"
            value={deviceId}
            onChange={(event) => setDeviceId(event.target.value)}
          >
            <option value="">请选择</option>
            {eligibleDevices.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label}
              </option>
            ))}
          </select>
          <p className="field-hint">首批恰好 1 台（灰度）；超过 1 台将被前端阻止且服务端拒绝（400）。</p>
        </div>
        {createError !== null ? (
          <p className="field-hint" data-testid="campaign-create-error">
            {createError}
          </p>
        ) : null}
        <div className="dialog-actions">
          <button
            type="button"
            className="primary-button"
            data-testid="campaign-create-submit"
            disabled={busy || createError !== null}
            onClick={() => void submitCreate()}
          >
            创建（首批 1 台灰度）
          </button>
        </div>
      </Modal>

      <section data-testid="campaign-list-section" aria-label="Campaign 列表">
        <h4>Campaign 列表</h4>
        <div className="filter-bar">
          <label htmlFor="campaign-filter-status">状态</label>
          <select
            id="campaign-filter-status"
            data-testid="campaign-filter-status"
            value={draftFilter.status ?? ''}
            onChange={(event) =>
              setDraftFilter({
                ...draftFilter,
                status: event.target.value === '' ? null : (event.target.value as OtaCampaignStatus),
              })
            }
          >
            <option value="">全部</option>
            {CAMPAIGN_STATUS_OPTIONS.map((status) => (
              <option key={status} value={status}>
                {CAMPAIGN_STATUS_LABELS[status]}
              </option>
            ))}
          </select>
          <label htmlFor="campaign-filter-model">目标型号</label>
          <input
            id="campaign-filter-model"
            data-testid="campaign-filter-model"
            value={draftFilter.targetModel ?? ''}
            onChange={(event) => setDraftFilter({ ...draftFilter, targetModel: event.target.value })}
          />
          <button
            type="button"
            className="primary-button"
            data-testid="campaign-filter-search"
            onClick={() => onApplyFilter(draftFilter)}
          >
            筛选
          </button>
        </div>
        <CursorTable
          ariaLabel="Campaign 列表"
          columns={[
            { key: 'name', header: '名称', render: (c) => c.name },
            { key: 'targetModel', header: '目标型号', render: (c) => c.targetModel },
            { key: 'packageId', header: '包', render: (c) => c.packageId },
            { key: 'strategy', header: '策略', render: (c) => c.strategy },
            { key: 'status', header: '状态', render: (c) => CAMPAIGN_STATUS_LABELS[c.status] },
            { key: 'createdBy', header: '创建人', render: (c) => c.createdBy },
            { key: 'createdAt', header: '创建时间', render: (c) => <TimeText iso={c.createdAt} /> },
            {
              key: 'actions',
              header: '操作',
              render: (c) => (
                <button
                  type="button"
                  data-testid={`campaign-detail-${c.campaignId}`}
                  onClick={() => onSelectCampaign(c.campaignId)}
                >
                  详情
                </button>
              ),
            },
          ]}
          rows={campaigns.rows === null ? null : [...campaigns.rows]}
          rowKey={(c) => c.campaignId}
          {...(campaigns.loading !== undefined ? { loading: campaigns.loading } : {})}
          {...(campaigns.error !== undefined ? { error: campaigns.error } : {})}
          {...(campaigns.nextCursor !== undefined ? { nextCursor: campaigns.nextCursor } : {})}
          onNextPage={onLoadMore}
          onRefresh={onRefresh}
          emptyText="暂无 Campaign"
        />
      </section>

      {detail.kind === 'loading' ? (
        <div role="status" data-testid="campaign-detail-loading">
          加载中…
        </div>
      ) : null}
      {detail.kind === 'error' ? <ErrorNotice error={detail.error} onRefresh={onRefresh} /> : null}

      {campaign !== null && readyDetail !== null ? (
        <aside className="campaign-detail" data-testid="campaign-detail" aria-label="Campaign 详情">
          <h4>
            {campaign.name}
            <span className="campaign-status" data-testid="campaign-detail-status">
              {CAMPAIGN_STATUS_LABELS[campaign.status]}
            </span>
          </h4>
          <dl>
            <dt>Campaign</dt>
            <dd>{campaign.campaignId}</dd>
            <dt>目标型号 / 包</dt>
            <dd>
              {campaign.targetModel} / {campaign.packageId}
            </dd>
            <dt>策略</dt>
            <dd>{campaign.strategy}（灰度；禁止默认全量强制升级）</dd>
            <dt>创建人 / 时间</dt>
            <dd>
              {campaign.createdBy} / <TimeText iso={campaign.createdAt} />
            </dd>
          </dl>

          <div className="action-row" data-testid="campaign-actions">
            {actionButton('pause', () => void transition('pause'), 'campaign-action-pause')}
            {actionButton('resume', () => void transition('resume'), 'campaign-action-resume')}
            {actionButton(
              'expand',
              () => {
                setExpandSelected([]);
                setExpandOpen(true);
              },
              'campaign-action-expand',
            )}
            {actionButton(
              'retry',
              () => {
                setRetrySelected([]);
                setRetryOpen(true);
              },
              'campaign-action-retry',
            )}
            {actionButton('cancel', () => setCancelConfirm(true), 'campaign-action-cancel')}
          </div>

          <section data-testid="target-counts" aria-label="目标状态看板">
            <h5>目标状态看板</h5>
            <ul className="target-count-board">
              <li data-testid="count-total">总计 {campaign.targetCounts.total}</li>
              {TARGET_STATUS_OPTIONS.map((status) => (
                <li key={status} data-testid={`count-${status}`}>
                  {TARGET_STATUS_LABELS[status]} {campaign.targetCounts[status]}
                </li>
              ))}
            </ul>
            <p className="field-hint">
              失败 target 可经“失败重试”重置为待下发；按设备的失败原因明细需契约补充（当前可经告警与事件页追溯）。
            </p>
          </section>

          <section data-testid="target-list-section" aria-label="目标列表">
            <h5>目标列表</h5>
            <div className="filter-bar">
              <label htmlFor="target-filter-status">状态</label>
              <select
                id="target-filter-status"
                data-testid="target-filter-status"
                value={draftTargetStatus}
                onChange={(event) =>
                  setDraftTargetStatus(event.target.value === '' ? '' : (event.target.value as OtaTargetStatus))
                }
              >
                <option value="">全部</option>
                {TARGET_STATUS_OPTIONS.map((status) => (
                  <option key={status} value={status}>
                    {TARGET_STATUS_LABELS[status]}
                  </option>
                ))}
              </select>
              <label htmlFor="target-filter-batch">批次号</label>
              <input
                id="target-filter-batch"
                data-testid="target-filter-batch"
                inputMode="numeric"
                value={draftBatchNo}
                onChange={(event) => setDraftBatchNo(event.target.value)}
              />
              <button
                type="button"
                className="primary-button"
                data-testid="target-filter-search"
                onClick={() => {
                  const batchNo = Number(draftBatchNo);
                  onApplyTargetFilter({
                    status: draftTargetStatus === '' ? null : draftTargetStatus,
                    batchNo: Number.isInteger(batchNo) && batchNo >= 1 ? batchNo : null,
                  });
                }}
              >
                筛选
              </button>
            </div>
            <CursorTable
              ariaLabel="目标列表"
              columns={[
                { key: 'deviceId', header: '设备', render: (t) => t.deviceId },
                { key: 'batchNo', header: '批次', render: (t) => (t.batchNo === 1 ? '1（灰度）' : String(t.batchNo)) },
                { key: 'status', header: '状态', render: (t) => TARGET_STATUS_LABELS[t.status] },
                {
                  key: 'scheduledTime',
                  header: '计划时间',
                  render: (t) => (t.scheduledTime !== null ? <TimeText iso={t.scheduledTime} /> : '—'),
                },
                {
                  key: 'completedAt',
                  header: '完成时间',
                  render: (t) => (t.completedAt !== null ? <TimeText iso={t.completedAt} /> : '—'),
                },
                { key: 'updatedAt', header: '更新时间', render: (t) => <TimeText iso={t.updatedAt} /> },
              ]}
              rows={readyDetail.targets.rows === null ? null : [...readyDetail.targets.rows]}
              rowKey={(t) => t.targetId}
              {...(readyDetail.targets.loading !== undefined ? { loading: readyDetail.targets.loading } : {})}
              {...(readyDetail.targets.error !== undefined ? { error: readyDetail.targets.error } : {})}
              {...(readyDetail.targets.nextCursor !== undefined ? { nextCursor: readyDetail.targets.nextCursor } : {})}
              onNextPage={onLoadMoreTargets}
              onRefresh={onRefresh}
              emptyText="暂无目标"
            />
          </section>

          <button type="button" data-testid="campaign-detail-close" onClick={onCloseDetail}>
            关闭
          </button>
        </aside>
      ) : null}

      <Modal open={expandOpen} title="扩大批次" testid="campaign-expand-form" onClose={() => setExpandOpen(false)}>
        {campaign !== null ? (
          <div>
            <p className="field-hint">
              合格设备 {eligibleDevices.length} 台；默认禁止一次选择全部合格设备（保留灰度余量）； 已在 Campaign
              的设备由服务端幂等跳过。
            </p>
            <ul className="device-check-list" data-testid="expand-device-list">
              {eligibleDevices.map((d) => (
                <li key={d.deviceId}>
                  <label>
                    <input
                      type="checkbox"
                      data-testid={`expand-device-${d.deviceId}`}
                      checked={expandSelected.includes(d.deviceId)}
                      onChange={(event) =>
                        setExpandSelected(
                          event.target.checked
                            ? [...expandSelected, d.deviceId]
                            : expandSelected.filter((id) => id !== d.deviceId),
                        )
                      }
                    />
                    {d.label}
                  </label>
                </li>
              ))}
            </ul>
            {expandError !== null ? (
              <p className="field-hint" data-testid="expand-error">
                {expandError}
              </p>
            ) : null}
            <div className="dialog-actions">
              <button
                type="button"
                className="primary-button"
                data-testid="expand-submit"
                disabled={busy || expandError !== null}
                onClick={() => void submitExpand()}
              >
                扩大批次（{expandSelected.length} 台）
              </button>
            </div>
          </div>
        ) : null}
      </Modal>

      <Modal open={retryOpen} title="失败重试" testid="campaign-retry-form" onClose={() => setRetryOpen(false)}>
        {campaign !== null ? (
          <div>
            {failedTargets.length === 0 ? (
              <p className="empty-state" data-testid="retry-empty">
                当前列表无失败 target
              </p>
            ) : (
              <>
                <p className="field-hint">不勾选任何项 = 重试 Campaign 全部失败 target；勾选则仅重试选中子集。</p>
                <ul className="device-check-list" data-testid="retry-target-list">
                  {failedTargets.map((t) => (
                    <li key={t.targetId}>
                      <label>
                        <input
                          type="checkbox"
                          data-testid={`retry-target-${t.targetId}`}
                          checked={retrySelected.includes(t.targetId)}
                          onChange={(event) =>
                            setRetrySelected(
                              event.target.checked
                                ? [...retrySelected, t.targetId]
                                : retrySelected.filter((id) => id !== t.targetId),
                            )
                          }
                        />
                        {t.deviceId}（批次 {t.batchNo}）
                      </label>
                    </li>
                  ))}
                </ul>
              </>
            )}
            <div className="dialog-actions">
              <button
                type="button"
                className="primary-button"
                data-testid="retry-submit"
                disabled={busy || failedTargets.length === 0}
                onClick={() => void submitRetry()}
              >
                重试{retrySelected.length > 0 ? `选中 ${retrySelected.length} 项` : '全部失败 target'}
              </button>
            </div>
          </div>
        ) : null}
      </Modal>

      <ConfirmDialog
        open={cancelConfirm}
        title="取消 Campaign"
        description="取消后未完成 target 将级联取消，不再产生新下发（幂等回放）。"
        danger
        confirmText="确认取消"
        onConfirm={() => {
          setCancelConfirm(false);
          void transition('cancel');
        }}
        onCancel={() => setCancelConfirm(false)}
      />
    </div>
  );
}
