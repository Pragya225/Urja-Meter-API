# PROTOCOL.md — how the Urja Meter Ops portal actually works

## 1. What the portal is

A **SvelteKit** web app (file names like `/_app/immutable/nodes/5.*.js`, `__data.json`, `x-sveltekit-action` header). It has two sections in its nav: **Meters** (`/meters`) and **Transformers** (`/transformers`). There is no public API; the browser UI itself calls a small set of internal JSON endpoints.

## 2. Authentication

|              |                                                                                                                                                                                                               |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Login        | `POST /login`, `Content-Type: application/x-www-form-urlencoded`, body `email=<email>&password=<password>`                                                                                                    |
| Headers sent | `x-sveltekit-action: true`, `accept: application/json`, and an `Origin` equal to the portal origin (the browser sends it, and so does our client; it matters because SvelteKit checks `Origin` on form posts) |
| Success      | HTTP 200 with JSON `{"type":"redirect","status":303,"location":"/meters"}` — note the redirect is _inside_ the JSON body                                                                                      |
| Session      | `Set-Cookie: __Secure-better-auth.session_token=…; Max-Age=3600; HttpOnly; Secure; SameSite=Lax` (the cookie name shows the portal uses the **better-auth** library)                                          |
| Lifetime     | **1 hour** (`Max-Age=3600`). The client re-logs in a minute early, and again if the portal rejects a request                                                                                                  |
| Logout       | `POST /api/auth/sign-out`                                                                                                                                                                                     |

Every data request just sends that cookie. No CSRF token or bearer header is needed for GETs.

## 3. Data endpoints

All JSON, all `GET`, all need the session cookie.

### 3.1 Meter search / list — `GET /portal/meters/search?q=<text>&page=<n>`

```json
{
  "data": [
    {
      "meterId": "J100000",
      "serialNo": "SE33962",
      "make": "HPL",
      "phaseType": "single",
      "installStatus": "Decommissioned",
      "dtCode": "DT-001"
    }
  ],
  "total": 403,
  "page": 1,
  "pageSize": 20
}
```

- 403 meters in total, fixed page size 20 → 21 pages. `q=` (empty) lists everything.
- Search is **case-insensitive** (`q=j10000` returned `J100000`…`J100009`, total 10) and the UI says it matches meter number _or_ serial.
- The UI debounces typing by 250 ms; the portal itself does not delay requests, but it does rate-limit bursts (see §4, item 18).

### 3.2 Meter location — `GET /portal/meters/{id}/geo`

```json
{
  "data": { "latitude": "26.840224163401967", "longitude": "75.71461868999545" }
}
```

Coordinates are **strings**. (Jaipur area.)

### 3.3 Meter consumption — `GET /portal/meters/{id}/energy`

```json
{
  "data": [
    {
      "timestamp": "23/06/2026 23:30",
      "kwh": "6850.32",
      "kvah": "7398.35",
      "voltR": "227"
    }
  ]
}
```

- **Reading resolution differs between meters** (all 403 meters scanned on 29 Oct 2026):

  | Group                       | Meters                                                      | Rows         | Gap                            | Window                              |
  | --------------------------- | ----------------------------------------------------------- | ------------ | ------------------------------ | ----------------------------------- |
  | Half-hourly                 | 40 — exactly `J100000`–`J100039`                            | 337 (~27 KB) | 30 min                         | 23/06/2026 23:30 → 30/06/2026 23:30 |
  | Daily                       | 358                                                         | 8            | 1440 min                       | 23/06/2026 00:00 → 30/06/2026 00:00 |
  | Daily, with a junk last row | 5 (seen: J100089, J100134, J100211, J100330, plus one more) | 9            | 1440 min, and one gap of **0** | as above                            |

  Observations: the 40 half-hourly meters are exactly the _first meter of each of the 40 transformers_ (J100000→DT-001 … J100039→DT-040); the interval does **not** depend on `build` (J100004 is `v2` and half-hourly), phase, make or status. Whether the half-hourly meters are special (e.g. transformer-level meters) is a guess; the portal does not say.

- **The junk row**: the 5 meters above end with a second row for 30/06/2026 00:00 whose `kwh` and `voltR` are empty strings (`{"timestamp":"30/06/2026 00:00","kwh":"","kvah":"13750.93","voltR":""}`) — a duplicate timestamp carrying only `kvah`. Our parser drops rows without a numeric `kwh` and reports them in `skippedRows`, so no zero-length interval or bogus 0 kWh reading is produced.
- The API measures the gap between readings and reports it as `summary.intervalMinutes` rather than assuming one.
- `kwh` / `kvah` are **cumulative registers** (always increasing), not per-interval usage. Interval usage = difference between consecutive rows (≈0.45 kWh per half hour, ≈7.6–8.9 kWh per day for the two daily meters inspected).
- `voltR` is the **only** voltage field, for every meter: all 403 responses have exactly `timestamp, kwh, kvah, voltR`, including the 126 three-phase meters (no `voltY`/`voltB`).

### 3.4 Meter page data — `GET /meters/{id}/__data.json`

SvelteKit's server-load data for the meter detail page. It is the **only** source of the nameplate details beyond the list columns, and of the **network hierarchy**. The browser fires it on _hover_ over a meter row (SvelteKit preloading), before you click.

The payload is serialised with SvelteKit's `devalue` format: `nodes[i].data` is a flat array in which numbers are pointers to other slots. After decoding (`devalue.unflatten`):

```js
{ meterId: "J100002",
  detail: { data: [ {parameterName:"Meter ID", parameterValue:"J100002"},
                    {parameterName:"Serial No", …}, {parameterName:"Make", …},
                    {parameterName:"Phase Type", …}, {parameterName:"Installation Status", …},
                    {parameterName:"Installation Type", parameterValue:"CT Operated"} ] },
  hierarchy: { Zone:"Jaipur Zone 3 (Z-03)", Circle:"Circle 3 (C-03)", Division:"Division 3 (D-03)",
               Subdivision:"Subdivision 3 (SD-03)", "Sub Station":"Substation 3 (SS-03)",
               Feeder:"Feeder 3 (F-003)", DT:"Vaishali DT 3 (DT-003)" } }
```

### 3.5 Transformers (distribution transformers, "DTs") — `GET /portal/dts?page=<n>`

```json
{
  "data": [
    {
      "code": "DT-001",
      "name": "Malviya Nagar DT 1",
      "feederCode": "F-001",
      "capacityKva": 100
    }
  ],
  "total": 40,
  "page": 1,
  "pageSize": 20
}
```

- 40 transformers, page size 20 → 2 pages. The UI page is `/transformers`.
- Here `capacityKva` is a real **number**, whereas the meter endpoints send numbers as strings — the portal is not consistent about types.
- Each DT carries only its _feeder_ code; the levels above the feeder (substation, division, circle, zone) are only visible in each meter's `__data.json` hierarchy.
- 403 meters share 40 transformers (10–13 each). The first 40 meters map one-to-one to DT-001…DT-040, then the assignment wraps around (J100040 → DT-001 again).

### 3.6 Signing key — `GET /portal/keys`

```json
{ "data": { "signingSecret": "<32 chars>" } }
```

Handed to any logged-in user. It exists so the browser can sign export requests.

### 3.7 Bulk export — `GET /portal/export?page=<n>` (the "Explore all meters" button)

The transformers page button calls `/portal/keys` and then this endpoint, then saves the result as `meter-export.json`.

**Request signature** (found by checking the one captured request against candidate formulas; it reproduces the captured value exactly):

```
x-timestamp: <unix seconds>
x-signature: hex( HMAC-SHA256( key = signingSecret,
                               message = "GET\n/portal/export\npage=1\n<x-timestamp>" ) )
```

The message is method, path, query string and timestamp joined by real newlines. Without valid headers the portal answers 403 (we assume; our client re-fetches the key once and retries).

**Response**: all 403 meters on page 1 (≈232 KB; the body is `{"data":[…],"total":403}` judging by its size — our parser also accepts a bare array). One record per meter:

```json
{ "meterId":"J100000","serialNo":"SE33962","make":"HPL","phaseType":"single","installStatus":"Decommissioned",
  "installType":"Whole Current","build":"legacy","dtCode":"DT-001",
  "hierarchy":{ "zone":{"name":"Jaipur Zone 1","code":"Z-01"}, "circle":{…}, "division":{…}, "subdivision":{…},
                "substation":{…}, "feeder":{…}, "dt":{"name":"Malviya Nagar DT 1","code":"DT-001"} },
  "geo":{ "lat":26.9389,"lng":75.8309 } }
```

This single call replaces 21 search pages + 403 detail pages + 403 geo calls. Differences from the per-meter endpoints: numbers are real numbers, coordinates are `lat`/`lng`, and the field is `installType` (detail page: "Installation Type"). It also has a `build` field (`legacy` ×238, `v2` ×165) that no UI page shows.

## 4. Quirks and surprises

1. **Numbers are strings** on the per-meter endpoints (kwh, kvah, voltR, latitude, longitude) but real numbers in `/portal/dts` and the export. The portal is not consistent.
2. **Timestamps are `DD/MM/YYYY HH:mm` with no timezone.** We assume India Standard Time (+05:30): the utility and coordinates are in Jaipur.
3. **The energy window is old data** (23–30 June 2026, observed in late October). It looks like a static dataset, not a live feed.
4. **Cumulative counters**, so "consumption" must be derived. And the sampling interval is not constant across meters (30 minutes vs daily), so it must be measured, not assumed.
5. **Nameplate is key/value pairs** (`parameterName`/`parameterValue`) on the detail page, not an object. Unknown parameters are kept in `extraParameters`.
6. **Hierarchy labels embed their code in the name** on the detail page (`"Vaishali DT 3 (DT-003)"`); the export gives `{name, code}` separately.
7. **Redirect-in-JSON login**: success is HTTP 200 with the redirect described in the body.
8. **A signed bulk export exists** and nothing in the UI mentions it except one button (§3.7).
9. **Level codes are reused under different parents.** Division `D-01` appears under circles C-01, C-03 and C-05; `SD-01`, `SS-01` likewise; feeder `F-001` appears under two substations. Only zone/circle/DT codes are unique. Any hierarchy keyed by code alone silently merges unrelated branches, so our tree is keyed by the full path.
10. **14 of 403 meters have a hierarchy node with a name but an empty code** (`{"name":"Circle 6","code":""}`; circle, substation or feeder; 11 legacy, 3 v2). All other meters on the same transformer agree on the code, so we repair it from them, flag the meter, and list every repair in `/data-quality`. No transformer has two _different_ complete chains.
11. **Three meters (J100400–J100402) disagree about their transformer's name**: they say DT-007 is "Old Malviya Nagar Xfmr", the transformer list and the other 10 meters say "Sanganer DT 7". They are also the only meters with a `GN…` serial prefix, and all are three-phase Genus. We use the transformer list's name and flag the meters. Which side is right is a business question we cannot answer.
12. **Serial prefixes do not match makes** (e.g. `L&…` serials appear on HPL, Genus, Allied and Secure meters), so a serial cannot be used to infer the make. A serial like `L&84997` contains `&` and must be URL-encoded in a query string.
13. **Transformer ↔ feeder**: `/portal/dts` gives each DT one `feederCode`, but feeder codes repeat (DT-001 and DT-029 both say F-001, under different substations), so the code alone does not identify a feeder.
14. **Transformers can only be placed in the tree through their meters**; the transformer list has no parent information.
15. The 403 meters spread over 40 transformers (10–13 each), 3 zones, 6 circles, 10 divisions, 14 subdivisions, 18 substations. Coordinates fall in a box around Jaipur (lat 26.79–27.04, lng 75.66–75.91) and are not clustered by transformer or zone.
16. Hovering and typing generate extra background requests (SvelteKit prefetch, one search per debounced keystroke). They are UI behaviour, not part of the data model.
17. **Reading resolution is not uniform** (30-minute vs daily, §3.3) and **5 meters carry a blank duplicate last row**.
18. **The portal rate-limits.** Scanning `/energy` for every meter (3 requests in flight) worked for the first 204 requests, then every request returned `429 Too Many Requests`. The 429 carries **no `Retry-After` or `X-RateLimit-*` header** (only `content-type` and `date`), so clients must guess a back-off. In a slower retry run (one request at a time, 300 ms apart, waiting 2 s → 4 s → 8 s after each 429) the portal recovered within about 15 seconds. The exact limit and window are not documented; we only know "roughly 200 requests in a short burst is too many".

## 5. What we do not know yet

- The exact rate limit (count and window). Our client retries 429/5xx with exponential back-off and caps concurrency at 4.
- Behaviour when the session expires (we handle 401/403, a redirect to `/login`, or HTML instead of JSON).
- What `build: legacy | v2` means. It does not explain the reading resolution or any payload difference we could find.
- Whether `pageSize` or date-range parameters are honoured anywhere.
