import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApiClient } from '../../api/http-client.js';
import { fetchDeviceUser } from './device-users-api.js';
import type { DeviceUserDetailState } from './types.js';

export function useDeviceUserDetail(api: ApiClient) {
  const [detail, setDetail] = useState<DeviceUserDetailState>({ kind: 'none' });
  const selection = useRef<{ id: string; controller: AbortController } | null>(null);

  useEffect(() => () => selection.current?.controller.abort(), [api]);

  const openDetail = useCallback(
    async (id: string) => {
      selection.current?.controller.abort();
      const controller = new AbortController();
      selection.current = { id, controller };
      setDetail({ kind: 'loading' });
      try {
        const next = await fetchDeviceUser(api, id, controller.signal);
        if (!controller.signal.aborted) setDetail({ kind: 'ready', detail: next });
      } catch (error) {
        if (!controller.signal.aborted) setDetail({ kind: 'error', error });
      }
    },
    [api],
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
