import { useEffect, useState } from 'react';
import type { ApiClient } from '../api/http-client.js';
import type { DevicePickerOptions, DevicePickerState } from '../components/DeviceScopePicker.js';
import { fetchDevices } from '../pages/devices/devices-api.js';
import type { DeviceView } from '../pages/devices/types.js';
import { collectAll } from './collect-all.js';

const EMPTY_OPTIONS: DevicePickerOptions = { regions: [], subregions: [], sites: [], devices: [] };

function pickerOptions(devices: readonly DeviceView[]): DevicePickerOptions {
  const sites = new Map(devices.flatMap(({ site }) => (site ? [[site.id, site] as const] : [])));
  const regions = new Set<string>();
  const subregions = new Map<string, DevicePickerOptions['subregions'][number]>();
  const siteOptions: DevicePickerOptions['sites'][number][] = [];
  for (const site of sites.values()) {
    if (!site.region) continue;
    regions.add(site.region);
    if (!site.subregion) continue;
    subregions.set(JSON.stringify([site.region, site.subregion]), {
      value: site.subregion,
      label: site.subregion,
      region: site.region,
    });
    siteOptions.push({ value: site.id, label: site.name, region: site.region, subregion: site.subregion });
  }

  return {
    regions: [...regions].map((region) => ({ value: region, label: region })),
    subregions: [...subregions.values()],
    sites: siteOptions,
    devices: devices.map((device) => ({
      value: device.id,
      label: device.alias ? `${device.alias} (${device.serialNumber})` : device.serialNumber,
      siteId: device.site?.id ?? '',
    })),
  };
}

/** The device list already includes the site labels and enforces the session's scope. */
export function useDevicePicker(api: ApiClient, customerId: string | null) {
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<{
    api: ApiClient;
    customerId: string | null;
    revision: number;
    options: DevicePickerOptions;
    state: DevicePickerState;
  }>();
  useEffect(() => {
    let active = true;
    const filter = customerId === null ? undefined : { customerId };
    void collectAll((cursor) => fetchDevices(api, filter, { cursor, limit: 100 })).then(
      (devices) => {
        if (!active) return;
        const visible = customerId === null ? devices : devices.filter((device) => device.customer?.id === customerId);
        setResult({ api, customerId, revision, options: pickerOptions(visible), state: { status: 'ready' } });
      },
      (error: unknown) => {
        if (active) setResult({ api, customerId, revision, options: EMPTY_OPTIONS, state: { status: 'error', error } });
      },
    );
    return () => {
      active = false;
    };
  }, [api, customerId, revision]);
  const current =
    result?.api === api && result.customerId === customerId && result.revision === revision ? result : null;
  return {
    options: current?.options ?? EMPTY_OPTIONS,
    state: current?.state ?? ({ status: 'loading' } as const),
    retry: () => setRevision((previous) => previous + 1),
  };
}
