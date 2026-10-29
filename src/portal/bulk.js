import { createHmac } from 'node:crypto';
import { PortalError } from '../errors.js';
import { parseDts, parseExport } from './parsers.js';

/**
 * /portal/export is protected by a request signature (reverse-engineered, see PROTOCOL.md §3.6):
 *   x-timestamp: unix seconds
 *   x-signature: hex( HMAC-SHA256( signingSecret, "GET\n<path>\n<query>\n<timestamp>" ) )
 * where signingSecret is handed to any logged-in user by GET /portal/keys.
 */
export function sign({ secret, path, query, timestamp, method = 'GET' }) {
  return createHmac('sha256', secret).update([method, path, query, String(timestamp)].join('\n')).digest('hex');
}

const MAX_PAGES = 50; // safety net against a portal that never says "done"

export function createBulkLoader(client, { keyTtlMs = 10 * 60 * 1000, now = () => Date.now() } = {}) {
  let key = null;
  let keyAt = 0;

  async function getKey(force) {
    if (!force && key && now() - keyAt < keyTtlMs) return key;
    const body = await client.getJson('/portal/keys');
    const secret = body?.data?.signingSecret;
    if (!secret) throw new PortalError('Portal did not return a signing secret', { kind: 'bad_response' });
    key = secret;
    keyAt = now();
    return key;
  }

  /** Signed GET. If the portal rejects the signature we refresh the key once (it may have rotated) and retry. */
  async function signedGet(path, query) {
    for (let attempt = 0; ; attempt++) {
      const secret = await getKey(attempt > 0);
      const timestamp = Math.floor(now() / 1000);
      const signature = sign({ secret, path, query, timestamp });
      try {
        return await client.getJson(`${path}?${query}`, { headers: { 'x-signature': signature, 'x-timestamp': String(timestamp) } });
      } catch (err) {
        if (err instanceof PortalError && err.kind === 'auth' && attempt === 0) continue;
        throw err;
      }
    }
  }

  return {
    /** Every meter in the portal (nameplate + hierarchy + location) via the bulk export. */
    async fetchAllMeters() {
      const meters = [];
      let dropped = 0;
      let total = 0;
      for (let page = 1; page <= MAX_PAGES; page++) {
        const parsed = parseExport(await signedGet('/portal/export', `page=${page}`));
        meters.push(...parsed.meters);
        dropped += parsed.dropped;
        total = parsed.total;
        if (parsed.meters.length === 0 || meters.length + dropped >= total) break;
      }
      return { meters, total, dropped };
    },

    /** Every transformer, following pages until `total` is reached. */
    async fetchAllDts() {
      const items = [];
      for (let page = 1; page <= MAX_PAGES; page++) {
        const parsed = parseDts(await client.getJson(`/portal/dts?page=${page}`));
        items.push(...parsed.items);
        if (parsed.items.length === 0 || items.length >= parsed.total) break;
      }
      return items;
    },
  };
}
