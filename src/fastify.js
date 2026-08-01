// Fastify 5 adapter: an fp-wrapped decorator plugin (fastify-plugin breaks
// register() encapsulation so app.valet/request.valet reach the root
// instance), plus hook factories for rate limiting and response caching —
// usable per-route in route options or globally via addHook on the root
// instance (or inside another fp-wrapped plugin).
//
// valetPlugin accepts { valet } OR createValet options; with options the
// valet is created at boot and auto-closed on app.close(). rateLimit and
// cacheResponse accept paths/exclude glob patterns ("*" = one path segment,
// "**" = any depth); patterns compile once at factory time and per-request
// matching is precompiled RegExp.test only.
import fastifyPlugin from "fastify-plugin"
import { createValet } from "./index.js"
import {
  createPathMatcher,
  defaultKey,
  hasAuthorizationHeader,
  pathnameOf,
  pickHeaders,
} from "./shared.js"

const servedFromCache = Symbol("ntee-valet.servedFromCache")

const decorate = async (app, options) => {
  const valet = options.valet ?? createValet(options)
  if (!options.valet) app.addHook("onClose", async () => valet.close())
  app.decorate("valet", valet)
  app.decorateRequest("valet", { getter: () => valet })
}

export const valetPlugin = fastifyPlugin(decorate, {
  fastify: "5.x",
  name: "ntee-valet",
})

export const rateLimit = (
  valet,
  name,
  { key, cost, remainingHeader = false, onReject, paths, exclude } = {},
) => {
  // Resolve at factory time so an unknown limit name fails at startup.
  const definition = valet.config.limits[name]
  if (!definition) valet.limit(name, "") // throws ERR_VALET_UNKNOWN_LIMIT with known names
  const keyFor = key ?? ((request) => request.ip ?? "anon")
  const matchesPath = createPathMatcher(paths, exclude)
  // A preHandler (or onRequest) hook.
  return async (request, reply) => {
    if (!matchesPath(pathnameOf(request.url))) return
    const id = keyFor(request)
    const { ok } = await valet.limit(name, id, cost?.(request))
    reply.header("x-ratelimit-limit", String(definition.pool))
    if (!ok) {
      // Upper bound: the fixed window's per-key deadline isn't readable.
      reply.header("retry-after", String(Math.ceil(definition.windowMs / 1000)))
      if (onReject) return onReject(request, reply)
      return reply.code(429).send({ error: "rate limited" })
    }
    if (remainingHeader)
      reply.header(
        "x-ratelimit-remaining",
        String(await valet.remaining(name, id)),
      )
  }
}

export const cacheResponse = (
  valet,
  {
    ttlMs,
    key = (request) => defaultKey(request.method, request.url),
    methods = ["GET"],
    statuses = [200],
    headers = [],
    // Safe default: Authorization-bearing requests bypass the cache entirely
    // (never served shared data, never stored). Passing your own skip
    // replaces this guard — opt back in deliberately. Cookie-carrying
    // requests DO participate; the store side refuses Set-Cookie responses.
    skip = (request) => hasAuthorizationHeader(request.headers),
    paths,
    exclude,
  } = {},
) => {
  const matchesPath = createPathMatcher(paths, exclude)
  const applies = (request) =>
    methods.includes(request.method) &&
    matchesPath(pathnameOf(request.url)) &&
    !skip(request)
  const onRequest = async (request, reply) => {
    if (!applies(request)) return
    const hit = await valet.responseCache.get(key(request))
    if (hit) {
      request[servedFromCache] = true
      reply.headers(hit.headers).header("x-cache", "HIT").code(hit.status)
      // Sending from a hook short-circuits the route handler.
      return reply.send(hit.body)
    }
    reply.header("x-cache", "MISS")
  }
  const onSend = async (request, reply, payload) => {
    const cacheable =
      !request[servedFromCache] &&
      applies(request) &&
      statuses.includes(reply.statusCode) &&
      // A Set-Cookie response is session-personalized — storing it in a
      // shared cache would replay one user's session artifacts to others.
      reply.getHeader("set-cookie") === undefined &&
      (typeof payload === "string" || Buffer.isBuffer(payload)) // streams skipped
    if (cacheable)
      // db.put is synchronous — safe to store without awaiting.
      valet.responseCache.set(
        key(request),
        {
          status: reply.statusCode,
          headers: pickHeaders((name) => reply.getHeader(name), headers),
          body: payload,
        },
        ttlMs,
      )
    return payload
  }
  return Object.freeze({ onRequest, onSend })
}
