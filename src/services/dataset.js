import { LEVELS, buildTree, repairHierarchies } from '../domain/hierarchy.js';

const count = (items, keyFn) => items.reduce((acc, it) => ((acc[keyFn(it)] = (acc[keyFn(it)] ?? 0) + 1), acc), {});

/** Pure: raw meters + transformer list -> an immutable, query-ready snapshot with a data-quality report. */
export function buildSnapshot({ meters, dts, total, dropped = 0 }, loadedAt = Date.now()) {
  const dtByCode = new Map(dts.map((d) => [d.code, d]));
  const { repairs, conflicts } = repairHierarchies(meters);
  const issues = [];
  const flagsByMeter = new Map();
  const flag = (meterId, f) => flagsByMeter.set(meterId, [...(flagsByMeter.get(meterId) ?? []), f]);

  for (const r of repairs) {
    flag(r.meterId, `hierarchy_${r.field}_repaired:${r.level}`);
    issues.push({ type: 'hierarchy_repaired', severity: 'info', meterId: r.meterId, level: r.level, repairedTo: r.value, basis: r.basis });
  }
  for (const c of conflicts) issues.push({ type: 'hierarchy_conflict', severity: 'warning', ...c, detail: 'meters on this transformer disagree; left as reported' });

  const seenNameMismatch = new Map();
  for (const m of meters) {
    const official = dtByCode.get(m.dtCode);
    if (!official) {
      flag(m.meterId, 'dt_not_in_transformer_list');
      issues.push({ type: 'dt_not_in_transformer_list', severity: 'warning', meterId: m.meterId, dtCode: m.dtCode });
    } else if (m.hierarchy.dt?.name && m.hierarchy.dt.name !== official.name) {
      flag(m.meterId, 'dt_name_mismatch');
      const key = `${m.dtCode}|${m.hierarchy.dt.name}`;
      if (!seenNameMismatch.has(key)) seenNameMismatch.set(key, { meterIds: [], dtCode: m.dtCode, reportedName: m.hierarchy.dt.name, officialName: official.name });
      seenNameMismatch.get(key).meterIds.push(m.meterId);
    }
    if (official) m.hierarchy.dt = { name: official.name, code: official.code }; // transformer list is the authority for DT names
    if (!m.location) {
      flag(m.meterId, 'missing_location');
      issues.push({ type: 'missing_location', severity: 'warning', meterId: m.meterId });
    }
  }
  for (const v of seenNameMismatch.values())
    issues.push({ type: 'dt_name_mismatch', severity: 'warning', ...v, detail: 'meters report a different transformer name than the transformer list; list name used' });

  for (const m of meters) m.quality = { flags: flagsByMeter.get(m.meterId) ?? [] };
  meters.sort((a, b) => a.meterId.localeCompare(b.meterId));

  // transformer records
  const byDt = new Map();
  for (const m of meters) {
    if (!byDt.has(m.dtCode)) byDt.set(m.dtCode, []);
    byDt.get(m.dtCode).push(m);
  }
  const transformers = dts.map((d) => {
    const group = byDt.get(d.code) ?? [];
    const hierarchy = {};
    for (const level of LEVELS.slice(0, -1)) hierarchy[level] = group.map((m) => m.hierarchy[level]).find((n) => n?.code) ?? null;
    hierarchy.dt = { name: d.name, code: d.code };
    if (!group.length) issues.push({ type: 'dt_without_meters', severity: 'info', dtCode: d.code, detail: 'hierarchy is only known via meters, so it cannot be placed in the tree' });
    return { ...d, hierarchy, meterCount: group.length, statusCounts: count(group, (m) => m.installStatus ?? 'Unknown') };
  });

  // The portal reuses level codes under different parents; report it once so nobody builds a tree keyed by code alone.
  const reuse = {};
  for (const level of LEVELS.slice(1, -1)) {
    const parents = new Map();
    for (const m of meters) {
      const n = m.hierarchy[level];
      const p = m.hierarchy[LEVELS[LEVELS.indexOf(level) - 1]];
      if (!n?.code || !p?.code) continue;
      if (!parents.has(n.code)) parents.set(n.code, new Set());
      parents.get(n.code).add(p.code);
    }
    reuse[level] = [...parents.values()].filter((s) => s.size > 1).length;
  }

  const byType = count(issues, (i) => i.type);
  return {
    loadedAt,
    meters,
    byId: new Map(meters.map((m) => [m.meterId, m])),
    transformers,
    transformerByCode: new Map(transformers.map((t) => [t.code, t])),
    tree: buildTree(meters, dtByCode),
    quality: {
      generatedAt: new Date(loadedAt).toISOString(),
      summary: { meters: meters.length, transformers: transformers.length, issuesByType: byType, exportTotalReported: total, exportRowsDropped: dropped, codesReusedAcrossParents: reuse },
      issues,
    },
  };
}

/**
 * Holds the current snapshot in memory.
 *  - first call waits for the bulk load;
 *  - once data is older than `ttlMs`, the NEXT call still answers instantly from the old snapshot
 *    and refreshes in the background (stale-while-revalidate), so a slow/down portal never blocks reads;
 *  - a failed refresh keeps the old data and is reported by status().
 */
export function createDataset({ loader, ttlMs = 15 * 60 * 1000, now = () => Date.now() }) {
  let snapshot = null;
  let loading = null;
  let lastError = null;

  const load = () => {
    loading ??= (async () => {
      const [{ meters, total, dropped }, dts] = await Promise.all([loader.fetchAllMeters(), loader.fetchAllDts()]);
      snapshot = buildSnapshot({ meters, dts, total, dropped }, now());
      lastError = null;
    })()
      .catch((err) => {
        lastError = err.message;
        if (!snapshot) throw err; // nothing to fall back on
      })
      .finally(() => (loading = null));
    return loading;
  };

  return {
    async get() {
      if (!snapshot) {
        await load();
      } else if (now() - snapshot.loadedAt > ttlMs) {
        load(); // background refresh, errors recorded in lastError
      }
      return snapshot;
    },
    status() {
      return {
        loaded: Boolean(snapshot),
        loadedAt: snapshot ? new Date(snapshot.loadedAt).toISOString() : null,
        meters: snapshot?.meters.length ?? 0,
        stale: snapshot ? now() - snapshot.loadedAt > ttlMs : null,
        lastError,
      };
    },
  };
}
