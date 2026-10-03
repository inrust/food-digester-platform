export async function publishScheduled(
  messages,
  publish,
  { maxInFlight = 64, now = () => performance.now(), wait = (ms) => new Promise((r) => setTimeout(r, ms)) } = {},
) {
  if (!Number.isInteger(maxInFlight) || maxInFlight < 1 || maxInFlight > 64) throw Error('INVALID_PUBLISH_CONCURRENCY');
  const origin = now(),
    active = new Set();
  let failure;
  for (const message of messages) {
    if (failure) break;
    const delay = origin + message.due * 1000 - now();
    if (delay > 0) await wait(delay);
    while (active.size >= maxInFlight) await Promise.race(active);
    if (failure) break;
    let task;
    task = Promise.resolve()
      .then(() => publish(message))
      .catch((e) => {
        failure ??= e;
      })
      .finally(() => active.delete(task));
    active.add(task);
  }
  await Promise.all(active);
  if (failure) throw failure;
  return { elapsedMs: Math.round(now() - origin) };
}
