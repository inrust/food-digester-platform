/**
 * FE-17 Contract 列表页（/contracts）：客户/状态筛选、确定性设备计数、
 * 服务期限与派生状态展示；新建/详情导航。
 *
 * - 客户列：Contract 仅含 customerId，名称从 Customer 目录按 ID 解析（未解析显示 ID）；
 * - 设备数量：容器经 listContractDevices 确定性计数注入（不使用硬编码值；未知显示 —）；
 * - 状态列：查询时点派生状态（DEC-007：合约状态标签，与 License 授权状态区分）；
 * - contract:write 仅 PlatformSuperAdmin（新建按钮按权限禁用）。
 */
import { useState } from 'react';
import type { Role } from '@fdp/auth';
import { CursorTable } from '../../components/CursorTable.js';
import {
  CONTRACT_STATUS_LABELS,
  CONTRACT_STATUS_OPTIONS,
  canWriteContracts,
  formatServicePeriod,
} from './contract-state.js';
import type { ContractListFilter } from './contracts-api.js';
import type { ContractListState, ContractStatus, ContractView } from './types.js';

export interface CustomerOption {
  readonly customerId: string;
  readonly name: string;
}

export interface ContractsPageProps {
  readonly role: Role;
  readonly contracts: ContractListState;
  readonly filter: ContractListFilter;
  readonly onApplyFilter: (filter: ContractListFilter) => void;
  readonly customerOptions: readonly CustomerOption[];
  /** 设备计数（容器经 listContractDevices 确定性计数；缺省显示 —）。 */
  readonly deviceCounts?: Readonly<Record<string, number>>;
  readonly onOpenNew: () => void;
  readonly onOpenDetail: (contractId: string) => void;
  readonly onRefresh: () => void;
}

export function resolveCustomerName(customerOptions: readonly CustomerOption[], customerId: string): string {
  return customerOptions.find((c) => c.customerId === customerId)?.name ?? customerId;
}

export function ContractsPage({
  role,
  contracts,
  filter,
  onApplyFilter,
  customerOptions,
  deviceCounts,
  onOpenNew,
  onOpenDetail,
  onRefresh,
}: ContractsPageProps) {
  const [draft, setDraft] = useState<{ status: ContractStatus | ''; customerId: string }>({
    status: filter.status ?? '',
    customerId: filter.customerId ?? '',
  });
  const canWrite = canWriteContracts(role);

  return (
    <div className="contracts-page" data-testid="contracts-page">
      <div className="page-header">
        <h3>合约查询及修改</h3>
        <button
          type="button"
          className="primary-button"
          data-testid="contract-new-open"
          disabled={!canWrite}
          {...(!canWrite ? { title: '需要合约写权限（contract:write：仅平台管理员）' } : {})}
          onClick={onOpenNew}
        >
          新建合约
        </button>
      </div>

      <div className="filter-bar">
        <label htmlFor="contract-filter-status">状态</label>
        <select
          id="contract-filter-status"
          data-testid="contract-filter-status"
          value={draft.status}
          onChange={(event) =>
            setDraft({ ...draft, status: event.target.value === '' ? '' : (event.target.value as ContractStatus) })
          }
        >
          <option value="">全部</option>
          {CONTRACT_STATUS_OPTIONS.map((status) => (
            <option key={status} value={status}>
              {CONTRACT_STATUS_LABELS[status]}
            </option>
          ))}
        </select>
        <label htmlFor="contract-filter-customer">客户</label>
        <select
          id="contract-filter-customer"
          data-testid="contract-filter-customer"
          value={draft.customerId}
          onChange={(event) => setDraft({ ...draft, customerId: event.target.value })}
        >
          <option value="">全部</option>
          {customerOptions.map((customer) => (
            <option key={customer.customerId} value={customer.customerId}>
              {customer.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="primary-button"
          data-testid="contract-filter-search"
          onClick={() =>
            onApplyFilter({
              status: draft.status === '' ? null : draft.status,
              customerId: draft.customerId === '' ? null : draft.customerId,
            })
          }
        >
          筛选
        </button>
      </div>

      <section data-testid="contract-list" aria-label="合约列表">
        <CursorTable
          ariaLabel="合约列表"
          columns={[
            { key: 'contractNumber', header: '合约编号', render: (c: ContractView) => c.contractNumber },
            { key: 'name', header: '合约名称', render: (c) => c.name },
            {
              key: 'customer',
              header: '客户',
              render: (c) => resolveCustomerName(customerOptions, c.customerId),
            },
            {
              key: 'deviceCount',
              header: '设备数量',
              render: (c) => (
                <span data-testid={`contract-device-count-${c.contractId}`}>
                  {deviceCounts?.[c.contractId] ?? '—'}
                </span>
              ),
            },
            {
              key: 'servicePeriod',
              header: '服务期限',
              render: (c) => formatServicePeriod(c.startAt, c.endAt),
            },
            {
              key: 'status',
              header: '状态（合约）',
              render: (c) => (
                <span className="contract-status" data-testid={`contract-status-${c.contractId}`}>
                  {CONTRACT_STATUS_LABELS[c.derivedStatus]}
                </span>
              ),
            },
            {
              key: 'actions',
              header: '操作',
              render: (c) => (
                <button type="button" data-testid={`contract-open-${c.contractId}`} onClick={() => onOpenDetail(c.contractId)}>
                  详情（编辑/续约/解绑/关联设备）
                </button>
              ),
            },
          ]}
          rows={contracts.rows === null ? null : [...contracts.rows]}
          rowKey={(c) => c.contractId}
          {...(contracts.loading !== undefined ? { loading: contracts.loading } : {})}
          {...(contracts.error !== undefined ? { error: contracts.error } : {})}
          onRefresh={onRefresh}
          emptyText="暂无合约"
        />
      </section>
    </div>
  );
}
