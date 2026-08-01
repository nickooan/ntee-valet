import type NteeDB from "ntee-db"

/** A secondary index declared on a space. Names are space-local — the store
 * namespaces them internally, so two spaces can both declare `email`.
 * Indexing is schema-only: every index derives its value from the record on
 * write (records missing the field, and non-object values, are simply not
 * indexed). Explicit per-write index values need the raw `valet.db` escape
 * hatch. */
export interface SpaceIndexDef {
  /** Space-local index name, used in find* queries. */
  name: string
  kind: "string" | "number"
  /** Dotted path into the record the value derives from. Omitted → the
   * record field named like the index. The extractor runs on every write to
   * the store (small JSON-parse cost); derived indexes are the kind
   * valet.db.reindex() can back-fill. */
  jsonPath?: string
  /** Retention: keep only the newest N records per distinct index value
   * (0 = unlimited). */
  maxPerValue?: number
}

export interface SpaceDef {
  /** Default TTL applied by set() when the call passes no ttlMs. Counters
   * never inherit this default (their TTL is create-only and explicit). */
  ttlMs?: number
  indexes?: SpaceIndexDef[]
}

export interface LimitDef {
  /** Tokens available per key per window. */
  pool: number
  /** Fixed window length; armed by the first accepted take per key
   * (create-only — never slides under traffic). */
  windowMs: number
  /** Default cost per limit() call (1 if omitted). */
  cost?: number
}

export interface ValetOptions {
  /** Store directory (created if missing). One valet per directory per
   * process — the store is single-writer (flock). */
  dir: string
  /** Values >= this many bytes go to the blob side file. */
  blobThreshold?: number
  syncEveryWrite?: boolean
  hintEveryN?: number
  /** Cache namespaces. Names must match /^[a-zA-Z][a-zA-Z0-9_-]*$/. */
  spaces?: Record<string, SpaceDef>
  /** Fixed-window rate limiters (take-based). Same name rules as spaces. */
  limits?: Record<string, LimitDef>
  responseCache?: {
    /** Default TTL for cached responses (30_000 if omitted). */
    ttlMs?: number
  }
}

export interface SetOptions {
  /** number → that TTL; null → explicitly immortal (clears an existing TTL —
   * ntee-db's put-without-ttl semantics); undefined → the space default. */
  ttlMs?: number | null
}

export interface SpaceRecord {
  key: string
  value: unknown
}

export type Value = object | string | number | boolean | unknown[] | Buffer

/** A schema-defined cache namespace. Keys are auto-prefixed on the way in and
 * stripped from every result — callers never see the raw store keys. */
export interface Space {
  /** Synchronous write (objects are JSON-serialized). Declared indexes
   * derive their values from the record automatically. */
  set(key: string, value: Value, opts?: SetOptions): void
  /** Batched write off the event loop. NOTE: carries no TTL (ntee-db putMany
   * limitation) — setMany records are immortal. */
  setMany(items: { key: string; value: Value }[]): Promise<number>
  del(key: string): void

  /** Parsed JSON, a Buffer for binary/non-JSON values, or null if absent. */
  get(key: string): Promise<unknown | null>
  getMany(keys: string[]): Promise<(unknown | null)[]>
  has(key: string): Promise<boolean>

  /** Sorted keys in this space, optionally under a further sub-prefix. */
  keys(prefix?: string): Promise<string[]>
  records(prefix?: string): Promise<SpaceRecord[]>

  /** Primary keys whose index value equals val.
   * limit: 0/omitted = all ascending; N>0 first N; N<0 last |N| descending. */
  find(ixName: string, val: string | number, limit?: number): Promise<string[]>
  /** Whether any record in THIS space has val in the index (keys are
   * materialized internally to keep same-named indexes in other spaces from
   * leaking in). */
  findHas(ixName: string, val: string | number): Promise<boolean>
  findRecords(
    ixName: string,
    val: string | number,
    limit?: number,
  ): Promise<SpaceRecord[]>
  /** String-index prefix search; limit applies per distinct index value. */
  findPrefix(ixName: string, prefix: string, limit?: number): Promise<string[]>
  findPrefixRecords(
    ixName: string,
    prefix: string,
    limit?: number,
  ): Promise<SpaceRecord[]>
  /** Keys whose index value lies within [lo, hi]. */
  findRange(
    ixName: string,
    lo: string | number,
    hi: string | number,
  ): Promise<string[]>

  /** Atomic int64 counters on space keys. TTL is EXPLICIT only (create-only
   * semantics) — the space ttlMs default is never applied to counters. */
  incr(key: string, delta?: number, ttlMs?: number): Promise<number>
  decr(key: string, delta?: number, ttlMs?: number): Promise<number>
  /** Fill toward max; resolves to the overflow that didn't fit. */
  topup(
    key: string,
    amount: number,
    max: number,
    ttlMs?: number,
  ): Promise<number>
  /** Subtract only if the result stays >= left; true iff applied. */
  take(
    key: string,
    amount: number,
    left: number,
    ttlMs?: number,
  ): Promise<boolean>
}

export interface LimitResult {
  ok: boolean
}

export interface ResponseCacheEntry {
  status: number
  headers: Record<string, string>
  body: Buffer
}

export interface ResponseCacheApi {
  /** Synchronous store; ttlMs defaults to the configured responseCache TTL. */
  set(
    key: string,
    entry: {
      status?: number
      headers?: Record<string, string>
      body: string | Buffer
    },
    ttlMs?: number,
  ): void
  get(key: string): Promise<ResponseCacheEntry | null>
  del(key: string): void
  /** Delete cached responses and resolve to the number removed. A plain
   * string is a key prefix; with wildcards it is a glob over full cache keys
   * ("*" = one path segment, "**" = any depth) — e.g.
   * invalidate("GET /properties/*\/photos"). Default cache keys are
   * `${method} ${url}`. */
  invalidate(pattern?: string): Promise<number>
}

export interface Valet {
  readonly spaces: Record<string, Space>
  /** Lookup with a friendly error (ERR_VALET_UNKNOWN_SPACE) listing known names. */
  space(name: string): Space
  /** One atomic take against the named limiter; cost defaults to the limit's
   * configured cost (1). A refused take writes nothing. */
  limit(name: string, key: string, cost?: number): Promise<LimitResult>
  /** Tokens left for key (the full pool if the key has no live window).
   * Costs one extra read — use only when needed. */
  remaining(name: string, key: string): Promise<number>
  readonly responseCache: ResponseCacheApi
  readonly config: {
    readonly limits: Record<string, Required<LimitDef>>
    readonly responseCache: { readonly ttlMs: number }
  }
  /** The raw ntee-db handle — full store API escape hatch. Note that valet
   * spaces/limiters/response cache all live in this one store under prefixed
   * keys; prefer the scoped APIs. */
  readonly db: NteeDB
  close(): void
  /** Close and delete the store's files. */
  drop(): void
}

/**
 * Open (or create) the embedded store at options.dir and build the valet:
 * schema-defined cache spaces, take-based rate limiters, and the response
 * cache. Synchronous. Errors carry a `code` (ERR_VALET_*).
 */
export declare const createValet: (options: ValetOptions) => Valet

export default createValet
