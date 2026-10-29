/**
 * Network hierarchy logic. Pure functions, no I/O.
 *
 * Things the data taught us (see PROTOCOL.md §4):
 *  - codes are only unique WITHIN a parent (division "D-01" appears under circles C-01, C-03 and C-05),
 *    so the tree must be keyed by path, never by code alone;
 *  - a few meters have a hierarchy node with a name but an empty code; their transformer's other meters
 *    agree on the real value, so we can repair it, and we record every repair.
 */
export const LEVELS = ['zone', 'circle', 'division', 'subdivision', 'substation', 'feeder', 'dt'];
const UPPER = LEVELS.slice(0, -1);

function groupBy(items, keyFn) {
  const map = new Map();
  for (const it of items) {
    const k = keyFn(it);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(it);
  }
  return map;
}

/**
 * Fills missing hierarchy codes/levels from the other meters on the same transformer. MUTATES `meters`.
 * Returns what it changed and any real disagreements it refused to "fix".
 */
export function repairHierarchies(meters) {
  const repairs = [];
  const conflicts = [];
  for (const [dtCode, group] of groupBy(meters, (m) => m.dtCode)) {
    for (const level of UPPER) {
      const known = group.map((m) => m.hierarchy[level]).filter((n) => n?.code);
      const codes = new Set(known.map((n) => n.code));
      if (codes.size > 1) conflicts.push({ dtCode, level, codes: [...codes] });
      const consensus = codes.size === 1 ? known[0] : null;

      const nameToCodes = new Map();
      for (const n of known) {
        if (!n.name) continue;
        if (!nameToCodes.has(n.name)) nameToCodes.set(n.name, new Set());
        nameToCodes.get(n.name).add(n.code);
      }

      for (const m of group) {
        const node = m.hierarchy[level];
        let fixed = null;
        if (!node) {
          if (consensus) fixed = { ...consensus };
        } else if (!node.code) {
          const byName = node.name ? nameToCodes.get(node.name) : null;
          const code = byName?.size === 1 ? [...byName][0] : consensus?.code ?? null;
          if (code) fixed = { name: node.name ?? consensus?.name ?? null, code };
        }
        if (fixed) {
          m.hierarchy[level] = fixed;
          repairs.push({ meterId: m.meterId, level, field: node ? 'code' : 'node', value: fixed.code, basis: `other meters on ${dtCode}` });
        }
      }
    }
  }
  return { repairs, conflicts };
}

const nodeKey = (n) => n?.code ?? (n?.name ? `name:${n.name}` : 'unknown');

/** Builds zone → … → dt with meter counts. `dts` is a Map of code → { name, capacityKva }. */
export function buildTree(meters, dts) {
  const roots = new Map();
  for (const m of meters) {
    let siblings = roots;
    for (const level of LEVELS) {
      const info = level === 'dt' ? dts.get(m.dtCode) : null;
      const n = level === 'dt' ? { code: m.dtCode, name: info?.name ?? m.hierarchy.dt?.name ?? null } : m.hierarchy[level];
      const key = nodeKey(n);
      let node = siblings.get(key);
      if (!node) {
        node = { level, code: n?.code ?? null, name: n?.name ?? null, meterCount: 0, statusCounts: {}, children: new Map() };
        if (level === 'dt') node.capacityKva = info?.capacityKva ?? null;
        siblings.set(key, node);
      }
      node.meterCount++;
      const st = m.installStatus ?? 'Unknown';
      node.statusCounts[st] = (node.statusCounts[st] ?? 0) + 1;
      siblings = node.children;
    }
  }
  const finish = (map) =>
    [...map.values()]
      .sort((a, b) => String(a.code ?? a.name).localeCompare(String(b.code ?? b.name)))
      .map((n) => ({ ...n, children: finish(n.children) }));
  return finish(roots);
}
