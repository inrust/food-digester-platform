import { translate } from '../../i18n/i18n.js';
/**
 * FE-05 Customer 数据类型：镜像 contracts/rest/admin-customer-api.json（BE-CUS-01）。
 */
export type CustomerStatus = 'ACTIVE' | 'SUSPENDED';
export interface CustomerView {
  readonly id: string;
  readonly name: string;
  readonly status: CustomerStatus;
  /** 乐观锁版本（写操作经 If-Match 携带）。 */
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}
export const CUSTOMER_STATUS_LABELS: Readonly<Record<CustomerStatus, string>> = {
  get ACTIVE() {
    return translate('page.f78d037abccd');
  },
  get SUSPENDED() {
    return translate('page.6c7dcbb73a59');
  },
};
