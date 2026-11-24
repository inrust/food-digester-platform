import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiClientError } from '../../api/errors.js';
import { translate } from '../../i18n/i18n.js';
import type { ApiClient } from '../../api/http-client.js';
import { fetchDeviceUser } from './device-users-api.js';
import type { DeviceUserDetailState } from './types.js';

export function useDeviceUserDetail(api: ApiClient, deviceId?: string, customerId?: string) {
  const [detail, setDetail] = useState<DeviceUserDetailState>({ kind: 'none' });
  const selection = useRef<{ id: string; controller: AbortController } | null>(null);

  useEffect(() => () => selection.current?.controller.abort(), [api, customerId, deviceId]);

  const openDetail = useCallback(
    async (id: string) => {
      selection.current?.controller.abort();
      const controller = new AbortController();
      selection.current = { id, controller };
      setDetail({ kind: 'loading' });
      try {
        const next = await fetchDeviceUser(api, id, controller.signal, deviceId);
        if (
          next.deviceUserId !== id ||
          (deviceId !== undefined &&
            (next.customerId !== customerId ||
              !next.assignments.some((row) => row.deviceId === deviceId && row.status === 'ACTIVE') ||
              next.assignments.some((row) => row.deviceId !== deviceId) ||
              next.syncStates?.some((row) => row.deviceId !== deviceId)))
        )
          throw new ApiClientError(404, 'NOT_FOUND', translate('deviceWorkbench.unavailable'));
        if (!controller.signal.aborted) setDetail({ kind: 'ready', detail: next });
      } catch (error) {
        if (!controller.signal.aborted) setDetail({ kind: 'error', error });
      }
    },
    [api, customerId, deviceId],
  );

  const closeDetail = () => {
    selection.current?.controller.abort();
    selection.current = null;
    setDetail({ kind: 'none' });
  };

  const refreshDetail = () => {
    if (selection.current !== null) void openDetail(selection.current.id);
  };

  return { detail, openDetail, closeDetail, refreshDetail };
}
