import { PortalError, ValidationError } from '../errors.js';
import { parseEnergy, parseGeo, parseMeterData, parseSearch } from '../portal/parsers.js';
import { filterMeters, paginate, toSummary } from '../domain/query.js';

const METER_ID = /^[A-Za-z0-9_-]{1,32}$/; // stops path tricks like "../" before we put the id in a URL
const round = (n, dp = 3) => Number(n.toFixed(dp));

export function assertMeterId(id) {
  if (!METER_ID.test(id ?? '')) throw new ValidationError('meterId must be 1-32 characters: letters, digits, "-" or "_"');
  return id;
}

/** Turns cumulative register readings into per-interval consumption and a summary. Pure, so it is unit-tested. */
export function buildConsumption(readings, { from, to } = {}) {
  const lo = from ? Date.parse(from) : -Infinity;
  const hi = to ? Date.parse(to) : Infinity;
  const inWindow = readings.filter((r) => {
    const t = Date.parse(r.timestamp);
    return t >= lo && t <= hi;
  });

  let counterResets = 0;
  const rows = inWindow.map((r, i) => {
    const prev = inWindow[i - 1];
    let intervalKwh = null;
    if (prev) {
      const d = r.kwh - prev.kwh;
      if (d < 0) counterResets++; // register went backwards (meter replaced/reset): delta is meaningless
      else intervalKwh = round(d);
    }
    return { ...r, intervalKwh };
  });

  const first = rows[0];
  const last = rows.at(-1);
  // Resolution differs per meter (30-minute for some, daily for others), so measure it instead of assuming it.
  const gaps = rows.slice(1).map((r, i) => (Date.parse(r.timestamp) - Date.parse(rows[i].timestamp)) / 60000).sort((a, b) => a - b);
  const intervalMinutes = gaps.length ? gaps[Math.floor(gaps.length / 2)] : null; // median gap
  const volts = rows.map((r) => r.voltageR).filter((v) => v !== null);
  const totalKwh = first && last && counterResets === 0 ? round(last.kwh - first.kwh) : null;
  const totalKvah = first && last && counterResets === 0 && first.kvah !== null && last.kvah !== null ? round(last.kvah - first.kvah) : null;

  return {
    readings: rows,
    summary: {
      count: rows.length,
      intervalMinutes,
      from: first?.timestamp ?? null,
      to: last?.timestamp ?? null,
      totalKwh,
      totalKvah,
      // Power factor = real energy / apparent energy over the window.
      powerFactor: totalKwh !== null && totalKvah ? round(totalKwh / totalKvah, 3) : null,
      voltageR: volts.length ? { min: Math.min(...volts), max: Math.max(...volts), avg: round(volts.reduce((a, b) => a + b, 0) / volts.length, 1) } : null,
      counterResets,
    },
  };
}

const MAX_PAGE_SIZE = 100;

export function createMeterService({ client, cache, config, dataset }) {
  const { ttl, utcOffset } = config;
  const enc = encodeURIComponent;

  const rawEnergy = (id) =>
    cache.get(`energy:${id}`, ttl.energyMs, async () => parseEnergy(await client.getJson(`/portal/meters/${enc(id)}/energy`), { utcOffset }));
  const rawGeo = (id) =>
    cache.get(`geo:${id}`, ttl.geoMs, async () => parseGeo(await client.getJson(`/portal/meters/${enc(id)}/geo`)));
  const rawDetail = (id) =>
    cache.get(`detail:${id}`, ttl.meterMs, async () => parseMeterData(await client.getJson(`/meters/${enc(id)}/__data.json`)));

  /** Original per-meter path (3 portal calls). Used when the bulk snapshot is unavailable or lacks the meter. */
  async function getMeterLive(id) {
    // Detail is essential; geo is a nice-to-have, so its failure degrades the response instead of failing it.
    const [detail, geo] = await Promise.allSettled([rawDetail(id), rawGeo(id)]);
    if (detail.status === 'rejected') throw detail.reason;
    const warnings = [];
    let location = null;
    if (geo.status === 'fulfilled') {
      location = geo.value;
      if (!location) warnings.push('Portal returned no usable coordinates for this meter');
    } else if (geo.reason instanceof PortalError && geo.reason.kind === 'not_found') {
      warnings.push('Portal has no location for this meter');
    } else {
      warnings.push(`Location unavailable: ${geo.reason.message}`);
    }
    return { ...detail.value, build: null, dtCode: detail.value.hierarchy.dt?.code ?? null, location, quality: { flags: [] }, source: 'live', warnings };
  }

  const snapshotOrNull = () => dataset.get().catch(() => null);

  return {
    /** Filterable list served from the local index; falls back to the portal's own search if the index cannot load. */
    async listMeters({ page = 1, pageSize = 20, lat, lng, radiusKm = 5, ...filters }) {
      if ((lat === undefined) !== (lng === undefined)) throw new ValidationError('lat and lng must be given together');
      if (pageSize > MAX_PAGE_SIZE) throw new ValidationError(`pageSize may not exceed ${MAX_PAGE_SIZE}`);
      const near = lat !== undefined ? { latitude: lat, longitude: lng, radiusKm } : null;

      const snap = await snapshotOrNull();
      if (snap) {
        const matches = filterMeters(snap.meters, { ...filters, near });
        const result = paginate(matches, page, pageSize);
        return { ...result, items: result.items.map((m) => ({ ...toSummary(m), ...(m.distanceKm !== undefined && { distanceKm: m.distanceKm }) })), source: 'export' };
      }
      const onlySearch = !near && Object.keys(filters).every((k) => k === 'q' || filters[k] === undefined);
      if (!onlySearch) throw new PortalError('Bulk data is unavailable and these filters need it', { kind: 'unavailable' });
      const live = await cache.get(`search:${(filters.q ?? '').toLowerCase()}:${page}`, ttl.searchMs, async () =>
        parseSearch(await client.getJson(`/portal/meters/search?q=${enc(filters.q ?? '')}&page=${page}`)));
      return { ...live, source: 'live' };
    },

    async getMeter(id) {
      assertMeterId(id);
      const snap = await snapshotOrNull();
      const rec = snap?.byId.get(id);
      if (rec) return { ...rec, extraParameters: {}, source: 'export', warnings: [] };
      return getMeterLive(id);
    },

    async getConsumption(id, { from, to } = {}) {
      assertMeterId(id);
      const { readings, skipped } = await rawEnergy(id);
      return { meterId: id, ...buildConsumption(readings, { from, to }), skippedRows: skipped };
    },

    async listTransformers({ zone, feeder } = {}) {
      const snap = await dataset.get();
      const ci = (a, b) => String(a ?? '').toLowerCase() === String(b).toLowerCase();
      const items = snap.transformers.filter((t) => (!zone || ci(t.hierarchy.zone?.code, zone)) && (!feeder || ci(t.hierarchy.feeder?.code, feeder)));
      return { items, total: items.length };
    },

    async getTransformer(code) {
      const snap = await dataset.get();
      const t = snap.transformerByCode.get(code.toUpperCase());
      if (!t) throw new PortalError(`Transformer ${code} not found`, { kind: 'not_found', status: 404 });
      return { ...t, meters: snap.meters.filter((m) => m.dtCode === t.code).map(toSummary) };
    },

    async getHierarchy() {
      return { generatedAt: new Date((await dataset.get()).loadedAt).toISOString(), zones: (await dataset.get()).tree };
    },

    status: () => dataset.status(),

    async getDataQuality() {
      return (await dataset.get()).quality;
    },
  };
}
