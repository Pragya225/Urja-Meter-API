import test from 'node:test';
import assert from 'node:assert/strict';
import { buildConsumption } from '../src/services/meters.js';

const r = (t, kwh, kvah, v) => ({ timestamp: t, kwh, kvah, voltageR: v });

test('buildConsumption derives interval usage, totals and power factor', () => {
  const out = buildConsumption([
    r('2026-06-24T00:00:00+05:30', 100, 110, 230),
    r('2026-06-24T00:30:00+05:30', 100.5, 110.6, 240),
    r('2026-06-24T01:00:00+05:30', 101, 111.1, 220),
  ]);
  assert.deepEqual(out.readings.map((x) => x.intervalKwh), [null, 0.5, 0.5]);
  assert.equal(out.summary.totalKwh, 1);
  assert.equal(out.summary.powerFactor, Number((1 / 1.1).toFixed(3)));
  assert.deepEqual(out.summary.voltageR, { min: 220, max: 240, avg: 230 });
});

test('buildConsumption flags a counter reset instead of reporting negative usage', () => {
  const out = buildConsumption([
    r('2026-06-24T00:00:00+05:30', 500, 510, 230),
    r('2026-06-24T00:30:00+05:30', 2, 3, 230),
  ]);
  assert.equal(out.summary.counterResets, 1);
  assert.equal(out.readings[1].intervalKwh, null);
  assert.equal(out.summary.totalKwh, null);
});

test('buildConsumption filters by from/to (inclusive) and handles empty windows', () => {
  const rows = [
    r('2026-06-24T00:00:00+05:30', 1, 1, 230),
    r('2026-06-24T00:30:00+05:30', 2, 2, 230),
    r('2026-06-24T01:00:00+05:30', 3, 3, 230),
  ];
  const out = buildConsumption(rows, { from: '2026-06-24T00:30:00+05:30', to: '2026-06-24T01:00:00+05:30' });
  assert.equal(out.summary.count, 2);
  const none = buildConsumption(rows, { from: '2030-01-01T00:00:00Z' });
  assert.equal(none.summary.count, 0);
  assert.equal(none.summary.totalKwh, null);
});

test('buildConsumption measures reading resolution: 30-minute vs daily meters', () => {
  const half = buildConsumption([
    r('2026-06-24T00:00:00+05:30', 1, 1, 230), r('2026-06-24T00:30:00+05:30', 2, 2, 230), r('2026-06-24T01:00:00+05:30', 3, 3, 230),
  ]);
  assert.equal(half.summary.intervalMinutes, 30);
  const daily = buildConsumption([
    r('2026-06-24T00:00:00+05:30', 10, 11, 230), r('2026-06-25T00:00:00+05:30', 20, 22, 230), r('2026-06-26T00:00:00+05:30', 31, 33, 230),
  ]);
  assert.equal(daily.summary.intervalMinutes, 1440);
  assert.deepEqual(daily.readings.map((x) => x.intervalKwh), [null, 10, 11]);
  assert.equal(buildConsumption([]).summary.intervalMinutes, null);
});
