import type { Valet, ValetOptions } from "./index.js"

/** Minimal structural request/reply shapes — no dependency on fastify types.
 * Cast hooks if you want exact framework types. */
export interface MinimalFastifyRequest {
  method: string
  url: string
  ip?: string
  valet?: Valet
  [key: string | symbol]: unknown
}

export interface MinimalFastifyReply {
  statusCode: number
  /** Per-response cache override, set by handler code: `true` forces the
   * response to be stored, `false` blocks it — either wins over the store
   * callback and the default policy. Leave undefined to let them decide. */
  valetCache?: boolean
  header(name: string, value: string): this
  headers(values: Record<string, string>): this
  code(statusCode: number): this
  send(payload?: unknown): unknown
  getHeader(name: string): unknown
  [key: string]: unknown
}

export type Hook = (
  request: MinimalFastifyRequest,
  reply: MinimalFastifyReply,
) => Promise<unknown>

export type OnSendHook = (
  request: MinimalFastifyRequest,
  reply: MinimalFastifyReply,
  payload: unknown,
) => Promise<unknown>

export interface RateLimitOptions {
  /** Only apply on matching pathnames ("*" = one path segment, "**" = any
   * depth; no wildcard = exact match). Omit to apply everywhere. Patterns
   * compile once at factory time. */
  paths?: string[]
  /** Never apply on matching pathnames — wins over paths. */
  exclude?: string[]
  /** Limiter key per request (default: request.ip). */
  key?: (request: MinimalFastifyRequest) => string
  /** Per-request cost (default: the limit's configured cost). */
  cost?: (request: MinimalFastifyRequest) => number
  /** Also set x-ratelimit-remaining (costs one extra read per request). */
  remainingHeader?: boolean
  /** Custom 429 handling; default sends 429 {"error":"rate limited"}. */
  onReject?: (
    request: MinimalFastifyRequest,
    reply: MinimalFastifyReply,
  ) => unknown
}

export interface CacheResponseOptions {
  /** Only cache matching pathnames ("*" = one path segment, "**" = any
   * depth; no wildcard = exact match). Omit to cache everywhere. Patterns
   * compile once at factory time. */
  paths?: string[]
  /** Never cache matching pathnames — wins over paths. */
  exclude?: string[]
  /** Override the configured response-cache TTL for these hooks. */
  ttlMs?: number
  /** Cache key per request (default: `${method} ${url}`). */
  key?: (request: MinimalFastifyRequest) => string
  /** Methods eligible for caching (default ["GET"]). */
  methods?: string[]
  /** Response statuses worth storing (default [200]). */
  statuses?: number[]
  /** Extra response headers to replay on hits (content-type is always kept). */
  headers?: string[]
  /** Return true to bypass the cache for a request (neither served nor
   * stored). DEFAULT: skips requests carrying an Authorization header
   * (RFC 9111 shared-cache rule). Cookie-carrying requests participate —
   * but the default store policy refuses Set-Cookie responses. Passing your
   * own skip REPLACES the Authorization guard — `skip: () => false` opts
   * authorized requests back in (then fold identity into `key`). */
  skip?: (request: MinimalFastifyRequest) => boolean
  /** Decides whether a completed response is stored. DEFAULT:
   * `defaultStorePolicy({ statuses })`. Passing your own store REPLACES the
   * default policy entirely (including the statuses check). Handler code
   * overrides both per response via `reply.valetCache = true | false`. */
  store?: (
    request: MinimalFastifyRequest,
    reply: MinimalFastifyReply,
    payload: string | Buffer,
  ) => boolean
}

/** The default store decision: cacheable status (default [200]) and no
 * Set-Cookie header. Exported for composition with a custom `store`:
 * `store: (request, reply, payload) => defaultStorePolicy()(request, reply) && ...` */
export declare const defaultStorePolicy: (options?: {
  statuses?: number[]
}) => (request: MinimalFastifyRequest, reply: MinimalFastifyReply) => boolean

/** fp-wrapped plugin decorating app.valet and request.valet on the ROOT
 * instance (fastify-plugin breaks register() encapsulation). Register with
 * a pre-built valet — `app.register(valetPlugin, { valet })` — or with
 * createValet options — `app.register(valetPlugin, { dir, spaces, limits })`
 * — in which case the valet is created at boot and auto-closed on
 * app.close(). */
export declare const valetPlugin: (
  app: unknown,
  options: { valet: Valet } | ValetOptions,
) => Promise<void>

/** A preHandler hook enforcing the named limit. Throws
 * ERR_VALET_UNKNOWN_LIMIT at factory time for unknown names. */
export declare const rateLimit: (
  valet: Valet,
  name: string,
  options?: RateLimitOptions,
) => Hook

/** Response caching as an { onRequest, onSend } hook pair — use per-route in
 * route options, or globally via addHook on the root instance. onSend only
 * stores string/Buffer payloads (streams pass through uncached). */
export declare const cacheResponse: (
  valet: Valet,
  options?: CacheResponseOptions,
) => { onRequest: Hook; onSend: OnSendHook }
