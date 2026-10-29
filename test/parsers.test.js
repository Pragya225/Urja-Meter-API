import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseEnergy, parseGeo, parseMeterData, parsePortalTimestamp, splitNameAndCode, toNumber } from '../src/portal/parsers.js';

const fx = (n) => JSON.parse(readFileSync(new URL(`./fixtures/${n}`, import.meta.url), 'utf8'));

test('timestamp: DD/MM/YYYY HH:mm becomes ISO with +05:30', () => {
  assert.equal(parsePortalTimestamp('23/06/2026 23:30'), '2026-06-23T23:30:00+05:30');
  assert.equal(parsePortalTimestamp('31/02/2026 10:00'), null, 'impossible date');
  assert.equal(parsePortalTimestamp('2026-06-23 10:00'), null, 'wrong format');
  assert.equal(parsePortalTimestamp(undefined), null);
});

test('toNumber turns strings into numbers and garbage into null', () => {
  assert.equal(toNumber('6850.32'), 6850.32);
  assert.equal(toNumber(''), null);
  assert.equal(toNumber('abc'), null);
  assert.equal(toNumber(null), null);
});

test('splitNameAndCode', () => {
  assert.deepEqual(splitNameAndCode('Vaishali DT 3 (DT-003)'), { name: 'Vaishali DT 3', code: 'DT-003' });
  assert.deepEqual(splitNameAndCode('No code here'), { name: 'No code here', code: null });
  assert.equal(splitNameAndCode(''), null);
  assert.equal(splitNameAndCode(undefined), null);
});

test('parseMeterData decodes the real SvelteKit __data.json for J100002', () => {
  const m = parseMeterData(fx('meter-J100002.data.json'));
  assert.equal(m.meterId, 'J100002');
  assert.equal(m.serialNo, 'AL28136');
  assert.equal(m.make, 'L&T');
  assert.equal(m.installationType, 'CT Operated');
  assert.deepEqual(m.hierarchy.zone, { name: 'Jaipur Zone 3', code: 'Z-03' });
  assert.deepEqual(m.hierarchy.dt, { name: 'Vaishali DT 3', code: 'DT-003' });
  assert.equal(Object.keys(m.hierarchy).length, 7);
});

test('parseMeterData: portal error node -> not_found', () => {
  assert.throws(() => parseMeterData({ type: 'data', nodes: [null, { type: 'error', status: 404 }] }), { kind: 'not_found' });
});

test('parseMeterData tolerates a missing hierarchy level and unknown parameters', () => {
  const body = { nodes: [null, { type: 'data', data: [
    { meterId: 1, detail: 2, hierarchy: 7 }, 'M1', { data: 3 }, [4], { parameterName: 5, parameterValue: 6 }, 'CT Ratio', '100/5', { Zone: 8 }, 'Zone A (Z-01)',
  ] }] };
  const m = parseMeterData(body);
  assert.equal(m.hierarchy.feeder, null);
  assert.equal(m.hierarchy.zone.code, 'Z-01');
  assert.deepEqual(m.extraParameters, { 'CT Ratio': '100/5' });
});

test('parseGeo handles strings, missing and out-of-range values', () => {
  assert.deepEqual(parseGeo({ data: { latitude: '26.84', longitude: '75.71' } }), { latitude: 26.84, longitude: 75.71 });
  assert.equal(parseGeo({ data: { latitude: '', longitude: '' } }), null);
  assert.equal(parseGeo({ data: { latitude: '260', longitude: '75' } }), null);
  assert.equal(parseGeo({}), null);
});

test('parseEnergy converts types, sorts, and counts bad rows instead of failing', () => {
  const { readings, skipped } = parseEnergy({ data: [
    { timestamp: '24/06/2026 00:30', kwh: '2', kvah: '3', voltR: '230' },
    { timestamp: '24/06/2026 00:00', kwh: '1', kvah: '', voltR: '' },
    { timestamp: 'garbage', kwh: '1' },
    { timestamp: '24/06/2026 01:00', kwh: 'x' },
  ] });
  assert.equal(skipped, 2);
  assert.deepEqual(readings.map((r) => r.kwh), [1, 2]);
  assert.equal(readings[0].kvah, null);
  assert.equal(readings[1].voltageR, 230);
});

test('timestamp: a date without a time means midnight (coarser-resolution meters)', () => {
  assert.equal(parsePortalTimestamp('24/06/2026'), '2026-06-24T00:00:00+05:30');
});
