import { readEsgList } from './qa09-esg-api.mjs';
/** Wait for the existing scheduler. No shared worker invocation or seeded summary. */
export async function waitOwnDaily(
  ctx,
  r,
  save,
  {
    now = () => Date.now(),
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    budgetMs = 4500000,
    deviceId = ctx.receipt.devices[0],
  } = {},
) {
  if (budgetMs < 1 || budgetMs > 4500000) throw Error('DAILY_WAIT_BUDGET_REQUIRED');
  if (!ctx.receipt.devices.includes(deviceId)) throw Error('EXACT_OWN_DAILY_DEVICE_REQUIRED');
  const customerId = ctx.receipt.customers[ctx.receipt.devices.indexOf(deviceId) < 5 ? 0 : 1].id;
  const start = now();
  let lastAuth = start;
  r.dailyWait = { gate: 'WAITING_NATURAL_SUMMARY', deviceId, customerId, sharedWorkerInvocations: 0, polls: [] };
  save();
  while (now() - start < budgetMs) {
    if (now() - lastAuth >= 1200000) {
      await ctx.refreshIdentity();
      lastAuth = now();
    }
    const response = await ctx.api(
      'a5:wait-own-daily-' + r.dailyWait.polls.length,
      'GET',
      `/api/v1/admin/esg/daily?deviceId=${deviceId}&customerId=${customerId}&limit=100`,
      200,
    );
    const rows = readEsgList(response, { deviceId, customerId });
    r.dailyWait.polls.push({ at: new Date(now()).toISOString(), count: rows.length });
    save();
    if (rows.length) {
      r.dailyWait.gate = 'PASS_NATURAL_OWN_DAILY_VISIBLE';
      save();
      return;
    }
    await sleep(Math.min(30000, Math.max(0, budgetMs - (now() - start))));
  }
  r.dailyWait.gate = 'NOT_READY_IN_BOUNDED_WAIT';
  save();
  throw Error('OWN_DAILY_NOT_READY');
}
