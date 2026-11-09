/** Used only by the frozen local quality runner. Allow test loopback/Unix sockets, block external Node networking. */
import net from 'node:net';
import { appendFileSync } from 'node:fs';
const allowed = (value) => {
  const h = String(value ?? 'localhost')
    .toLowerCase()
    .replace(/^\[|\]$/gu, '');
  return (
    h === 'localhost' ||
    h === 'localhost.' ||
    h === '::1' ||
    h === '::' ||
    h === '0.0.0.0' ||
    /^127\.\d+\.\d+\.\d+$/u.test(h) ||
    /^::ffff:127\.\d+\.\d+\.\d+$/u.test(h)
  );
};
const deny = () => {
  if (process.env.FDP_MC03_OFFLINE_GUARD_LOG)
    appendFileSync(process.env.FDP_MC03_OFFLINE_GUARD_LOG, 'NON_LOOPBACK_NODE_NETWORK_BLOCKED\n');
  throw Error('MC03_OFFLINE_NETWORK_GUARD');
};
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  const host =
    first && typeof first === 'object'
      ? first.host
      : typeof first === 'number' && typeof args[1] === 'string'
        ? args[1]
        : undefined;
  if (!allowed(host)) deny();
  return connect.apply(this, args);
};
const fetch = globalThis.fetch;
globalThis.fetch = async (input, options) => {
  const u = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (['http:', 'https:'].includes(u.protocol) && !allowed(u.hostname)) deny();
  return fetch(input, options);
};
