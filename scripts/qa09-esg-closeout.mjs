import { isDeepStrictEqual } from 'node:util';
import { ESG_CSV_SCHEMAS } from '../apps/cloud-api/src/admin/esg/csv.ts';
import { canonical } from './qa09-archive-probe.mjs';
import { sha256 } from './qa09-reliability-closeout.mjs';
const equal = (a, b) => isDeepStrictEqual(a, b);
const near = (a, b) =>
  a !== null &&
  a !== undefined &&
  b !== null &&
  b !== undefined &&
  Number.isFinite(Number(a)) &&
  Math.abs(Number(a) - Number(b)) <= 1e-6;
const date = (v) => new Date(v).toISOString();
const day = (v) => date(v).slice(0, 10) + 'T00:00:00.000Z';
const hour = (v) => date(v).slice(0, 13) + ':00:00.000Z';
const fields = {
  feedingWeightKg: 'feeding_weight_kg',
  dischargeWeightKg: 'discharge_weight_kg',
  reductionWeightKg: 'reduction_weight_kg',
  energyConsumptionKwh: 'power_consumption_kwh',
  carbonReductionKg: 'carbon_reduction_kg',
  dataCompletenessPct: 'data_completeness_pct',
  missingRecordCount: 'missing_record_count',
};
export function assertConsistency(frame, telemetry, reports, devices, customers) {
  const prefix = devices?.[0]?.slice(0, -3);
  if (
    !/^qa09-[a-f0-9]{16}$/.test(prefix ?? '') ||
    devices.length !== 10 ||
    devices.some((id, i) => id !== prefix + '-' + String(i + 1).padStart(2, '0')) ||
    customers?.length !== 2 ||
    frame.readOnly !== true ||
    frame.devices?.length !== 10 ||
    frame.devices.some(
      (d, i) => d.id !== devices[i] || d.customer_id !== customers[i < 5 ? 0 : 1].id || d.lifecycle_status === 'Active',
    )
  )
    throw Error('CONSISTENCY_OWN_SCOPE_REQUIRED');
  if (
    telemetry.length !== 20 ||
    reports.length !== 2 ||
    !equal(
      reports.map((r) => r.deviceId),
      [devices[0], devices[5]],
    ) ||
    telemetry.some((t) => !devices.includes(t.deviceId)) ||
    new Set(telemetry.map((t) => t.deviceId + '/' + t.seq)).size !== 20 ||
    devices.some((d) => telemetry.filter((t) => t.deviceId === d).length !== 2)
  )
    throw Error('EXACT_PUBLISHED_ORACLE_REQUIRED');
  if (
    frame.outbox?.length !== 22 ||
    frame.receipts?.length !== 32 ||
    frame.receipts.some(
      (r) =>
        !devices.includes(r.device_id) ||
        r.result !== 'PROCESSED' ||
        !['heartbeat', 'telemetry', 'report'].includes(r.topic_type),
    ) ||
    devices.some((d) => frame.receipts.filter((r) => r.device_id === d && r.topic_type === 'heartbeat').length !== 1) ||
    new Set(frame.receipts.map((r) => r.device_id + '/' + r.topic_type + '/' + r.seq)).size !== 32
  )
    throw Error('PROCESSED_RECEIPT_SET_REQUIRED');
  for (const p of [
    ...telemetry.map((t) => ({ ...t, type: 'telemetry' })),
    ...reports.map((r) => ({ ...r, type: 'report' })),
  ]) {
    if (!/^[a-f0-9]{64}$/.test(p.payloadSha256 ?? '') || !/^[a-f0-9]{64}$/.test(p.bodySha256 ?? ''))
      throw Error('PUBLISHED_HASH_REQUIRED');
    const r = frame.receipts.filter(
      (r) => r.device_id === p.deviceId && r.topic_type === p.type && Number(r.seq) === p.seq,
    );
    if (r.length !== 1 || r[0].payload_hash !== p.payloadSha256 || date(r[0].occurred_at) !== date(p.occurredAt))
      throw Error('SOURCE_RECEIPT_BINDING_DRIFT');
    // The archive raw body is the full Ingress Envelope, not publisher MQTT bytes.
    // Bind the message by its canonical payload; S3 verification binds the separate ingress byte hash.
    const out = frame.outbox.filter(
      (o) => o.aggregate_id === p.deviceId && o.topic_type === p.type && o.payload_hash === p.payloadSha256,
    );
    if (
      out.length !== 1 ||
      out[0].status !== 'PUBLISHED' ||
      out[0].has_raw !== true ||
      !/^[a-f0-9]{64}$/.test(out[0].raw_body_sha256 ?? '') ||
      out[0].payload_hash !== p.payloadSha256
    )
      throw Error('PUBLISHED_ARCHIVE_BINDING_REQUIRED');
  }
  const metricRows = (rows, daily) => {
    const groups = new Map();
    for (const t of telemetry) {
      const key = t.deviceId + '/' + (daily ? day(t.occurredAt) : hour(t.occurredAt));
      const g = groups.get(key) ?? [];
      g.push(t);
      groups.set(key, g);
    }
    if (rows?.length !== groups.size) throw Error('AGGREGATE_ROWS_MISSING_OR_EXTRA');
    for (const [key, samples] of groups) {
      const t = samples[0],
        c = customers[devices.indexOf(t.deviceId) < 5 ? 0 : 1].id;
      const matches = rows.filter(
        (r) =>
          r.device_id + '/' + date(daily ? r.bucket_date : r.bucket_start) === key &&
          r.customer_id === c &&
          r.site_id === '__UNASSIGNED__',
      );
      if (matches.length !== 1) throw Error('AGGREGATE_SCOPE_DRIFT');
      const r = matches[0];
      if (
        Number(r.sample_count) !== samples.length ||
        !near(r.completeness_pct, 100) ||
        Number(r.missing_record_count) !== 0
      )
        throw Error('AGGREGATE_COUNT_OR_COMPLETENESS_DRIFT');
      const keys = Object.keys(t.data)
        .filter((k) => typeof t.data[k] === 'number')
        .sort();
      if (!equal(Object.keys(r.metrics).sort(), keys)) throw Error('METRIC_KEYS_DRIFT');
      for (const k of keys) {
        const values = samples.map((s) => s.data[k]),
          m = r.metrics[k];
        if (
          !near(m.avg, values.reduce((a, b) => a + b, 0) / values.length) ||
          !near(m.min, Math.min(...values)) ||
          !near(m.max, Math.max(...values)) ||
          Number(m.count) !== values.length
        )
          throw Error('METRIC_ROLLUP_DRIFT');
      }
    }
  };
  metricRows(frame.telemetry_hourly, false);
  metricRows(frame.telemetry_daily, true);
  if (frame.esg_reports?.length !== 2 || frame.esg_daily_summary?.length !== 2)
    throw Error('NONEMPTY_REPORT_AND_ESG_REQUIRED');
  for (const p of reports) {
    const c = customers[devices.indexOf(p.deviceId) < 5 ? 0 : 1].id;
    const matches = frame.esg_reports.filter(
      (r) =>
        r.device_id === p.deviceId &&
        r.customer_id === c &&
        r.site_id === '__UNASSIGNED__' &&
        r.source_message_id === p.messageId,
    );
    const summaries = frame.esg_daily_summary.filter(
      (r) =>
        r.device_id === p.deviceId &&
        r.customer_id === c &&
        r.site_id === '__UNASSIGNED__' &&
        date(r.summary_date) === day(p.data.periodStartTime),
    );
    if (matches.length !== 1 || summaries.length !== 1) throw Error('ESG_REPORT_SCOPE_DRIFT');
    const r = matches[0],
      s = summaries[0];
    if (
      r.report_type !== p.data.reportType ||
      date(r.period_start_time) !== date(p.data.periodStartTime) ||
      date(r.period_end_time) !== date(p.data.periodEndTime) ||
      r.carbon_reduction_method !== p.data.carbonReductionMethod
    )
      throw Error('ESG_PERIOD_OR_METHOD_DRIFT');
    const reportFields = {
      ...fields,
      cycleCount: 'cycle_count',
      processingDurationMinutes: 'processing_minutes',
      averagePowerKw: 'avg_power_kw',
      averageO2Pct: 'avg_o2_pct',
      averageCo2Ppm: 'avg_co2_ppm',
      averageCh4Ppm: 'avg_ch4_ppm',
      averageN2oPpm: 'avg_n2o_ppm',
    };
    for (const [source, column] of Object.entries(reportFields))
      if (!near(r[column], p.data[source])) throw Error('REPORT_VALUE_DRIFT');
    for (const [source, column] of Object.entries(fields))
      if (!near(r[column], p.data[source]) || !near(s[column], p.data[source]))
        throw Error('ESG_SUM_OR_COMPLETENESS_DRIFT');
    if (
      !frame.calculationVersions?.some(
        (v) => v.id === s.calculation_version_id && v.version === 'aggregator@2.0.0' && v.status === 'ACTIVE',
      )
    )
      throw Error('CALCULATION_VERSION_REQUIRED');
  }
  return {
    gate: 'PASS_REAL_MQTT_DAILY_ARCHIVE_ESG_CONSISTENCY',
    receipts: 32,
    telemetrySamples: 20,
    hourlyRows: frame.telemetry_hourly.length,
    dailyRows: frame.telemetry_daily.length,
    reportRows: 2,
    esgSummaryRows: 2,
    sourceAttestation: 'SIMULATED_DEVICE_REPORT_NOT_THIRD_PARTY_VERIFICATION',
    fullQa09Accepted: false,
  };
}
/** Strict RFC4180 parser: quoted JSON is a cell, not multiple CSV rows. */
export function parseCsv(text) {
  if (typeof text !== 'string' || Buffer.byteLength(text) > 1048576 || !text.endsWith('\r\n'))
    throw Error('BOUNDED_CSV_REQUIRED');
  const rows = [];
  let row = [],
    cell = '',
    quoted = false,
    closed = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
          closed = true;
        }
      } else cell += c;
      continue;
    }
    if (c === '"') {
      if (cell || closed) throw Error('CSV_QUOTE_INVALID');
      quoted = true;
      continue;
    }
    if (c === ',' || c === '\r') {
      row.push(cell);
      cell = '';
      closed = false;
      if (c === '\r') {
        if (text[++i] !== '\n') throw Error('CSV_NEWLINE_INVALID');
        rows.push(row);
        row = [];
      }
      continue;
    }
    if (c === '\n' || closed) throw Error('CSV_CHARACTER_INVALID');
    cell += c;
  }
  if (quoted || cell || row.length || rows.length < 2 || rows.some((r) => r.length !== rows[0].length))
    throw Error('CSV_INCOMPLETE_OR_EMPTY');
  return rows;
}
const column = (name) => (name === 'reportId' ? 'id' : name.replace(/[A-Z]/g, (m) => '_' + m.toLowerCase()));
export function assertCsvDatabase(text, dataset, frame, deviceId, customerId) {
  const table = {
    HOURLY: 'telemetry_hourly',
    DAILY: 'telemetry_daily',
    REPORTS: 'esg_reports',
    DAILY_SUMMARY: 'esg_daily_summary',
  }[dataset];
  if (!table || !frame.devices.some((d) => d.id === deviceId && d.customer_id === customerId))
    throw Error('CSV_EXACT_OWN_SCOPE_REQUIRED');
  const rows = parseCsv(text),
    headers = ESG_CSV_SCHEMAS[dataset],
    db = frame[table].filter((r) => r.device_id === deviceId && r.customer_id === customerId);
  if (!equal(rows[0], headers) || db.length === 0 || rows.length - 1 !== db.length)
    throw Error('CSV_SCHEMA_OR_NONEMPTY_COUNT_DRIFT');
  const normalized = (values) =>
    values.map((v, i) => {
      if (v === null || v === undefined || v === '') return null;
      const h = headers[i];
      if (h === 'metrics') return canonical(typeof v === 'string' ? JSON.parse(v) : v);
      if (['bucketStart', 'bucketDate', 'periodStartTime', 'periodEndTime', 'summaryDate'].includes(h)) return date(v);
      if (
        /^(sampleCount|completenessPct|feedingWeightKg|dischargeWeightKg|reductionWeightKg|cycleCount|processingMinutes|powerConsumptionKwh|avgPowerKw|avgO2Pct|avgCo2Ppm|avgCh4Ppm|avgN2oPpm|carbonReductionKg|dataCompletenessPct|missingRecordCount)$/.test(
          h,
        )
      ) {
        if (!Number.isFinite(Number(v))) throw Error('CSV_NUMBER_INVALID');
        return Number(v);
      }
      return String(v);
    });
  const actual = rows.slice(1).map(normalized).map(canonical).sort(),
    expected = db
      .map((r) => normalized(headers.map((h) => r[column(h)])))
      .map(canonical)
      .sort();
  if (!equal(actual, expected)) throw Error('CSV_DATABASE_VALUE_DRIFT');
  return {
    gate: 'PASS_NONEMPTY_CSV_DATABASE_EQUAL',
    dataset,
    rowCount: db.length,
    bytes: Buffer.byteLength(text),
    sha256: sha256(text),
  };
}
export function assertLeaseRecovery(before, injected, after, firstCsv, recoveredCsv) {
  if (
    !before ||
    !injected?.expired ||
    injected.id !== before.id ||
    injected.status !== 'PROCESSING' ||
    before.status !== 'COMPLETED' ||
    after?.id !== before.id ||
    after.status !== 'COMPLETED' ||
    after.lease_token !== null ||
    after.lease_until !== null ||
    Date.parse(after.completed_at) <= Date.parse(before.completed_at) ||
    after.row_count !== before.row_count ||
    after.requested_by !== before.requested_by ||
    after.dataset !== before.dataset ||
    !equal(after.filters, before.filters) ||
    after.storage_key !== before.storage_key ||
    sha256(firstCsv) !== sha256(recoveredCsv)
  )
    throw Error('OWN_EXPIRED_LEASE_RECOVERY_NOT_PROVEN');
  return {
    gate: 'PASS_OWN_EXPIRED_EXPORT_LEASE_RECOVERY',
    id: before.id,
    previousCompletedAt: date(before.completed_at),
    recoveredCompletedAt: date(after.completed_at),
    csvSha256: sha256(recoveredCsv),
  };
}
/** A frozen read-only audit cannot create future writes; its failure never becomes acceptance. */
export function cleanupFailureRequiresHold({ lastAction, knownCleanupCommitted, existingHold }) {
  return existingHold !== false || knownCleanupCommitted !== true || lastAction !== 'business-audit';
}
/** Polls are reads; original timeout/error and all submission ownership remain visible. */
export async function waitRead(
  read,
  ready,
  { budgetMs, intervalMs, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), observe = () => {} },
) {
  if (
    !Number.isInteger(budgetMs) ||
    budgetMs < 1 ||
    budgetMs > 4500000 ||
    !Number.isInteger(intervalMs) ||
    intervalMs < 1
  )
    throw Error('BOUNDED_READ_BUDGET_REQUIRED');
  const end = now() + budgetMs;
  for (let n = 0; n < 160 && now() < end; n++) {
    const value = await read(n);
    observe({ attempt: n + 1, elapsedBudgetMs: budgetMs - Math.max(0, end - now()) });
    if (now() > end) throw Error('READ_TOTAL_DEADLINE');
    if (ready(value)) return value;
    await sleep(Math.min(intervalMs, Math.max(0, end - now())));
  }
  throw Error('READ_TOTAL_DEADLINE');
}
