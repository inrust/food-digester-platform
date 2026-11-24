import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { ApiClientError } from '../api/errors.js';
import type { ApiClient } from '../api/http-client.js';
import { ErrorNotice } from '../components/ErrorNotice.js';
import { Button } from '../components/ui.js';
import { translate } from '../i18n/i18n.js';
import { fetchDevice } from '../pages/devices/devices-api.js';
import type { DeviceView } from '../pages/devices/types.js';

export function deviceScopeMismatch(): ApiClientError {
  return new ApiClientError(404, 'NOT_FOUND', translate('deviceWorkbench.unavailable'));
}

export function ValidatedDeviceWorkbench({
  api,
  requestedId,
  customerId,
  onChoose,
  children,
}: {
  readonly api: ApiClient;
  readonly requestedId: string;
  readonly customerId: string | null;
  readonly onChoose: () => void;
  readonly children: (device: DeviceView) => ReactNode;
}) {
  const [state, setState] = useState<
    { kind: 'loading' } | { kind: 'error'; error: unknown } | { kind: 'ready'; device: DeviceView }
  >({ kind: 'loading' });
  useEffect(() => {
    if (requestedId === '') return;
    const request = new AbortController();
    void fetchDevice(api, requestedId, request.signal).then(
      (device) => {
        if (request.signal.aborted) return;
        if (device.id !== requestedId || (customerId !== null && device.customer?.id !== customerId)) {
          setState({ kind: 'error', error: deviceScopeMismatch() });
        } else {
          setState({ kind: 'ready', device });
        }
      },
      (error: unknown) => {
        if (!request.signal.aborted) setState({ kind: 'error', error });
      },
    );
    return () => request.abort();
  }, [api, customerId, requestedId]);
  if (state.kind === 'ready') return children(state.device);
  if (requestedId !== '' && state.kind === 'loading') {
    return <p role="status">{translate('page.300ee3dee4dc')}</p>;
  }
  return (
    <section className="detail-stack">
      <ErrorNotice error={state.kind === 'error' ? state.error : deviceScopeMismatch()} />
      <Button type="button" onClick={onChoose}>
        {translate('deviceWorkbench.chooseDevice')}
      </Button>
    </section>
  );
}
