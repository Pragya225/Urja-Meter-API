# Urja Meter Ops API

A clean, documented REST API in front of the legacy **Urja Meter Ops** portal, which has no API of its own.

- How the portal works, with every quirk I found → [PROTOCOL.md](./PROTOCOL.md)
- API description → [openapi.json](./openapi.json); interactive docs at <http://localhost:3000/docs> when running

## Endpoints

| Endpoint                                    | What you get                                                                                                                                                      |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /meters`                               | Search and filters the portal lacks: status, make, phase, transformer, feeder, zone, and proximity (`lat`, `lng`, `radiusKm`)                                     |
| `GET /meters/{id}`                          | Nameplate, location, full hierarchy, data-quality flags                                                                                                           |
| `GET /meters/{id}/consumption`              | Readings with ISO timestamps, numbers, derived per-interval kWh and power factor. Resolution varies per meter (30-minute or daily): see `summary.intervalMinutes` |
| `GET /transformers`, `/transformers/{code}` | The 40 transformers with capacity, network position, and their meters                                                                                             |
| `GET /hierarchy`                            | The whole network as a tree, with meter and status counts                                                                                                         |
| `GET /data-quality`                         | Every inconsistency found in the portal data and what was done about it                                                                                           |
| `GET /health`                               | Liveness and age of the local snapshot                                                                                                                            |

## Run it

Requires Node.js 20+.

```bash
npm install
```

Create a `.env` file in the project root (next to `package.json`):

```dotenv
PORTAL_URL=https://urja-ops.flockenergy.tech
PORTAL_EMAIL=<operator email>
PORTAL_PASSWORD=<operator password>
PORT=3000
PORTAL_UTC_OFFSET=+05:30
```

`.env` is not pushed to GitHub, so it has to be created by hand. `PORTAL_EMAIL` and `PORTAL_PASSWORD` are required; the rest are optional (more settings, such as cache lifetimes, are in `src/config.js`).

```bash
npm start        # runs src/server.js -> http://localhost:3000 (docs at /docs)
npm test         # runs against a built-in fake portal; no network or credentials needed
npm run openapi  # regenerates openapi.json
```

If the server exits with `Missing required environment variable`, check that `.env` exists and is named exactly that.

## Sample request

```bash
curl "localhost:3000/meters?status=Faulty&make=Genus&pageSize=5"
curl "localhost:3000/meters?lat=26.84&lng=75.71&radiusKm=2"
curl "localhost:3000/meters/J100011"
```

`GET /meters/J100011` (abridged). The portal sent an empty circle code; it was repaired and flagged:

```json
{
  "meterId": "J100011",
  "make": "HPL",
  "location": { "latitude": 26.9858, "longitude": 75.8114 },
  "hierarchy": {
    "circle": { "name": "Circle 6", "code": "C-06" },
    "...": "..."
  },
  "quality": { "flags": ["hierarchy_code_repaired:circle"] },
  "source": "export"
}
```

## Structure

```
src/server.js            entry point (npm start): config, wiring, HTTP server
src/app.js               Fastify app: Swagger docs, error handling
src/routes/, schemas.js  endpoints; the same schemas validate requests and generate openapi.json
src/services/            meters.js (use-cases), dataset.js (in-memory snapshot + data-quality report)
src/domain/              hierarchy repair and tree, filters and distance (pure functions)
src/portal/              client.js (login, retries), bulk.js (signed export), parsers.js
test/                    parsers, domain logic and the full API against a fake portal
```

## Design decisions and trade-offs

1. **Bulk export first, per-meter calls as fallback.** One signed call returns all 403 meters instead of ~830 requests. I reverse-engineered the signature (PROTOCOL.md §3.7). If the export fails, plain search and single-meter lookups fall back to the portal's own endpoints; filters and hierarchy need the snapshot and return 502.
2. **In-memory index, no database.** 403 rows is tiny, so a scan is instant and nothing extra needs deploying.
3. **Stale-while-revalidate.** The snapshot is refreshed in the background after 15 minutes; reads are never blocked, and a failed refresh keeps the old data (`/health` shows the error).
4. **Consumption is derived.** The portal gives cumulative registers, so I return per-interval kWh and flag counter resets instead of negative usage.
5. **Messy data is repaired conservatively and visibly.** A missing hierarchy code is filled only if every other meter on that transformer agrees, and each repair is flagged and listed in `/data-quality`. Disagreements are flagged, not silently resolved.
6. **The tree is keyed by path, not code,** because the portal reuses codes under different parents.
7. **Session handling in one place:** shared login, re-login before the 1-hour expiry or when the portal drops us, retries with backoff.
8. **Node + Fastify, plain JavaScript.** One set of route schemas gives validation and OpenAPI.

## Assumptions

- Portal timestamps are IST (+05:30); the portal states no timezone.
- If meters and the transformer list disagree on a transformer's name, the list wins.
- Only GET requests (plus the login POST) are ever sent to the portal.

## Scale

Everything is in one process's memory and queries scan all meters. That is fine up to roughly 10⁵ meters. Beyond that: indexes for filters, a geohash or R-tree for proximity, a database (SQLite/Postgres + PostGIS), and incremental refresh instead of re-downloading the whole export.

## Intentionally skipped

- Authentication on this API (out of scope for a take-home).
- Bulk consumption for all meters: no bulk endpoint exists, and the portal returns `429` after roughly 200 rapid requests, so readings are fetched on demand and cached.
- Persistence across restarts, metrics, rate limiting of our own clients.
- A web client.

## What I would do with more time

- A proper outbound rate limiter in the portal client (today it only caps concurrency and backs off after a 429).
- Find out what the portal's `build: legacy | v2` field means.
- Scheduled contract tests against the real portal, to catch format drift.
- A small web UI: meter map, hierarchy explorer.

## Reflection

**What assumptions did you make?**
The portal's timestamps (like "23/06/2026 23:30") have no timezone. The utility and the coordinates are in Jaipur, so I assumed India Standard Time and return ISO timestamps with +05:30. I also assumed the transformer list is the source of truth for transformer names, and that if a meter is missing a hierarchy code, the other meters on the same transformer can fill it in. Every such repair is flagged in the API, so nothing is hidden.

**Which part was the most difficult, and how did you get unstuck?**
The bulk export. The "Explore all meters" button called a signed endpoint, and it was useless without the right `x-signature` and `x-timestamp` headers. I had one captured request and the signing secret from `/portal/keys`, so I tried combinations of method, path, query string and timestamp until one reproduced the captured signature exactly. After that, a single call returned all 403 meters, which made the hierarchy, filters and nearby search much simpler.

**If you had another day, what would you improve?**
First, a proper outbound rate limiter. The portal starts returning 429 after roughly 200 quick requests, and my client only backs off after that happens. Then I'd try to find out what the `build` field (legacy / v2) means, because I couldn't link it to anything. After that, a small web page with a map of meters and a hierarchy explorer.

**What mistake did you make while solving this?**
I looked at one meter (J100002), saw a reading every 30 minutes, and wrote in the docs that every meter works that way. It was wrong. When I checked more meters I found daily readings, and scanning all 403 showed 40 half-hourly meters and 363 daily ones, 5 of which end with a blank duplicate row. I changed the API to measure the gap between readings instead of assuming it, and rewrote the docs. I had also guessed that "v2" meters were the daily ones, which was wrong too.

**If you were reviewing your own submission, what would you criticise?**
The tests run against a fake portal, so they can't catch the real portal changing its format; I only checked the live path by hand. Everything is kept in memory in one process, which is fine for 403 meters but would not scale far.
