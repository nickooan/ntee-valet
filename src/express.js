// Express 5 adapter: middleware factories over a Valet — request injection
// (req.valet), take-based rate limiting, and automatic response caching via
// res.write/res.end capture (res.send/res.json funnel through res.end, so
// buffered and streamed bodies are both covered). Express 5 forwards rejected
// async middleware to the error handler, so no try/catch wrappers are needed.
//
// rateLimit and cacheResponse accept paths/exclude glob patterns ("*" = one
// path segment, "**" = any depth); patterns compile once at factory time and
// per-request matching is precompiled RegExp.test only.
import { createValet } from "./index.js"
import {
  createPathMatcher,
  defaultKey,
  hasAuthorizationHeader,
  pathnameOf,
  pickHeaders,
  toBuffer,
} from "./shared.js"

const isValet = (candidate) => typeof candidate?.space === "function"

// Accepts a Valet or createValet options; with options the valet is created
// here and exposed as `.valet` on the returned middleware (express has no
// shutdown lifecycle — call middleware.valet.close() yourself).
export const valetContext = (valetOrOptions) => {
  const valet = isValet(valetOrOptions)
    ? valetOrOptions
    : createValet(valetOrOptions)
  const middleware = (req, res, next) => {
    req.valet = valet
    next()
  }
  middleware.valet = valet
  return middleware
}

export const rateLimit = (
  valet,
  name,
  { key, cost, remainingHeader = false, onReject, paths, exclude } = {},
) => {
  // Resolve at factory time so an unknown limit name fails at startup, not
  // per-request. valet.remaining/limit re-validate anyway.
  const definition = valet.config.limits[name]
  if (!definition) valet.limit(name, "") // throws ERR_VALET_UNKNOWN_LIMIT with known names
  const keyFor = key ?? ((req) => req.ip ?? "anon")
  // cost: plain number, or a per-request (possibly async) function;
  // undefined falls through to the limit definition's cost.
  const costFor = typeof cost === "function" ? cost : () => cost
  const matchesPath = createPathMatcher(paths, exclude)
  return async (req, res, next) => {
    if (!matchesPath(pathnameOf(req.originalUrl ?? req.url))) return next()
    const id = keyFor(req)
    const { ok } = await valet.limit(name, id, await costFor(req))
    res.set("X-RateLimit-Limit", String(definition.pool))
    if (!ok) {
      // Upper bound: the window is fixed per key but its deadline isn't
      // readable from the store, so advertise the full window.
      res.set("Retry-After", String(Math.ceil(definition.windowMs / 1000)))
      if (onReject) return onReject(req, res)
      return res.status(429).json({ error: "rate limited" })
    }
    if (remainingHeader)
      res.set("X-RateLimit-Remaining", String(await valet.remaining(name, id)))
    next()
  }
}

// The default store decision, exported so custom `store` callbacks can
// compose with it: cacheable status (statuses option, default [200]) and no
// Set-Cookie header (a cookie-setting response is session-personalized —
// storing it in a shared cache would replay one user's session artifacts to
// others).
export const defaultStorePolicy =
  ({ statuses = [200] } = {}) =>
  (request, response) =>
    statuses.includes(response.statusCode) &&
    response.getHeader("set-cookie") === undefined

export const cacheResponse = (
  valet,
  {
    ttlMs,
    key = (req) => defaultKey(req.method, req.originalUrl ?? req.url),
    methods = ["GET"],
    statuses = [200],
    headers = [],
    // Safe default: Authorization-bearing requests bypass the cache entirely
    // (never served shared data, never stored). Passing your own skip
    // replaces this guard — opt back in deliberately. Cookie-carrying
    // requests DO participate; the store side refuses Set-Cookie responses.
    skip = (req) => hasAuthorizationHeader(req.headers),
    // Decides whether a completed response is stored. Passing your own store
    // REPLACES the default policy (including the statuses check). Handler
    // code overrides both per response via `res.valetCache = true | false`.
    store = defaultStorePolicy({ statuses }),
    paths,
    exclude,
  } = {},
) => {
  const matchesPath = createPathMatcher(paths, exclude)
  return async (req, res, next) => {
    if (
      !methods.includes(req.method) ||
      !matchesPath(pathnameOf(req.originalUrl ?? req.url)) ||
      skip(req)
    )
      return next()
    const cacheKey = key(req)

    const hit = await valet.responseCache.get(cacheKey)
    if (hit) {
      res.set(hit.headers).set("X-Cache", "HIT").status(hit.status)
      return res.end(hit.body)
    }

    const chunks = []
    const write = res.write.bind(res)
    const end = res.end.bind(res)
    res.write = (chunk, encoding, callback) => {
      if (chunk) chunks.push(toBuffer(chunk, encoding))
      return write(chunk, encoding, callback)
    }
    res.end = (chunk, encoding, callback) => {
      if (chunk && typeof chunk !== "function")
        chunks.push(toBuffer(chunk, encoding))
      const body = Buffer.concat(chunks)
      // Handler code has the last word (res.valetCache); otherwise the store
      // callback decides (default: defaultStorePolicy).
      const explicitDecision = res.valetCache
      const shouldStore =
        explicitDecision !== undefined
          ? explicitDecision
          : store(req, res, body)
      if (shouldStore)
        // db.put is synchronous — safe to store without awaiting.
        valet.responseCache.set(
          cacheKey,
          {
            status: res.statusCode,
            headers: pickHeaders((name) => res.getHeader(name), headers),
            body,
          },
          ttlMs,
        )
      return end(chunk, encoding, callback)
    }
    res.set("X-Cache", "MISS")
    next()
  }
}
