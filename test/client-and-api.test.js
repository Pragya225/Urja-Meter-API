import test from 'node:test';
import assert from 'node:assert/strict';
import { PortalClient } from '../src/portal/client.js';
import { createBulkLoader } from '../src/portal/bulk.js';
import { TtlCache } from '../src/cache.js';
import { createDataset } from '../src/services/dataset.js';
import { createMeterService } from '../src/services/meters.js';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { startMockPortal } from './helpers/mockPortal.js';

async function setup(opts) {
  const portal = await startMockPortal(opts);
  const config = loadConfig({ PORTAL_EMAIL: 'operator@urja.local', PORTAL_PASSWORD: 'urja-ops-2026', PORTAL_URL: portal.baseUrl });
  const client = new PortalClient({ baseUrl: portal.baseUrl, email: config.email, password: config.password, retryBaseMs: 5, timeoutMs: 2000, maxRetries: 1 });
  const dataset = createDataset({ loader: createBulkLoader(client), ttlMs: config.ttl.datasetMs });
  const meters = createMeterService({ client, cache: new TtlCache(), config, dataset });
  const app = await buildApp({ meters });
  return { portal, client, app, close: async () => { await app.close(); await portal.close(); } };
}
const withPortal = (fn, opts) => async () => { const t = await setup(opts); try { await fn(t); } finally { await t.close(); } };

// ------------------------------------------------------------ session handling
test('login + search, with ONE login shared by parallel requests', withPortal(async (t) => {
  await Promise.all([1, 2, 3].map((i) => t.client.getJson(`/portal/meters/search?q=x${i}&page=1`)));
  assert.equal(t.portal.state.logins, 1);
}));

test('wrong credentials -> auth error (not a crash)', async () => {
  const portal = await startMockPortal();
  const client = new PortalClient({ baseUrl: portal.baseUrl, email: 'x@y', password: 'bad' });
  await assert.rejects(client.getJson('/portal/meters/search?q=&page=1'), { kind: 'auth' });
  await portal.close();
});

test('session expiry: client re-logs in and retries transparently', withPortal(async (t) => {
  await t.client.getJson('/portal/meters/search?q=&page=1');
  t.portal.state.expireSession = true;
  assert.ok((await t.client.getJson('/portal/meters/search?q=&page=1')).data.length);
  assert.equal(t.portal.state.logins, 2);
}));

test('transient 503s are retried then succeed', withPortal(async (t) => {
  await t.client.getJson('/portal/meters/search?q=&page=1');
  t.portal.state.failNext = 1;
  assert.ok((await t.client.getJson('/portal/meters/search?q=&page=1')).data);
  assert.equal(t.client.stats.retries, 1);
}));

// ------------------------------------------------------------------ bulk export
test('bulk export: signed request is accepted and every meter is loaded', withPortal(async (t) => {
  const res = await t.app.inject('/health');
  assert.equal(res.json().status, 'ok');
  const list = (await t.app.inject('/meters?pageSize=100')).json();
  assert.equal(list.source, 'export');
  assert.equal(list.total, 63);
}));

test('GET /meters filters: status, make and combined', withPortal(async (t) => {
  const faulty = (await t.app.inject('/meters?status=faulty&pageSize=100')).json();
  assert.ok(faulty.total > 0 && faulty.items.every((m) => m.installStatus === 'Faulty'));
  const combo = (await t.app.inject('/meters?status=Faulty&make=Genus&pageSize=100')).json();
  assert.ok(combo.items.every((m) => m.installStatus === 'Faulty' && m.make === 'Genus'));
  assert.equal((await t.app.inject('/meters?q=AL28136')).json().items[0].meterId, 'J100002');
}));

test('GET /meters near a point returns nearest first with distances', withPortal(async (t) => {
  const res = (await t.app.inject('/meters?lat=26.840224163401967&lng=75.71461868999545&radiusKm=1')).json();
  assert.equal(res.items[0].meterId, 'J100002');
  assert.ok(res.items[0].distanceKm < 0.001);
  assert.equal((await t.app.inject('/meters?lat=26.8')).statusCode, 400, 'lat without lng is rejected');
}));

test('when the bulk export is down, plain search falls back to the portal; filters report 502', withPortal(async (t) => {
  t.portal.state.breakExport = true;
  const fallback = await t.app.inject('/meters?q=j1000');
  assert.equal(fallback.statusCode, 200);
  assert.equal(fallback.json().source, 'live');
  assert.equal(fallback.json().total, 4);
  assert.equal((await t.app.inject('/meters?status=Faulty')).statusCode, 502);
}));

// ------------------------------------------------------------------ meter detail
test('GET /meters/:id comes from the snapshot with hierarchy and numeric location', withPortal(async (t) => {
  const m = (await t.app.inject('/meters/J100002')).json();
  assert.equal(m.source, 'export');
  assert.equal(m.make, 'L&T');
  assert.equal(m.build, 'legacy');
  assert.equal(typeof m.location.latitude, 'number');
  assert.equal(m.hierarchy.dt.code, 'DT-003');
}));

test('missing hierarchy codes are repaired from sibling meters and flagged', withPortal(async (t) => {
  const circle = (await t.app.inject('/meters/J100011')).json(); // export has circle name "Circle 6" but code ""
  assert.equal(circle.hierarchy.circle.code, 'C-06');
  assert.ok(circle.quality.flags.includes('hierarchy_code_repaired:circle'));
  const feeder = (await t.app.inject('/meters/J100044')).json();
  assert.equal(feeder.hierarchy.feeder.code, 'F-005');
}));

test('meter whose transformer name disagrees with the transformer list is flagged', withPortal(async (t) => {
  const m = (await t.app.inject('/meters/J100400')).json();
  assert.ok(m.quality.flags.includes('dt_name_mismatch'));
  assert.equal(m.hierarchy.dt.name, 'Sanganer DT 7');
}));

test('detail falls back to live per-meter calls when the snapshot is unavailable', withPortal(async (t) => {
  t.portal.state.breakExport = true;
  const m = (await t.app.inject('/meters/J100002')).json();
  assert.equal(m.source, 'live');
  assert.equal(m.hierarchy.zone.code, 'Z-03');
  assert.equal(m.location.latitude, 26.840224163401967);
}));

test('unknown meter is 404; malicious id is 400', withPortal(async (t) => {
  assert.equal((await t.app.inject('/meters/NOPE')).statusCode, 404);
  assert.equal((await t.app.inject('/meters/..%2Fadmin')).statusCode, 400);
}));

// ------------------------------------------------------------------ network
test('transformers: list, detail with meters, 404', withPortal(async (t) => {
  const list = (await t.app.inject('/transformers')).json();
  assert.equal(list.items.find((x) => x.code === 'DT-003').capacityKva, 250);
  const dt7 = (await t.app.inject('/transformers/dt-007')).json();
  assert.ok(dt7.meters.some((m) => m.meterId === 'J100400'));
  assert.equal(dt7.meterCount, dt7.meters.length);
  assert.equal((await t.app.inject('/transformers/DT-999')).statusCode, 404);
}));

test('hierarchy tree and data-quality report', withPortal(async (t) => {
  const tree = (await t.app.inject('/hierarchy')).json();
  assert.equal(tree.zones[0].level, 'zone');
  assert.equal(tree.zones.reduce((n, z) => n + z.meterCount, 0), 63);
  const dq = (await t.app.inject('/data-quality')).json();
  assert.ok(dq.summary.issuesByType.hierarchy_repaired >= 2);
  assert.ok(dq.summary.issuesByType.dt_name_mismatch >= 1);
}));

// ------------------------------------------------------------------ consumption
test('GET /meters/:id/consumption returns ISO timestamps, numbers and derived values', withPortal(async (t) => {
  const c = (await t.app.inject('/meters/J100002/consumption')).json();
  assert.equal(c.readings[0].timestamp, '2026-06-23T23:30:00+05:30');
  assert.equal(c.readings[1].intervalKwh, 0.46);
  assert.equal(c.summary.count, 5);
  const narrowed = await t.app.inject('/meters/J100002/consumption?from=2026-06-24T01:00:00%2B05:30');
  assert.equal(narrowed.json().summary.count, 2);
}));

test('cache: repeated requests do not hit the portal again', withPortal(async (t) => {
  await t.app.inject('/meters/J100002/consumption');
  const hits = t.portal.state.hits;
  await t.app.inject('/meters/J100002/consumption');
  await t.app.inject('/meters?q=j1');
  await t.app.inject('/meters?q=j2');
  assert.equal(t.portal.state.exportHits, 1, 'export fetched once for the whole run');
  assert.equal(t.portal.state.hits - hits, 3, 'only the first /meters call loads the snapshot: keys + export + dts, nothing after');
}));
