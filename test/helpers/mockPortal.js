import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { sign } from '../../src/portal/bulk.js';

export const TEST_SECRET = 'test-signing-secret';

const fx = (name) => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8');

/**
 * A tiny fake of the Urja portal, built from responses captured from the real one.
 * Behaviour knobs let tests simulate session expiry, outages and slow responses.
 */
export async function startMockPortal({ sessionMaxAge = 3600 } = {}) {
  const state = { logins: 0, hits: 0, exportHits: 0, validCookie: null, failNext: 0, expireSession: false, breakExport: false, requests: [] };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    state.requests.push(`${req.method} ${url.pathname}`);

    if (req.method === 'POST' && url.pathname === '/login') {
      let body = '';
      for await (const c of req) body += c;
      const form = new URLSearchParams(body);
      if (form.get('email') !== 'operator@urja.local' || form.get('password') !== 'urja-ops-2026' || req.headers['x-sveltekit-action'] !== 'true') {
        res.setHeader('content-type', 'application/json');
        return res.end(JSON.stringify({ type: 'failure', status: 400 }));
      }
      state.logins++;
      state.validCookie = `__Secure-better-auth.session_token=tok${state.logins}`;
      res.setHeader('set-cookie', `${state.validCookie}; Max-Age=${sessionMaxAge}; Path=/; HttpOnly; Secure; SameSite=Lax`);
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({ type: 'redirect', status: 303, location: '/meters' }));
    }

    // everything else needs the cookie
    if (state.expireSession) { state.validCookie = null; state.expireSession = false; }
    if (!state.validCookie || req.headers.cookie !== state.validCookie) {
      res.statusCode = 303;
      res.setHeader('location', '/login');
      return res.end();
    }
    state.hits++;
    if (state.failNext > 0) { state.failNext--; res.statusCode = 503; return res.end('busy'); }

    res.setHeader('content-type', 'application/json');
    if (url.pathname === '/portal/keys') return res.end(JSON.stringify({ data: { signingSecret: TEST_SECRET } }));
    if (url.pathname === '/portal/dts') return res.end(fx('dts-page1.json'));
    if (url.pathname === '/portal/export') {
      state.exportHits++;
      if (state.breakExport) { res.statusCode = 500; return res.end('boom'); }
      const ts = Number(req.headers['x-timestamp']);
      const expected = sign({ secret: TEST_SECRET, path: url.pathname, query: url.search.slice(1), timestamp: ts });
      if (!ts || Math.abs(Date.now() / 1000 - ts) > 300 || req.headers['x-signature'] !== expected) { res.statusCode = 403; return res.end('{"error":"bad signature"}'); }
      if (url.searchParams.get('page') !== '1') return res.end('{"data":[],"total":63}');
      return res.end(fx('export-sample.json'));
    }
    if (url.pathname === '/portal/meters/search') return res.end(fx('search-q-j10000.json'));
    if (url.pathname === '/meters/J100002/__data.json') return res.end(fx('meter-J100002.data.json'));
    if (url.pathname === '/portal/meters/J100002/geo') return res.end('{"data":{"latitude":"26.840224163401967","longitude":"75.71461868999545"}}');
    if (url.pathname === '/portal/meters/J100002/energy') return res.end(fx('energy-J100002.sample.json'));
    res.statusCode = 404;
    res.end('{"message":"not found"}');
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return { baseUrl, state, close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }) };
}
