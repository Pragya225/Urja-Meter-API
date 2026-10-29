import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTree, repairHierarchies } from '../src/domain/hierarchy.js';
import { filterMeters, haversineKm } from '../src/domain/query.js';
import { sign } from '../src/portal/bulk.js';
import { buildSnapshot, createDataset } from '../src/services/dataset.js';

const node = (code, name = code) => ({ code, name });
const meter = (id, dt, h = {}, extra = {}) => ({
  meterId: id, dtCode: dt, installStatus: 'Installed', location: null,
  hierarchy: { zone: node('Z-01'), circle: node('C-01'), division: node('D-01'), subdivision: node('SD-01'), substation: node('SS-01'), feeder: node('F-001'), dt: node(dt), ...h },
  ...extra,
});

test('sign(): HMAC-SHA256 over METHOD\\npath\\nquery\\ntimestamp (formula verified against a real captured request)', () => {
  const sig = sign({ secret: 'k', path: '/portal/export', query: 'page=1', timestamp: 1793189532 });
  assert.match(sig, /^[0-9a-f]{64}$/);
  assert.equal(sig, sign({ secret: 'k', path: '/portal/export', query: 'page=1', timestamp: '1793189532' }));
  assert.notEqual(sig, sign({ secret: 'k', path: '/portal/export', query: 'page=2', timestamp: 1793189532 }));
});

test('repair fills an empty code from peers on the same transformer and records it', () => {
  const ms = [meter('A', 'DT-1'), meter('B', 'DT-1', { circle: { name: 'C-01', code: null } }), meter('C', 'DT-1', { feeder: null })];
  const { repairs, conflicts } = repairHierarchies(ms);
  assert.equal(ms[1].hierarchy.circle.code, 'C-01');
  assert.equal(ms[2].hierarchy.feeder.code, 'F-001');
  assert.deepEqual(repairs.map((r) => [r.meterId, r.level]).sort(), [['B', 'circle'], ['C', 'feeder']]);
  assert.equal(conflicts.length, 0);
});

test('repair refuses to guess when peers disagree', () => {
  const ms = [meter('A', 'DT-1'), meter('B', 'DT-1', { circle: node('C-09') }), meter('C', 'DT-1', { circle: { name: 'Circle ?', code: null } })];
  const { conflicts } = repairHierarchies(ms);
  assert.equal(conflicts[0].level, 'circle');
  assert.equal(ms[2].hierarchy.circle.code, null);
});

test('tree is keyed by PATH: the same division code under two circles stays two nodes', () => {
  const ms = [
    meter('A', 'DT-1', { circle: node('C-01'), division: node('D-01') }),
    meter('B', 'DT-2', { circle: node('C-03'), division: node('D-01') }),
  ];
  const zone = buildTree(ms, new Map())[0];
  assert.equal(zone.children.length, 2);
  assert.deepEqual(zone.children.map((c) => c.children[0].code), ['D-01', 'D-01']);
  assert.equal(zone.meterCount, 2);
});

test('haversine: Jaipur to Delhi is about 235 km', () => {
  const d = haversineKm({ latitude: 26.9124, longitude: 75.7873 }, { latitude: 28.6139, longitude: 77.209 });
  assert.ok(d > 225 && d < 245, String(d));
});

test('filterMeters is case-insensitive and ignores meters without location in near-search', () => {
  const ms = [
    { ...meter('J1', 'DT-1'), make: 'HPL', installStatus: 'Faulty', location: { latitude: 26.9, longitude: 75.8 } },
    { ...meter('J2', 'DT-1'), make: 'Genus', serialNo: 'SE1' },
  ];
  assert.equal(filterMeters(ms, { status: 'faulty' }).length, 1);
  assert.equal(filterMeters(ms, { q: 'se1' })[0].meterId, 'J2');
  const near = filterMeters(ms, { near: { latitude: 26.9, longitude: 75.8, radiusKm: 1 } });
  assert.deepEqual(near.map((m) => m.meterId), ['J1']);
});

test('snapshot reports a DT that is missing from the transformer list', () => {
  const snap = buildSnapshot({ meters: [meter('A', 'DT-X')], dts: [], total: 1 });
  assert.equal(snap.quality.summary.issuesByType.dt_not_in_transformer_list, 1);
});

test('dataset: serves stale data instantly, refreshes in background, survives a failed refresh', async () => {
  let t = 0;
  let calls = 0;
  let fail = false;
  const loader = {
    fetchAllMeters: async () => { calls++; if (fail) throw new Error('portal down'); return { meters: [meter(`M${calls}`, 'DT-1')], total: 1, dropped: 0 }; },
    fetchAllDts: async () => [{ code: 'DT-1', name: 'One', feederCode: 'F-001', capacityKva: 100 }],
  };
  const ds = createDataset({ loader, ttlMs: 1000, now: () => t });
  assert.equal((await ds.get()).meters[0].meterId, 'M1');
  t = 500; await ds.get();
  assert.equal(calls, 1, 'fresh: no reload');
  t = 2000; fail = true;
  assert.equal((await ds.get()).meters[0].meterId, 'M1', 'stale snapshot is served while refreshing');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(ds.status().lastError, 'portal down');
  assert.equal((await ds.get()).meters[0].meterId, 'M1', 'failed refresh keeps old data');
});
