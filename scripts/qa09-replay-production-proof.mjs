/** Exact Job -> SQS production -> duplicate consumption, without inspecting payloads. */
export function projectReplayProduction(text) {
  let row;
  try {
    row = JSON.parse(text.slice(text.indexOf('{')));
  } catch {
    return null;
  }
  if (
    row?.event !== 'replay.record.produced' ||
    row.schemaVersion !== 1 ||
    !/^[a-f0-9-]{36}$/.test(row.jobId ?? '') ||
    !/^qa09-[a-f0-9]{16}-(0[1-9]|10)$/.test(row.deviceId ?? '') ||
    row.topicType !== 'telemetry' ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(row.messageId ?? '') ||
    !/^[A-Za-z0-9-]{1,128}$/.test(row.sqsMessageId ?? '') ||
    !Number.isSafeInteger(row.seq) ||
    row.seq < 0
  )
    return null;
  return {
    event: row.event,
    schemaVersion: 1,
    jobId: row.jobId,
    deviceId: row.deviceId,
    topicType: row.topicType,
    messageId: row.messageId,
    seq: row.seq,
    sqsMessageId: row.sqsMessageId,
  };
}
export function uniqueReplayProduction(rows, expected) {
  const exact = rows.filter((row) =>
    ['jobId', 'deviceId', 'topicType', 'messageId', 'seq'].every((key) => row[key] === expected[key]),
  );
  const ids = [...new Set(exact.map((row) => row.sqsMessageId))];
  return ids.length === 1
    ? { gate: 'PASS_UNIQUE_REPLAY_JOB_PRODUCTION', sqsMessageId: ids[0], rows: exact }
    : { gate: ids.length ? 'AMBIGUOUS_PRODUCTION' : 'NO_RECEIPT', rows: exact };
}
export async function collectReplayProduction(
  expected,
  { read, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)), budgetMs = 90000 },
) {
  if (
    !/^[a-f0-9-]{36}$/.test(expected.jobId ?? '') ||
    !/^qa09-[a-f0-9]{16}-(0[1-9]|10)$/.test(expected.deviceId ?? '') ||
    !Number.isFinite(expected.startMs) ||
    !Number.isFinite(expected.endMs) ||
    expected.endMs < expected.startMs ||
    expected.endMs - expected.startMs > 600000 ||
    budgetMs < 1 ||
    budgetMs > 90000
  )
    throw Error('EXACT_PRODUCER_SCOPE_REQUIRED');
  const start = now(),
    rows = [],
    reads = [];
  for (let round = 0; round < 6 && now() - start < budgetMs; round++) {
    let token;
    const tokens = new Set();
    for (let page = 0; page < 8; page++) {
      const args = [
        'logs',
        'filter-log-events',
        '--log-group-name',
        '/aws/lambda/fdp-test-replay',
        '--start-time',
        String(expected.startMs),
        '--end-time',
        String(expected.endMs),
        '--filter-pattern',
        `{ $.jobId = "${expected.jobId}" }`,
        '--limit',
        '100',
        '--no-paginate',
      ];
      if (token) args.push('--next-token', token);
      const remaining = budgetMs - (now() - start);
      if (remaining <= 0) throw Error('PRODUCER_READ_BUDGET_EXCEEDED');
      const response = await read(args, Math.min(10000, remaining));
      if (now() - start > budgetMs || (response.events?.length ?? 0) > 100)
        throw Error('PRODUCER_READ_BUDGET_EXCEEDED');
      reads.push({ round, page, count: response.events?.length ?? 0 });
      for (const event of response.events ?? []) {
        const row = projectReplayProduction(event.message);
        if (row && event.timestamp >= expected.startMs && event.timestamp <= expected.endMs) rows.push(row);
      }
      if (!response.nextToken) break;
      if (tokens.has(response.nextToken) || page === 7) throw Error('INCOMPLETE_PRODUCER_LOG_WINDOW');
      tokens.add(response.nextToken);
      token = response.nextToken;
    }
    const proof = uniqueReplayProduction(rows, expected);
    if (proof.gate !== 'NO_RECEIPT') return { ...proof, reads };
    if (round < 5) await sleep(Math.min(10000, Math.max(0, budgetMs - (now() - start))));
  }
  return { gate: 'NO_RECEIPT', rows, reads };
}
