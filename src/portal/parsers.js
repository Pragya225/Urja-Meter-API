import { unflatten } from 'devalue';
import { PortalError } from '../errors.js';

/**
 * Parsers turn the portal's quirky payloads into clean, typed objects.
 * They are pure functions (no network) so they are easy to test against captured responses.
 */

const bad = (msg) => new PortalError(msg, { kind: 'bad_response' });

/** The portal sends every number as a string. Returns null for empty/garbage instead of NaN. */
export function toNumber(v) {
  if (v === null || v === undefined || String(v).trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Portal timestamps look like "23/06/2026 23:30" (DD/MM/YYYY HH:mm, no timezone).
 * A date alone ("23/06/2026") is accepted too and means midnight, in case a coarser-resolution meter omits the time.
 * We assume the utility's local time and emit ISO 8601 with an explicit offset.
 * Returns null if the string is not a real date.
 */
export function parsePortalTimestamp(raw, utcOffset = '+05:30') {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})(?: (\d{2}):(\d{2}))?$/.exec(String(raw ?? '').trim());
  if (!m) return null;
  const [, dd, mm, yyyy, hh = '00', mi = '00'] = m;
  const check = new Date(Date.UTC(+yyyy, +mm - 1, +dd, +hh, +mi));
  const valid =
    check.getUTCFullYear() === +yyyy && check.getUTCMonth() === +mm - 1 && check.getUTCDate() === +dd &&
    +hh < 24 && +mi < 60;
  return valid ? `${yyyy}-${mm}-${dd}T${hh}:${mi}:00${utcOffset}` : null;
}

// ---------------------------------------------------------------- search list
export function parseSearch(body) {
  if (!body || !Array.isArray(body.data)) throw bad('Unexpected search response shape');
  return {
    items: body.data.map((m) => ({
      meterId: String(m.meterId),
      serialNo: m.serialNo ?? null,
      make: m.make ?? null,
      phaseType: m.phaseType ?? null,
      installStatus: m.installStatus ?? null,
      dtCode: m.dtCode ?? null,
    })),
    total: Number(body.total) || 0,
    page: Number(body.page) || 1,
    pageSize: Number(body.pageSize) || body.data.length,
  };
}

// ------------------------------------------------------------------------ geo
export function parseGeo(body) {
  const lat = toNumber(body?.data?.latitude);
  const lon = toNumber(body?.data?.longitude);
  const inRange = lat !== null && lon !== null && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
  return inRange ? { latitude: lat, longitude: lon } : null;
}

// --------------------------------------------------------------------- energy
/**
 * Raw rows: { timestamp, kwh, kvah, voltR } all strings.
 * Rows we cannot understand are dropped and counted rather than failing the whole response.
 */
export function parseEnergy(body, { utcOffset = '+05:30' } = {}) {
  if (!body || !Array.isArray(body.data)) throw bad('Unexpected energy response shape');
  const readings = [];
  let skipped = 0;
  for (const row of body.data) {
    const timestamp = parsePortalTimestamp(row.timestamp, utcOffset);
    const kwh = toNumber(row.kwh);
    if (!timestamp || kwh === null) {
      skipped++;
      continue;
    }
    readings.push({ timestamp, kwh, kvah: toNumber(row.kvah), voltageR: toNumber(row.voltR) });
  }
  readings.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp)); // don't trust portal ordering
  return { readings, skipped };
}

// ------------------------------------------------------------- meter __data.json
const NAMEPLATE_FIELDS = {
  'Meter ID': 'meterId',
  'Serial No': 'serialNo',
  'Make': 'make',
  'Phase Type': 'phaseType',
  'Installation Status': 'installStatus',
  'Installation Type': 'installationType',
};

const HIERARCHY_LEVELS = [
  ['Zone', 'zone'],
  ['Circle', 'circle'],
  ['Division', 'division'],
  ['Subdivision', 'subdivision'],
  ['Sub Station', 'substation'],
  ['Feeder', 'feeder'],
  ['DT', 'dt'],
];

/** "Vaishali DT 3 (DT-003)" -> { name: "Vaishali DT 3", code: "DT-003" } */
export function splitNameAndCode(label) {
  if (label === null || label === undefined || String(label).trim() === '') return null;
  const m = /^(.*?)\s*\(([^()]+)\)\s*$/.exec(String(label));
  return m ? { name: m[1].trim(), code: m[2].trim() } : { name: String(label).trim(), code: null };
}

/**
 * SvelteKit serialises page data with `devalue` (a flat array where numbers are
 * pointers to other array slots). `unflatten` rebuilds the real object.
 * The meter page's data node looks like { meterId, detail:{data:[{parameterName,parameterValue}...]}, hierarchy:{...} }.
 */
export function parseMeterData(body) {
  const nodes = body?.nodes;
  if (!Array.isArray(nodes)) throw bad('Unexpected __data.json shape');

  for (const node of nodes) {
    if (node?.type === 'error') {
      const status = node.status ?? 500;
      throw new PortalError(`Portal page error (${status})`, { kind: status === 404 ? 'not_found' : 'bad_response', status });
    }
  }

  let page = null;
  for (const node of nodes) {
    if (node?.type !== 'data' || !Array.isArray(node.data)) continue;
    let decoded;
    try {
      decoded = unflatten(node.data);
    } catch {
      continue;
    }
    if (decoded && typeof decoded === 'object' && 'detail' in decoded) page = decoded; // the layout node holds {user}, the page node holds {detail}
  }
  if (!page) throw bad('Meter page data not found in __data.json');

  const nameplate = {};
  const extra = {}; // unknown parameters are kept, never silently dropped
  for (const p of page.detail?.data ?? []) {
    const key = NAMEPLATE_FIELDS[p?.parameterName];
    if (key) nameplate[key] = p.parameterValue ?? null;
    else if (p?.parameterName) extra[p.parameterName] = p.parameterValue ?? null;
  }

  const hierarchy = {};
  for (const [label, key] of HIERARCHY_LEVELS) hierarchy[key] = splitNameAndCode(page.hierarchy?.[label]);

  return {
    meterId: nameplate.meterId ?? page.meterId ?? null,
    serialNo: nameplate.serialNo ?? null,
    make: nameplate.make ?? null,
    phaseType: nameplate.phaseType ?? null,
    installStatus: nameplate.installStatus ?? null,
    installationType: nameplate.installationType ?? null,
    hierarchy,
    extraParameters: extra,
  };
}

// ---------------------------------------------------------------- bulk export
const LEVEL_KEYS = ['zone', 'circle', 'division', 'subdivision', 'substation', 'feeder', 'dt'];

/** The export sometimes has a node with a name but an EMPTY code (""); we turn that into code:null so the gap is explicit. */
function exportNode(n) {
  if (!n || (!n.name && !n.code)) return null;
  return { name: n.name || null, code: n.code || null };
}

function exportLocation(geo) {
  const latitude = toNumber(geo?.lat);
  const longitude = toNumber(geo?.lng);
  const ok = latitude !== null && longitude !== null && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180;
  return ok ? { latitude, longitude } : null;
}

/** One meter record from /portal/export, mapped to the same field names the rest of our API uses. */
export function parseExportMeter(raw) {
  const hierarchy = {};
  for (const key of LEVEL_KEYS) hierarchy[key] = exportNode(raw.hierarchy?.[key]);
  return {
    meterId: String(raw.meterId),
    serialNo: raw.serialNo ?? null,
    make: raw.make ?? null,
    phaseType: raw.phaseType ?? null,
    installStatus: raw.installStatus ?? null,
    installationType: raw.installType ?? null, // the export calls it installType, the detail page "Installation Type"
    build: raw.build ?? null,
    dtCode: raw.dtCode ?? raw.hierarchy?.dt?.code ?? null,
    location: exportLocation(raw.geo),
    hierarchy,
  };
}

/** Accepts either {data:[...], total} (what the portal sends) or a bare array (what the browser saves to disk). */
export function parseExport(body) {
  const rows = Array.isArray(body) ? body : body?.data;
  if (!Array.isArray(rows)) throw bad('Unexpected export response shape');
  const meters = rows.filter((r) => r && r.meterId).map(parseExportMeter);
  return { meters, total: Number(body?.total) || rows.length, dropped: rows.length - meters.length };
}

// -------------------------------------------------------------- transformers
export function parseDts(body) {
  if (!body || !Array.isArray(body.data)) throw bad('Unexpected transformers response shape');
  return {
    items: body.data.map((d) => ({
      code: String(d.code),
      name: d.name ?? null,
      feederCode: d.feederCode ?? null,
      capacityKva: toNumber(d.capacityKva), // a real number here, unlike the string numbers elsewhere
    })),
    total: Number(body.total) || body.data.length,
    page: Number(body.page) || 1,
    pageSize: Number(body.pageSize) || body.data.length,
  };
}
