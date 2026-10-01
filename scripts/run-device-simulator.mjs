#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout } from 'node:timers/promises';
import { runSimulation, validateConfig } from './device-simulator/core.mjs';
import { loadCredentials, MqttTransport, OfflineTransport } from './device-simulator/transport.mjs';

export async function main(args) {
  const [configPath, receiptPath] = args;
  if (!configPath || !receiptPath || args.length !== 2) throw new Error('USAGE');
  const config = validateConfig(JSON.parse(readFileSync(resolve(configPath), 'utf8')));
  let factory;
  if (config.mode === 'offline') factory = (device) => new OfflineTransport(device.deviceId, config.downlinks);
  else {
    const credentials = loadCredentials(config);
    const { connectAsync } = await import('mqtt');
    factory = (device) =>
      new MqttTransport(
        credentials.find((item) => item.device === device),
        connectAsync,
      );
  }
  const receipt = await runSimulation(config, factory, config.mode === 'offline' ? async () => {} : setTimeout);
  writeFileSync(resolve(receiptPath), `${JSON.stringify(receipt, null, 2)}\n`);
  process.stdout.write(`QA-01 ${receipt.mode}: ${receipt.status} (${receipt.deviceCount} devices)\n`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).catch(() => {
    // Credential paths, broker URLs and payloads are deliberately excluded from diagnostics.
    process.stderr.write('QA-01 failed. Check configuration, test gate, certificates and broker permissions.\n');
    process.exitCode = 1;
  });
}
