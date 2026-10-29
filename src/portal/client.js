import { PortalError } from '../errors.js';

const SESSION_COOKIE_HINT = 'session_token'; // better-auth cookie: __Secure-better-auth.session_token
const SESSION_SAFETY_MARGIN_MS = 60_000; // re-login a minute before the portal expires us
const DEFAULT_SESSION_TTL_MS = 3_600_000; // portal sends Max-Age=3600

class Semaphore {
  constructor(max) {
    this.max = max;
    this.active = 0;
    this.queue = [];
  }
  async run(fn) {
    if (this.active >= this.max) await new Promise((resolve) => this.queue.push(resolve));
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * HTTP client for the Urja Meter Ops portal.
 *
 * Responsibilities (and nothing more):
 *  - log in with the form POST the browser uses and keep the session cookie
 *  - transparently re-login when the session expires (1h) or the portal drops it
 *  - cap concurrency, apply timeouts, retry transient failures with backoff
 *  - hand back parsed JSON; knowing what the JSON means is the parsers' job
 */
export class PortalClient {
  constructor({
    baseUrl,
    email,
    password,
    timeoutMs = 10_000,
    maxConcurrent = 4,
    maxRetries = 2,
    retryBaseMs = 300,
    fetchImpl = fetch,
  }) {
    Object.assign(this, { baseUrl, email, password, timeoutMs, maxRetries, retryBaseMs, fetchImpl });
    this.limiter = new Semaphore(maxConcurrent);
    this.cookie = null;
    this.expiresAt = 0;
    this.loginPromise = null; // shared so N parallel requests cause ONE login
    this.stats = { logins: 0, relogins: 0, retries: 0 };
  }

  /** GET a path and return parsed JSON. `headers` are extra request headers (used for signed calls). */
  async getJson(path, { headers = {} } = {}) {
    return this.limiter.run(() => this.#getWithRecovery(path, headers));
  }

  async #getWithRecovery(path, extraHeaders) {
    let reloggedIn = false;
    for (let attempt = 0; ; attempt++) {
      await this.#ensureSession();
      let res;
      try {
        res = await this.#fetch(path, { headers: { ...extraHeaders, cookie: this.cookie, accept: 'application/json' } });
      } catch (err) {
        if (attempt < this.maxRetries) {
          this.stats.retries++;
          await sleep(this.retryBaseMs * 2 ** attempt);
          continue;
        }
        const timedOut = err.name === 'TimeoutError' || err.name === 'AbortError';
        throw new PortalError(timedOut ? 'Portal timed out' : `Portal unreachable: ${err.message}`, {
          kind: timedOut ? 'timeout' : 'unavailable',
        });
      }

      if (this.#looksLikeLoggedOut(res)) {
        // Session expired/invalidated server side. Re-login once, then retry the same request.
        if (reloggedIn) throw new PortalError('Portal keeps rejecting our session', { kind: 'auth', status: res.status });
        reloggedIn = true;
        this.stats.relogins++;
        this.cookie = null;
        attempt--; // a re-login is not a "retry"
        continue;
      }
      if (res.status === 404) throw new PortalError(`Not found: ${path}`, { kind: 'not_found', status: 404 });
      if (res.status === 429 || res.status >= 500) {
        if (attempt < this.maxRetries) {
          this.stats.retries++;
          const retryAfter = Number(res.headers.get('retry-after'));
          await sleep(retryAfter > 0 ? retryAfter * 1000 : this.retryBaseMs * 2 ** attempt);
          continue;
        }
        throw new PortalError(`Portal returned ${res.status}`, { kind: 'unavailable', status: res.status });
      }
      if (!res.ok) throw new PortalError(`Portal returned ${res.status} for ${path}`, { kind: 'bad_response', status: res.status });

      try {
        return await res.json();
      } catch {
        // 200 with HTML usually means we were bounced to the login page without a redirect status.
        if (!reloggedIn) {
          reloggedIn = true;
          this.stats.relogins++;
          this.cookie = null;
          attempt--;
          continue;
        }
        throw new PortalError(`Portal returned non-JSON for ${path}`, { kind: 'bad_response', status: res.status });
      }
    }
  }

  /** 401/403, or a redirect to /login, means "not logged in". */
  #looksLikeLoggedOut(res) {
    if (res.status === 401 || res.status === 403) return true;
    if (res.status >= 300 && res.status < 400) return (res.headers.get('location') ?? '').includes('/login');
    return false;
  }

  async #ensureSession() {
    if (this.cookie && Date.now() < this.expiresAt - SESSION_SAFETY_MARGIN_MS) return;
    this.loginPromise ??= this.#login().finally(() => (this.loginPromise = null));
    await this.loginPromise;
  }

  /**
   * Mirrors the browser: POST /login as x-www-form-urlencoded with the SvelteKit
   * form-action header. Success is a JSON {type:'redirect'} plus a Set-Cookie.
   */
  async #login() {
    this.stats.logins++;
    let res;
    try {
      res = await this.#fetch('/login', {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/x-www-form-urlencoded',
          origin: this.baseUrl, // SvelteKit rejects cross-origin form posts, so the Origin header must match
          'x-sveltekit-action': 'true',
        },
        body: new URLSearchParams({ email: this.email, password: this.password }).toString(),
      });
    } catch (err) {
      throw new PortalError(`Portal login unreachable: ${err.message}`, { kind: 'unavailable' });
    }

    const body = await res.json().catch(() => null);
    if (!body || body.type === 'failure' || body.type === 'error') {
      throw new PortalError('Portal rejected the configured credentials', { kind: 'auth', status: res.status });
    }
    const setCookie = res.headers.getSetCookie?.() ?? [];
    const raw = setCookie.find((c) => c.includes(SESSION_COOKIE_HINT));
    if (!raw) throw new PortalError('Login succeeded but no session cookie was issued', { kind: 'auth', status: res.status });

    this.cookie = raw.split(';')[0]; // keep the value exactly as issued (it is already URL-encoded)
    const maxAge = Number(/max-age=(\d+)/i.exec(raw)?.[1]);
    this.expiresAt = Date.now() + (maxAge > 0 ? maxAge * 1000 : DEFAULT_SESSION_TTL_MS);
  }

  #fetch(path, init = {}) {
    return this.fetchImpl(this.baseUrl + path, {
      redirect: 'manual', // we want to SEE a redirect to /login, not silently follow it
      signal: AbortSignal.timeout(this.timeoutMs),
      ...init,
    });
  }
}
