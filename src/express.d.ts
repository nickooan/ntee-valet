import type { Valet, ValetOptions } from "./index.js"

/** Minimal structural request/response shapes — no dependency on express
 * types. Cast the returned middleware if you want exact framework types. */
export interface MinimalRequest {
  method: string
  url: string
  originalUrl?: string
  ip?: string
  valet?: Valet
  [key: string]: unknown
}

export interface MinimalResponse {
  statusCode: number
  /** Per-response cache override, set by handler code: `true` forces the
   * response to be stored, `false` blocks it — either wins over the store
   * callback and the default policy. Leave undefined to let them decide. */
  valetCache?: boolean
  set(field: string | Record<string, string>, value?: string): this
  status(code: number): this
  json(body: unknown): unknown
  end(...args: unknown[]): unknown
  write(...args: unknown[]): boolean
  getHeader(name: string): unknown
  [key: string]: unknown
}

export type Middleware = (
  req: MinimalRequest,
  res: MinimalResponse,
  next: (err?: unknown) => void,
) => void | Promise<void>

export interface RateLimitOptions {
  /** Only apply on matching pathnames ("*" = one path segment, "**" = any
   * depth; no wildcard = exact match). Omit to apply everywhere. Patterns
   * compile once at factory time. */
  paths?: string[]
  /** Never apply on matching pathnames — wins over paths. */
  exclude?: string[]
  /** Limiter key per request (default: req.ip). */
  key?: (req: MinimalRequest) => string
  /** Cost per request: a plain number, or a per-request function — sync or
   * async (default: the limit's configured cost). Must resolve to a
   * non-negative safe integer. The take is all-or-nothing: an overshooting
   * cost is refused whole, nothing written. Body-based cost needs the body
   * parsed — mount after express.json(). */
  cost?: number | ((req: MinimalRequest) => number | Promise<number>)
  /** Also set X-RateLimit-Remaining (costs one extra read per request). */
  remainingHeader?: boolean
  /** Custom 429 handling; default sends 429 {"error":"rate limited"}. */
  onReject?: (req: MinimalRequest, res: MinimalResponse) => unknown
}

export interface CacheResponseOptions {
  /** Only cache matching pathnames ("*" = one path segment, "**" = any
   * depth; no wildcard = exact match). Omit to cache everywhere. Patterns
   * compile once at factory time. */
  paths?: string[]
  /** Never cache matching pathnames — wins over paths. */
  exclude?: string[]
  /** Override the configured response-cache TTL for this middleware. */
  ttlMs?: number
  /** Cache key per request (default: `${method} ${originalUrl}`). */
  key?: (req: MinimalRequest) => string
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
  skip?: (req: MinimalRequest) => boolean
  /** Decides whether a completed response is stored. DEFAULT:
   * `defaultStorePolicy({ statuses })`. Passing your own store REPLACES the
   * default policy entirely (including the statuses check). Handler code
   * overrides both per response via `res.valetCache = true | false`. */
  store?: (req: MinimalRequest, res: MinimalResponse, body: Buffer) => boolean
}

/** The default store decision: cacheable status (default [200]) and no
 * Set-Cookie header. Exported for composition with a custom `store`:
 * `store: (req, res, body) => defaultStorePolicy()(req, res) && ...` */
export declare const defaultStorePolicy: (options?: {
  statuses?: number[]
}) => (req: MinimalRequest, res: MinimalResponse) => boolean

/** Injects the valet as req.valet. Accepts a pre-built Valet, or createValet
 * options — with options the valet is created at boot and exposed as
 * `.valet` on the returned middleware (express has no shutdown lifecycle;
 * call middleware.valet.close() yourself). */
export declare const valetContext: (
  valetOrOptions: Valet | ValetOptions,
) => Middleware & { valet: Valet }

/** Fixed-window rate limiting on the named limit. Throws
 * ERR_VALET_UNKNOWN_LIMIT at factory time for unknown names. */
export declare const rateLimit: (
  valet: Valet,
  name: string,
  options?: RateLimitOptions,
) => Middleware

/** Serves cached responses (X-Cache: HIT) and stores misses by wrapping
 * res.write/res.end — buffered and streamed bodies both captured. */
export declare const cacheResponse: (
  valet: Valet,
  options?: CacheResponseOptions,
) => Middleware
