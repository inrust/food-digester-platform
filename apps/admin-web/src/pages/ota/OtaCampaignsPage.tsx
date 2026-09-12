import { translate } from '../../i18n/i18n.js';
/**
 * FE-13 OTA Campaign 页（/ota/campaigns）：创建（VERIFIED 包 + 首批恰好 1 台灰度）、
 * 扩大批次（最终全量需 SuperAdmin 显式审批）、暂停/恢复/取消/失败重试、目标状态看板（targetCounts）。
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
import type { Role } from '@fdp/auth/browser';
import { ConfirmDialog } from '../../components/ConfirmDialog.js';
import { CursorTable } from '../../components/CursorTable.js';
import { ErrorNotice } from '../../components/ErrorNotice.js';
import { Modal } from '../../components/Modal.js';
import { NumberText } from '../../components/LocaleValue.js';
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
  readonly onExpandBatch: (
    campaignId: string,
    deviceIds: readonly string[],
    finalRolloutApproval?: {
      readonly confirmText: string;
    },
  ) => Promise<OtaBatchExpandResult>;
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
  const [finalRolloutConfirmText, setFinalRolloutConfirmText] = useState('');
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
  const isFinalRollout = eligibleDevices.length > 0 && expandSelected.length >= eligibleDevices.length;
  const expectedFinalRolloutText = campaign === null ? '' : `APPROVE_FINAL_ROLLOUT:${campaign.campaignId}`;
  const expandError =
    validateBatchExpand(expandSelected) ??
    (isFinalRollout && role !== 'PlatformSuperAdmin'
      ? translate('page.f444f6d564b9')
      : isFinalRollout &&
          (campaign === null ||
            campaign.targetCounts.total === 0 ||
            campaign.targetCounts.SUCCEEDED !== campaign.targetCounts.total)
        ? translate('page.ff400c24b8e4')
        : isFinalRollout && finalRolloutConfirmText !== expectedFinalRolloutText
          ? translate('page.601816e17037') + ' ' + expectedFinalRolloutText + (' ' + translate('page.7eaf7f83eb09'))
          : null);
  const submitCreate = () =>
    runAction(async () => {
      if (createError !== null) return;
      const created = await onCreateCampaign({ name: name.trim(), packageId, deviceIds: [deviceId] });
      setCreateOpen(false);
      setName('');
      setPackageId('');
      setDeviceId('');
      setNotice(
        translate('page.80256f1595ad') +
          created.campaignId +
          '\uFF0C' +
          CAMPAIGN_STATUS_LABELS[created.status] +
          translate('page.2143994cca67'),
      );
      onRefresh();
    });
  const submitExpand = () =>
    runAction(async () => {
      if (campaign === null || expandError !== null) return;
      const result = await onExpandBatch(
        campaign.campaignId,
        expandSelected,
        isFinalRollout ? { confirmText: finalRolloutConfirmText } : undefined,
      );
      setExpandOpen(false);
      setExpandSelected([]);
      setFinalRolloutConfirmText('');
      setNotice(
        translate('page.6b2cf249edf5') +
          ' ' +
          result.batchNo +
          (' ' + translate('page.732ce0646c5b') + ' ') +
          result.addedCount +
          (' ' + translate('page.dda4f85fa0dc')) +
          (result.skippedExistingCount > 0
            ? translate('page.c1d10fa996c3') +
              ' ' +
              result.skippedExistingCount +
              (' ' + translate('page.dda4f85fa0dc'))
            : '') +
          (result.finalRolloutApproved
            ? translate('page.86baefe54282') +
              ' ' +
              (result.approvedBy ?? 'SuperAdmin') +
              (' ' + translate('page.5ce60cb75d20'))
            : ''),
      );
      onRefresh();
    });
  const submitRetry = () =>
    runAction(async () => {
      if (campaign === null) return;
      const result = await onRetry(campaign.campaignId, retrySelected.length > 0 ? retrySelected : undefined);
      setRetryOpen(false);
      setRetrySelected([]);
      setNotice(translate('page.a3477f849226') + ' ' + result.retriedCount + (' ' + translate('page.232f482b8538')));
      onRefresh();
    });
  const transition = (action: 'pause' | 'resume' | 'cancel') =>
    runAction(async () => {
      if (campaign === null) return;
      const execute = action === 'pause' ? onPause : action === 'resume' ? onResume : onCancel;
      const updated = await execute(campaign.campaignId);
      const suffix =
        action === 'cancel' ? translate('page.73a3c9a8c56a') : action === 'pause' ? translate('page.ed138b6a6670') : '';
      setNotice(
        CAMPAIGN_ACTION_LABELS[action] +
          translate('page.11db568919cb') +
          CAMPAIGN_STATUS_LABELS[updated.status] +
          suffix,
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
        <h3>{translate('page.bdb9a2faeb72')}</h3>
        <button type="button" data-testid="goto-ota-packages" onClick={() => onNavigate('/ota/packages')}>
          {translate('page.520fc0679572')}
        </button>
      </div>

      <section data-testid="campaign-create-section" aria-label={translate('page.7a06c0b187b6')}>
        <h4>{translate('page.9d4b6023d061')}</h4>
        <p className="field-hint">{translate('page.fec04f09d673')}</p>
        <button
          type="button"
          className="primary-button"
          data-testid="campaign-create-open"
          disabled={busy || verifiedPackages.length === 0 || eligibleDevices.length === 0}
          {...(verifiedPackages.length === 0 ? { title: translate('page.469b23266823') } : {})}
          {...(verifiedPackages.length > 0 && eligibleDevices.length === 0
            ? { title: translate('page.231330ea235d') }
            : {})}
          onClick={() => {
            setCreateOpen(true);
            setActionError(null);
          }}
        >
          {translate('page.7a06c0b187b6')}
        </button>
        {verifiedPackages.length === 0 ? (
          <span className="deny-reason" data-testid="create-no-package">
            {translate('page.0c74f236f25a')}
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
        title={translate('page.fc6591c3267f')}
        testid="campaign-create-form"
        onClose={() => setCreateOpen(false)}
      >
        <div className="dialog-field">
          <label htmlFor="campaign-name">{translate('page.eb465cfa598b')}</label>
          <input
            id="campaign-name"
            data-testid="campaign-name"
            maxLength={128}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <div className="dialog-field">
          <label htmlFor="campaign-package">{translate('page.e0bc4ef9d479')}</label>
          <select
            id="campaign-package"
            data-testid="campaign-package"
            value={packageId}
            onChange={(event) => setPackageId(event.target.value)}
          >
            <option value="">{translate('page.382f4b5559b3')}</option>
            {verifiedPackages.map((p) => (
              <option key={p.packageId} value={p.packageId}>
                {p.model} {p.version}（{PACKAGE_TYPE_LABELS[p.packageType]}）
              </option>
            ))}
          </select>
        </div>
        <div className="dialog-field">
          <label htmlFor="campaign-device">{translate('page.d971bbe039b1')}</label>
          <select
            id="campaign-device"
            data-testid="campaign-device"
            value={deviceId}
            onChange={(event) => setDeviceId(event.target.value)}
          >
            <option value="">{translate('page.382f4b5559b3')}</option>
            {eligibleDevices.map((d) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label}
              </option>
            ))}
          </select>
          <p className="field-hint">{translate('page.573b7667dd69')}</p>
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
            {translate('page.0255d0eb6e95')}
          </button>
        </div>
      </Modal>

      <section data-testid="campaign-list-section" aria-label={translate('page.561c14751c14')}>
        <h4>{translate('page.561c14751c14')}</h4>
        <div className="filter-bar">
          <label htmlFor="campaign-filter-status">{translate('page.62e951a692ff')}</label>
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
            <option value="">{translate('page.778fc8f99453')}</option>
            {CAMPAIGN_STATUS_OPTIONS.map((status) => (
              <option key={status} value={status}>
                {CAMPAIGN_STATUS_LABELS[status]}
              </option>
            ))}
          </select>
          <label htmlFor="campaign-filter-model">{translate('page.418dfc356a6d')}</label>
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
            {translate('page.dcce9a144a40')}
          </button>
        </div>
        <CursorTable
          ariaLabel={translate('page.561c14751c14')}
          columns={[
            { key: 'name', header: translate('page.1be7ae4fc257'), render: (c) => c.name },
            { key: 'targetModel', header: translate('page.418dfc356a6d'), render: (c) => c.targetModel },
            { key: 'packageId', header: translate('page.7e396634c6ce'), render: (c) => c.packageId },
            { key: 'strategy', header: translate('page.f3c49831c636'), render: (c) => c.strategy },
            { key: 'status', header: translate('page.62e951a692ff'), render: (c) => CAMPAIGN_STATUS_LABELS[c.status] },
            { key: 'createdBy', header: translate('page.787ad1deae49'), render: (c) => c.createdBy },
            { key: 'createdAt', header: translate('page.84e3802f60a7'), render: (c) => <TimeText iso={c.createdAt} /> },
            {
              key: 'actions',
              header: translate('page.f3ea6d345e2a'),
              render: (c) => (
                <button
                  type="button"
                  data-testid={`campaign-detail-${c.campaignId}`}
                  onClick={() => onSelectCampaign(c.campaignId)}
                >
                  {translate('page.4f55ee1e687f')}
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
          emptyText={translate('page.73d70701aa57')}
        />
      </section>

      {detail.kind === 'loading' ? (
        <div role="status" data-testid="campaign-detail-loading">
          {translate('page.300ee3dee4dc')}
        </div>
      ) : null}
      {detail.kind === 'error' ? <ErrorNotice error={detail.error} onRefresh={onRefresh} /> : null}

      {campaign !== null && readyDetail !== null ? (
        <aside className="campaign-detail" data-testid="campaign-detail" aria-label={translate('page.013e5baba559')}>
          <h4>
            {campaign.name}
            <span className="campaign-status" data-testid="campaign-detail-status">
              {CAMPAIGN_STATUS_LABELS[campaign.status]}
            </span>
          </h4>
          <dl>
            <dt>Campaign</dt>
            <dd>{campaign.campaignId}</dd>
            <dt>{translate('page.d21541e46da5')}</dt>
            <dd>
              {campaign.targetModel} / {campaign.packageId}
            </dd>
            <dt>{translate('page.f3c49831c636')}</dt>
            <dd>
              {campaign.strategy}
              {translate('page.50e2bd94f3f9')}
            </dd>
            <dt>{translate('page.f4d51aaca4f0')}</dt>
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
                setFinalRolloutConfirmText('');
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

          <section data-testid="target-counts" aria-label={translate('page.c1805c3cfa68')}>
            <h5>{translate('page.c1805c3cfa68')}</h5>
            <ul className="target-count-board">
              <li data-testid="count-total">
                {translate('page.3af1ac5b4efe') + ' '}
                <NumberText value={campaign.targetCounts.total} />
              </li>
              {TARGET_STATUS_OPTIONS.map((status) => (
                <li key={status} data-testid={`count-${status}`}>
                  {TARGET_STATUS_LABELS[status]} <NumberText value={campaign.targetCounts[status]} />
                </li>
              ))}
            </ul>
            <p className="field-hint">{translate('page.956e69169055')}</p>
          </section>

          <section data-testid="target-list-section" aria-label={translate('page.ee3cdd7dc748')}>
            <h5>{translate('page.ee3cdd7dc748')}</h5>
            <div className="filter-bar">
              <label htmlFor="target-filter-status">{translate('page.62e951a692ff')}</label>
              <select
                id="target-filter-status"
                data-testid="target-filter-status"
                value={draftTargetStatus}
                onChange={(event) =>
                  setDraftTargetStatus(event.target.value === '' ? '' : (event.target.value as OtaTargetStatus))
                }
              >
                <option value="">{translate('page.778fc8f99453')}</option>
                {TARGET_STATUS_OPTIONS.map((status) => (
                  <option key={status} value={status}>
                    {TARGET_STATUS_LABELS[status]}
                  </option>
                ))}
              </select>
              <label htmlFor="target-filter-batch">{translate('page.2514034a3d8a')}</label>
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
                {translate('page.dcce9a144a40')}
              </button>
            </div>
            <CursorTable
              ariaLabel={translate('page.ee3cdd7dc748')}
              columns={[
                { key: 'deviceId', header: translate('page.01f2c16cda65'), render: (t) => t.deviceId },
                {
                  key: 'batchNo',
                  header: translate('page.6b2cf249edf5'),
                  render: (t) => (t.batchNo === 1 ? translate('page.00ff953569d7') : <NumberText value={t.batchNo} />),
                },
                {
                  key: 'status',
                  header: translate('page.62e951a692ff'),
                  render: (t) => TARGET_STATUS_LABELS[t.status],
                },
                {
                  key: 'failure',
                  header: translate('page.918468e7557e'),
                  render: (t) =>
                    t.status === 'FAILED'
                      ? (t.failureCode ?? 'OTA_FAILED') + '\uFF1A' + (t.failureReason ?? translate('page.33306ae06ed2'))
                      : '—',
                },
                {
                  key: 'scheduledTime',
                  header: translate('page.be81ea32b445'),
                  render: (t) => (t.scheduledTime !== null ? <TimeText iso={t.scheduledTime} /> : '—'),
                },
                {
                  key: 'completedAt',
                  header: translate('page.754a8a2e2dba'),
                  render: (t) => (t.completedAt !== null ? <TimeText iso={t.completedAt} /> : '—'),
                },
                {
                  key: 'updatedAt',
                  header: translate('page.093dea88c930'),
                  render: (t) => <TimeText iso={t.updatedAt} />,
                },
              ]}
              rows={readyDetail.targets.rows === null ? null : [...readyDetail.targets.rows]}
              rowKey={(t) => t.targetId}
              {...(readyDetail.targets.loading !== undefined ? { loading: readyDetail.targets.loading } : {})}
              {...(readyDetail.targets.error !== undefined ? { error: readyDetail.targets.error } : {})}
              {...(readyDetail.targets.nextCursor !== undefined ? { nextCursor: readyDetail.targets.nextCursor } : {})}
              onNextPage={onLoadMoreTargets}
              onRefresh={onRefresh}
              emptyText={translate('page.8476f0e11ec2')}
            />
          </section>

          <button type="button" data-testid="campaign-detail-close" onClick={onCloseDetail}>
            {translate('page.6c14bd7f6f9e')}
          </button>
        </aside>
      ) : null}

      <Modal
        open={expandOpen}
        title={translate('page.0d6084de32a0')}
        testid="campaign-expand-form"
        onClose={() => {
          setExpandOpen(false);
          setFinalRolloutConfirmText('');
        }}
      >
        {campaign !== null ? (
          <div>
            <p className="field-hint">
              {translate('page.f2de38ce26f1') + ' '}
              <NumberText value={eligibleDevices.length} />
              {' ' + translate('page.3592d5501c07')}
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
            {isFinalRollout ? (
              <label>
                {translate('page.c54f84d0d887')}
                <input
                  data-testid="final-rollout-confirm"
                  value={finalRolloutConfirmText}
                  placeholder={expectedFinalRolloutText}
                  onChange={(event) => setFinalRolloutConfirmText(event.target.value)}
                />
              </label>
            ) : null}
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
                {translate('page.b4a1dbe7c6be')}
                <NumberText value={expandSelected.length} />
                {' ' + translate('page.57151561028f')}
              </button>
            </div>
          </div>
        ) : null}
      </Modal>

      <Modal
        open={retryOpen}
        title={translate('page.794ff5f0462b')}
        testid="campaign-retry-form"
        onClose={() => setRetryOpen(false)}
      >
        {campaign !== null ? (
          <div>
            {failedTargets.length === 0 ? (
              <p className="empty-state" data-testid="retry-empty">
                {translate('page.c767ec9df263')}
              </p>
            ) : (
              <>
                <p className="field-hint">{translate('page.b79f45392bde')}</p>
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
                        {t.deviceId}
                        {translate('page.d9182c87f366') + ' '}
                        <NumberText value={t.batchNo} />）
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
                {translate('page.e2d53a6d3a6a')}
                {retrySelected.length > 0
                  ? translate('page.a85b0e899cbf') + ' ' + retrySelected.length + (' ' + translate('page.64728a772742'))
                  : translate('page.6e0a3cd678cb')}
              </button>
            </div>
          </div>
        ) : null}
      </Modal>

      <ConfirmDialog
        open={cancelConfirm}
        title={translate('page.dd15d73993f8')}
        description={translate('page.06aec8093202')}
        danger
        confirmText={translate('page.c9cbe84e862b')}
        onConfirm={() => {
          setCancelConfirm(false);
          void transition('cancel');
        }}
        onCancel={() => setCancelConfirm(false)}
      />
    </div>
  );
}
