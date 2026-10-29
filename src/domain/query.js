/** In-memory filtering for the local meter index. Linear scan; see README for when that stops being enough. */
const EARTH_RADIUS_KM = 6371;
const rad = (d) => (d * Math.PI) / 180;

export function haversineKm(a, b) {
  const dLat = rad(b.latitude - a.latitude);
  const dLon = rad(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
}

const same = (a, b) => String(a ?? '').toLowerCase() === String(b).toLowerCase();

export function toSummary(m) {
  const { meterId, serialNo, make, phaseType, installStatus, installationType, build, dtCode, location } = m;
  return { meterId, serialNo, make, phaseType, installStatus, installationType, build, dtCode, location };
}

/** `f.near` = { latitude, longitude, radiusKm }. With `near`, results are sorted nearest-first. */
export function filterMeters(meters, f = {}) {
  const q = f.q?.trim().toLowerCase();
  let out = meters.filter((m) => {
    if (q && !m.meterId.toLowerCase().includes(q) && !(m.serialNo ?? '').toLowerCase().includes(q)) return false;
    if (f.status && !same(m.installStatus, f.status)) return false;
    if (f.make && !same(m.make, f.make)) return false;
    if (f.phase && !same(m.phaseType, f.phase)) return false;
    if (f.build && !same(m.build, f.build)) return false;
    if (f.installationType && !same(m.installationType, f.installationType)) return false;
    if (f.dtCode && !same(m.dtCode, f.dtCode)) return false;
    if (f.feeder && !same(m.hierarchy.feeder?.code, f.feeder)) return false;
    if (f.zone && !same(m.hierarchy.zone?.code, f.zone)) return false;
    return true;
  });

  if (f.near) {
    out = out
      .filter((m) => m.location)
      .map((m) => ({ ...m, distanceKm: Number(haversineKm(f.near, m.location).toFixed(3)) }))
      .filter((m) => m.distanceKm <= f.near.radiusKm)
      .sort((a, b) => a.distanceKm - b.distanceKm);
  }
  return out;
}

export function paginate(items, page, pageSize) {
  const start = (page - 1) * pageSize;
  return { items: items.slice(start, start + pageSize), total: items.length, page, pageSize };
}
