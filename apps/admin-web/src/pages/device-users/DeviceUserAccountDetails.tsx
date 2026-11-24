import { TimeText } from '../../components/TimeText.js';
import type { FilterOption } from '../../components/ScopeFilter.js';
import { translate } from '../../i18n/i18n.js';
import { DEVICE_USER_STATUS_LABELS, deviceUserCustomerLabel } from './device-user-state.js';
import type { DeviceUserReadView } from './types.js';

export function DeviceUserAccountDetails({
  user,
  authorizedCustomers,
}: {
  readonly user: DeviceUserReadView;
  readonly authorizedCustomers?: readonly FilterOption[];
}) {
  return (
    <section className="detail-card" aria-label={translate('detail.deviceUser.account')}>
      <h4>{translate('detail.deviceUser.account')}</h4>
      <dl>
        <dt>{translate('page.a1aaf352cb07')}</dt>
        <dd data-testid="detail-username">{user.username}</dd>
        <dt>{translate('page.c10bbf5ddd2d')}</dt>
        <dd data-testid="detail-display-name">{user.displayName ?? '—'}</dd>
        <dt>{translate('page.467c1137f479')}</dt>
        <dd data-testid="detail-customer">{deviceUserCustomerLabel(user, authorizedCustomers)}</dd>
        <dt>{translate('page.62e951a692ff')}</dt>
        <dd data-testid="detail-status">{DEVICE_USER_STATUS_LABELS[user.status]}</dd>
        <dt>{translate('page.928728223d5a')}</dt>
        <dd data-testid="detail-version">v{user.version}</dd>
        <dt>{translate('page.093dea88c930')}</dt>
        <dd>
          <TimeText iso={user.updatedAt} />
        </dd>
      </dl>
    </section>
  );
}
