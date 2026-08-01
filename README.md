# ntee-valet

API-server companion for [ntee-db](https://github.com/nickooan/ntee-db) — an
embedded, in-process valet that caches your content, searches it, limits your
callers, and caches your responses. One store, zero external services, with
first-class middleware for **Express 5** and **Fastify 5**. Values live on
disk; only keys and indexes are held in RAM — caching megabytes of content
does not cost megabytes of process memory:

```js
import { createValet } from "ntee-valet"

const valet = createValet({
  dir: "./data",
  spaces: {
    order: {
      ttlMs: 300_000,
      indexes: [
        // Index values derive from the record via jsonPath on every write:
        { name: "customer", kind: "string", jsonPath: "customer" },
        { name: "city", kind: "string", jsonPath: "shipping.address.city" },
        // jsonPath is optional — omitted, it defaults to the index name:
        { name: "status", kind: "number" }, // same as jsonPath: "status"
      ],
    },
  },
  limits: { api: { pool: 1000, windowMs: 60_000 } },
})

valet.spaces.order.set("o1", {
  total: 42,
  status: 200,
  customer: "acme",
  shipping: { address: { city: "berlin" } },
})

await valet.spaces.order.findRecords("customer", "acme") // → [{ key: "o1", ... }]
await valet.spaces.order.find("city", "berlin") // → ["o1"] (nested jsonPath)
await valet.limit("api", clientId) // → { ok: true | false }
```

## Install

```sh
npm install ntee-valet
```

Bring your own framework (both are optional peers): `express@^5` or
`fastify@^5`. The store itself (`ntee-db`) ships prebuilt native binaries for
darwin-arm64, linux-amd64, linux-arm64.

## Quick start — Express

```js
import express from "express"
import { createValet } from "ntee-valet"
import { valetContext, rateLimit, cacheResponse } from "ntee-valet/express"

const valet = createValet({
  dir: "./data",
  spaces: { order: { indexes: [{ name: "customer", kind: "string" }] } },
  limits: { api: { pool: 1000, windowMs: 60_000 } },
  responseCache: { ttlMs: 10_000 },
})

const app = express()
app.use(valetContext(valet)) // → req.valet everywhere
app.use(rateLimit(valet, "api")) // 429 past 1000 req/min per IP
app.use(cacheResponse(valet)) // GET responses cached 10s

// Or let valetContext create the valet from the schema at boot — it's
// exposed as .valet on the middleware (close it yourself on shutdown):
// const context = valetContext({ dir: "./data", spaces: {...}, limits: {...} })
// app.use(context)
// app.use(rateLimit(context.valet, "api"))

app.get("/orders/:id", async (req, res) => {
  res.json(await req.valet.spaces.order.get(req.params.id))
})

app.post("/orders", express.json(), async (req, res) => {
  const order = req.body
  // The customer index derives from the record automatically (schema-only).
  req.valet.spaces.order.set(order.id, order)
  await req.valet.responseCache.invalidate("GET /orders") // bust stale reads
  res.status(201).json(order)
})

app.listen(3000)
```

## Quick start — Fastify

```js
import Fastify from "fastify"
import { createValet } from "ntee-valet"
import { valetPlugin, rateLimit, cacheResponse } from "ntee-valet/fastify"

const valet = createValet({
  dir: "./data",
  spaces: { order: { indexes: [{ name: "customer", kind: "string" }] } },
  limits: { api: { pool: 1000, windowMs: 60_000 } },
})

const app = Fastify()
await app.register(valetPlugin, { valet }) // → request.valet everywhere

// Or hand the plugin the schema directly — the valet is created at boot and
// auto-closed on app.close():
// await app.register(valetPlugin, { dir: "./data", spaces: {...}, limits: {...} })

// Per-route:
const cache = cacheResponse(valet, { ttlMs: 10_000 })
app.get(
  "/orders/:id",
  {
    preHandler: rateLimit(valet, "api"),
    onRequest: cache.onRequest,
    onSend: cache.onSend,
  },
  async (request) => request.valet.spaces.order.get(request.params.id),
)

// Or globally — add hooks on the ROOT instance (hooks added inside a plain
// register()'d plugin are encapsulated and won't fire for root routes):
app.addHook("preHandler", rateLimit(valet, "api"))

await app.listen({ port: 3000 })
```

**Hook-order note:** fastify runs `onRequest` before `preHandler`, and the
cache serves hits from `onRequest` — so a `preHandler` rate limit never sees
cache-served responses (hits are free). If cache hits should count against the
pool, register the limiter as an `onRequest` hook _before_ the cache's:

```js
app.addHook("onRequest", rateLimit(valet, "api")) // hits cost a token
app.addHook("onRequest", cache.onRequest)
app.addHook("onSend", cache.onSend)
```

## Schema reference

```js
const valet = createValet({
  dir: "./data", // required; one valet per directory per process
  blobThreshold: 64 * 1024, // optional: values >= this go to the blob file
  spaces: {
    user: {
      ttlMs: 60_000, // default TTL for set() in this space
      indexes: [
        { name: "email", kind: "string" }, // derives from the record's "email" field
        { name: "age", kind: "number", jsonPath: "profile.age" }, // nested/renamed path
        { name: "team", kind: "string", maxPerValue: 5 }, // retention per value
      ],
    },
  },
  limits: {
    api: { pool: 1000, windowMs: 60_000 }, // 1000 tokens / key / minute
    exports: { pool: 10, windowMs: 3_600_000, cost: 1 },
  },
  responseCache: { ttlMs: 30_000 }, // default TTL for cached responses
})
```

- **Spaces** are isolated key namespaces in one store. Index names are
  space-local (two spaces can both declare `email`); the store-global
  namespacing is handled for you, and every result comes back with the
  space-local key.
- Names (spaces and limits) must match `[a-zA-Z][a-zA-Z0-9_-]*`.
- **Indexing is schema-only**: every declared index derives its value from
  the record on write — from the field named like the index, or from a
  `jsonPath` for nested/renamed fields. Writes carry no index values; records
  missing the field (and non-object values) are simply not indexed. Derived
  indexes are back-fillable via `valet.db.reindex()`. The extractor runs on
  every write to the store (a small JSON-parse cost per declared index).
  Explicit per-write index values are possible through the raw escape hatch:
  `valet.db.put(key, value, { "space.index": v })`.
- `maxPerValue` retention and string/number kinds pass through from ntee-db.

## Content caching & search

```js
const user = valet.spaces.user

// writes (synchronous — ntee-db's fast append path). Declared indexes
// (email, age) derive from the record automatically — nothing to pass.
user.set("u1", { name: "amy", email: "a@x.io", profile: { age: 34 } })
user.set("session", token, { ttlMs: 900_000 }) // per-call TTL override
user.set("pinned", data, { ttlMs: null }) // explicitly immortal
await user.setMany([{ key: "u2", value: { email: "b@x.io" } }])
user.del("u1")

// reads
await user.get("u1") // parsed JSON | Buffer (non-JSON) | null
await user.getMany(["u1", "u2"])
await user.has("u1")

// primary-key search
await user.keys("u") // sorted keys under a sub-prefix
await user.records() // [{ key, value }] for the whole space

// secondary-index search
await user.find("email", "a@x.io") // keys
await user.findRecords("email", "a@x.io") // records in one call
await user.findPrefix("email", "a@") // string-prefix match
await user.findRange("age", 30, 39) // numeric range
await user.findHas("email", "a@x.io") // existence check

// counters (atomic int64; TTL explicit-only — see notes)
await user.incr("views:u1")
await user.take("credits:u1", 5, 0) // spend 5 only if 5 remain
```

## Rate limiting

Built on ntee-db's atomic `take` — the bound check and the write are one
operation, so concurrent callers can never oversubscribe a pool, and a refused
take writes nothing (it doesn't even arm the window).

```js
const { ok } = await valet.limit("api", clientId) // one atomic take
const left = await valet.remaining("api", clientId) // costs one extra read
```

Middleware (`rateLimit(valet, name, options)`, both frameworks):

| Option            | Default                        | Meaning                                   |
| ----------------- | ------------------------------ | ----------------------------------------- |
| `key`             | `req.ip`                       | limiter key per request                   |
| `cost`            | the limit's `cost` (1)         | number, or per-request fn (sync or async) |
| `remainingHeader` | `false`                        | also set `X-RateLimit-Remaining`          |
| `onReject`        | 429 `{"error":"rate limited"}` | custom rejection handler                  |
| `paths`/`exclude` | apply everywhere               | glob path scoping (see "Scoping by path") |

**Dynamic cost.** `cost` can be a plain number
(`rateLimit(valet, "api", { cost: 5 })` — every matching request takes 5
tokens), or a per-request function returning a number or a Promise of one
(the middleware awaits it):

```js
// Charge by the work requested: a bulk create of 50 items costs 50 tokens.
app.post(
  "/orders/bulk",
  express.json(), // body-based cost needs the body parsed first
  rateLimit(valet, "api", { cost: (req) => req.body.items.length }),
  handler,
)

// Or decide asynchronously (account tier, store lookup, …):
rateLimit(valet, "api", {
  cost: async (req) => (await accountTier(req)).weight,
})
```

The underlying `take` is all-or-nothing: a cost that would overshoot the
remaining pool is refused whole and writes nothing — a bulk request never
partially drains the budget. Fastify note: use the hook as `preHandler` when
the cost reads `request.body` (`onRequest` runs before body parsing). The
cost must resolve to a non-negative safe integer.

Headers: `X-RateLimit-Limit` always; on 429, `Retry-After` is
`ceil(windowMs/1000)` — an honest **upper bound**, because a fixed window is
armed per key by its first accepted request and the per-key deadline isn't
readable from the store.

## Response caching

```js
app.use(
  cacheResponse(valet, {
    ttlMs: 10_000, // this middleware's TTL (falls back to responseCache.ttlMs)
    key: (req) => `${req.method} ${req.originalUrl} ${req.get("accept") ?? ""}`,
    methods: ["GET"], // default
    statuses: [200], // default — errors are never cached
    headers: ["cache-control"], // extra headers to replay (content-type always kept)
    // skip DEFAULT: Authorization-bearing requests bypass the cache
    // (see Security). Your own skip replaces the Authorization guard.
    skip: (req) => req.query.nocache !== undefined,
    // store DEFAULT: defaultStorePolicy({ statuses }) — see "Deciding what
    // to store". Your own store replaces it wholesale.
    store: (req, res, body) => res.statusCode === 200 && body.length < 1e6,
    paths: ["/properties/**"], // only cache this namespace (see below)
    exclude: ["/properties/admin/**"],
  }),
)
```

### Deciding what to store

The store decision is explicit and layered — the most specific wins:

1. **Handler code, per response** — set `res.valetCache` (express) /
   `reply.valetCache` (fastify): `false` blocks storing a response the policy
   would cache; `true` forces storing one it would refuse.

   ```js
   app.get("/report", async (req, res) => {
     const report = await buildExpensiveReport()
     res.valetCache = report.stable // cache only when the data settled
     res.json(report)
   })
   ```

2. **The `store` option** — one callback deciding for the whole middleware.
   Passing it **replaces** the default policy entirely (including the
   `statuses` check):

   ```js
   cacheResponse(valet, {
     store: (req, res, body) =>
       defaultStorePolicy()(req, res) && body.length < 100_000,
   })
   ```

3. **`defaultStorePolicy`** (exported from both adapters) — what runs when
   you configure nothing: status in `statuses` (default `[200]`) and no
   `Set-Cookie` header on the response.

Mechanical limits apply regardless: a request-side `skip`/path miss means the
response was never captured, cache-served hits are never re-stored, and (in
fastify) streamed payloads can't be stored.

### Scoping by path

`cacheResponse` and `rateLimit` both take `paths` / `exclude` glob lists,
matched against the request **pathname** (query string ignored):

| Pattern          | Matches                                       |
| ---------------- | --------------------------------------------- |
| `/properties/*`  | `/properties/123` — one segment, not deeper   |
| `/properties/**` | the whole `/properties/…` subtree             |
| `/p/*/photos`    | `/p/7/photos` — `*` is any single segment     |
| `/health`        | exactly `/health` (no wildcard = exact match) |

`exclude` always wins over `paths`; omitting `paths` matches everything.
Patterns are compiled to regexes **once at mount time** — per-request matching
is a precompiled `RegExp.test`, nothing is parsed on the hot path.

Give different namespaces different settings by mounting multiple instances —
non-matching requests fall through untouched:

```js
app.use(cacheResponse(valet, { paths: ["/properties/**"], ttlMs: 60_000 }))
app.use(cacheResponse(valet, { paths: ["/search/**"], ttlMs: 5_000 }))
app.use(rateLimit(valet, "exports", { paths: ["/exports/**"] }))
```

- Hits are served with `X-Cache: HIT` and the stored status/headers/body;
  misses pass through with `X-Cache: MISS` and are stored on completion.
- Bust after mutations with `valet.responseCache.invalidate(pattern)` —
  a plain string is a key prefix, and the same globs work over full cache
  keys (default keys are `${method} ${url}`):

  ```js
  await valet.responseCache.invalidate("GET /orders") // prefix
  await valet.responseCache.invalidate("GET /properties/*") // direct children
  await valet.responseCache.invalidate("GET /properties/**") // whole subtree
  await valet.responseCache.invalidate("GET /properties/*/photos")
  ```

- Binary bodies round-trip byte-exact (utf8-safe bodies are stored readably,
  everything else as base64).
- Fastify: `cacheResponse` returns an `{ onRequest, onSend }` hook pair;
  streamed payloads are passed through uncached (onSend only stores
  string/Buffer). Express: `res.write`/`res.end` are wrapped, so streamed
  bodies are captured too.

## Security

The response cache is a **shared cache** — the classic web-cache hazards
apply. ntee-valet ships safe defaults, but two of these are about how you
wire it:

- **Authorization-bearing requests bypass the cache by default** (the
  RFC 9111 shared-cache rule): neither served from nor stored to the cache,
  so an authorized user's response is never replayed to anyone else. Passing
  your own `skip` **replaces** this guard — only do `skip: () => false`
  deliberately, and fold the identity into `key` if you cache per-user
  responses.
- **Plain `Cookie` headers do NOT bypass** — browsers send cookies on nearly
  every request, so skipping on them would disable the cache for real sites.
  The guard is on the response side instead: the **default store policy**
  refuses responses carrying `Set-Cookie` (session-personalized), and stored
  headers are allowlisted, so a cached response can never replay someone's
  `Set-Cookie`. This is policy, not magic — replace it with the `store`
  option or override per response with `valetCache` (see "Deciding what to
  store"), and know that doing so takes on this risk. The remaining footgun
  is cookie-session APIs whose plain GET responses differ per session
  **without** setting cookies — for those routes, add
  `skip: (req) => req.headers.cookie !== undefined`, fold the session into
  `key`, or exclude them via `paths`.
- **Mount order is auth-critical.** A cache hit short-circuits everything
  mounted after it. Express: mount `cacheResponse` **after** your auth
  middleware. Fastify: the cache's `onRequest` hook runs before any
  `preHandler` — auth living in `preHandler` never sees cached hits, so
  register auth as an earlier `onRequest` hook (same lesson as the
  rate-limit hook ordering above) or rely on the credential guard.
- **The default key ignores request headers** (`${method} ${url}`). Routes
  whose response varies on `Accept`, `Accept-Encoding`, `Origin`, etc. can
  serve the wrong variant — fold those into `key`, or don't cache them.
- **Cache flooding**: the default key includes the query string, and ntee-db
  keeps all keys in RAM, so an attacker iterating junk query strings grows
  the store until TTLs lapse (deletion is lazy). Scope caching with `paths`,
  keep TTLs short, normalize/strip queries in `key` for routes that ignore
  them, and run `valet.db.compact()` periodically.
- **Rate-limiter keys default to `req.ip`** — behind a reverse proxy this is
  only meaningful with the framework's trust-proxy setting configured
  (`app.set("trust proxy", ...)` / `Fastify({ trustProxy: ... })`).
  Unconfigured: all clients share the proxy's IP (one abuser exhausts the
  pool for everyone). Over-trusting: `X-Forwarded-For` spoofing hands out
  fresh buckets (bypass). High-cardinality keys also live in RAM until their
  window TTL lapses.
- **Never interpolate raw user input into `invalidate()`** — it accepts
  globs, so an id of `**` would wipe the whole response cache. Validate
  route params (e.g. `/^[\w-]+$/`) before building invalidation patterns.
- Cached bodies are stored **in plaintext** in the store directory with
  default file permissions — treat the directory's confidentiality like your
  application logs.

## Notes & constraints

- **Memory model — values on disk, keys in RAM**: every record value
  (cached content, response bodies, blobs) lives in the append-only log on
  disk and is read from disk per get (the OS page cache makes hot reads
  cheap). What stays in process memory is the sorted key index and the
  secondary-index entries — so RAM cost scales with the **number of keys**,
  not the bytes cached: hundreds of MB of cached bodies cost only their
  keys' worth of RAM. The corollary: high key **cardinality** is what costs
  memory (see the cache-flooding note in Security), and boot does an O(n)
  key scan (~100 ms at 100k keys).
- **Single-writer**: one process per store directory (enforced by `flock`;
  a second open fails fast). For multi-process or multi-host sharing, run
  `nteedb-server` and use `ntee-db-client` instead of this package.
- **Indexes are fixed at open**: changing a space's indexes requires a
  restart; run `valet.db.reindex()` to back-fill `jsonPath` indexes over
  existing records.
- **TTL rules** (inherited from ntee-db): `set` without `ttlMs` uses the space
  default; `ttlMs: null` is explicitly immortal and clears an existing TTL;
  `setMany` carries no TTL at all. Counter TTLs are create-only — they never
  slide under traffic, and the space default is deliberately not applied to
  counters.
- **Only JSON-object values can be indexed** — scalars, arrays, and Buffers
  are primary-key-only (index derivation just skips them, no error).
- Reads return parsed JSON; non-JSON/binary values come back as `Buffer`
  (guard with `Buffer.isBuffer`).
- Unbounded `Promise.all` fan-out is safe — the ntee-db binding gates and
  queues FFI concurrency internally.
- `valet.db` exposes the raw ntee-db handle (`stats`, `compact`, `details`,
  …) when you need the full store API.

## License

Apache-2.0
