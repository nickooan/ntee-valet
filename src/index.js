// ntee-valet core: one embedded ntee-db store presented as schema-defined
// cache "spaces" (key-prefix namespaces with per-space TTL defaults and
// auto-namespaced secondary indexes), take-based fixed-window rate limiters,
// and a reserved response-cache store the express/fastify adapters build on.
// Everything is a const-arrow factory returning a frozen plain object.
import NteeDB from "ntee-db"
import { compilePattern, hasGlobPattern } from "./shared.js"

// Space/limit names may not start with "_" (reserves __resp:/__rl: key
// prefixes) nor contain ":" (the space/key separator) or "." (the
// space/index-name separator).
const NAME_REGEX = /^[a-zA-Z][a-zA-Z0-9_-]*$/

const valetError = (code, message) =>
  Object.assign(new Error(message), { code })

const assertName = (kind, name) => {
  if (!NAME_REGEX.test(name))
    throw valetError(
      "ERR_VALET_BAD_NAME",
      `${kind} name ${JSON.stringify(name)} must match ${NAME_REGEX} — ` +
        `names starting with "_" are reserved, ":" and "." are separators`,
    )
}

const createSpace = (database, spaceName, definition = {}) => {
  const prefix = `${spaceName}:`
  const declaredIndexes = new Set(
    (definition.indexes ?? []).map((index) => index.name),
  )
  const prefixedKey = (key) => prefix + key
  const stripPrefix = (key) => key.slice(prefix.length)
  const fullIndexName = (indexName) => {
    if (!declaredIndexes.has(indexName))
      throw valetError(
        "ERR_VALET_UNKNOWN_INDEX",
        `space "${spaceName}" has no index "${indexName}" ` +
          `(declared: ${[...declaredIndexes].join(", ") || "none"})`,
      )
    return `${spaceName}.${indexName}`
  }
  // ttlMs: null → explicitly immortal (and clears an existing TTL — ntee-db's
  // put-without-ttl semantics); undefined → the space default; number → itself.
  const resolveTtl = (ttlMs) =>
    ttlMs === null ? undefined : (ttlMs ?? definition.ttlMs)
  // Derived (jsonPath) indexes are store-global: the extractor runs on EVERY
  // write, so another space's record carrying the same field lands in this
  // space's index too. Keep reads isolated by filtering to this space's keys.
  const ownKeys = (keys) =>
    keys.filter((key) => key.startsWith(prefix)).map(stripPrefix)
  const ownRecords = (records) =>
    records
      .filter(({ key }) => key.startsWith(prefix))
      .map(({ key, value }) => ({ key: stripPrefix(key), value }))
  const stripRecords = (records) =>
    records.map(({ key, value }) => ({ key: stripPrefix(key), value }))

  return Object.freeze({
    // Indexing is schema-only: every declared index derives its value from
    // the record via jsonPath (see createValet), so writes carry no index
    // values. Explicit values need the raw valet.db escape hatch.
    set: (key, value, { ttlMs } = {}) =>
      database.put(prefixedKey(key), value, undefined, resolveTtl(ttlMs)),
    // ntee-db's putMany carries no TTL — setMany records are immortal.
    setMany: (items) =>
      database.putMany(
        items.map(({ key, value }) => ({ key: prefixedKey(key), value })),
      ),
    del: (key) => database.delete(prefixedKey(key)),
    get: (key) => database.get(prefixedKey(key)),
    getMany: (keys) => database.getMany(keys.map(prefixedKey)),
    has: (key) => database.has(prefixedKey(key)),

    keys: async (subPrefix = "") =>
      (await database.prefixScan(prefixedKey(subPrefix))).map(stripPrefix),
    records: async (subPrefix = "") =>
      stripRecords(await database.prefixScanRecords(prefixedKey(subPrefix))),

    find: async (indexName, value, limit) =>
      ownKeys(await database.secIndex(fullIndexName(indexName), value, limit)),
    // Keys must be materialized (not secIndexHas): a same-named index in
    // another space could otherwise answer true for records that aren't ours.
    findHas: async (indexName, value) =>
      ownKeys(await database.secIndex(fullIndexName(indexName), value)).length >
      0,
    findRecords: async (indexName, value, limit) =>
      ownRecords(
        await database.secIndexRecords(fullIndexName(indexName), value, limit),
      ),
    findPrefix: async (indexName, valuePrefix, limit) =>
      ownKeys(
        await database.secIndexPrefix(
          fullIndexName(indexName),
          valuePrefix,
          limit,
        ),
      ),
    findPrefixRecords: async (indexName, valuePrefix, limit) =>
      ownRecords(
        await database.secIndexPrefixRecords(
          fullIndexName(indexName),
          valuePrefix,
          limit,
        ),
      ),
    findRange: async (indexName, low, high) =>
      ownKeys(
        await database.secIndexRange(fullIndexName(indexName), low, high),
      ),

    // Counter TTL is create-only in ntee-db, so the space ttlMs default is
    // deliberately NOT applied here — a silently-armed window would surprise.
    incr: (key, delta, ttlMs) => database.incr(prefixedKey(key), delta, ttlMs),
    decr: (key, delta, ttlMs) => database.decr(prefixedKey(key), delta, ttlMs),
    topup: (key, amount, max, ttlMs) =>
      database.topup(prefixedKey(key), amount, max, ttlMs),
    take: (key, amount, left, ttlMs) =>
      database.take(prefixedKey(key), amount, left, ttlMs),
  })
}

// A counter reads back as a fixed-width signed-digit Buffer (not JSON) —
// parseInt handles the "+"/"-" sign and leading zeros.
const counterValue = (raw) =>
  typeof raw === "number" ? raw : Number.parseInt(raw.toString(), 10)

const createLimiter = (database, limitName, { pool, windowMs, cost = 1 }) => {
  const prefixedKey = (key) => `__rl:${limitName}:${key}`
  // The canonical ntee-db pattern: count 0 → -pool; the first accepted take
  // arms the create-only window TTL; a refused take writes nothing.
  const limit = async (key, amount = cost) => ({
    ok: await database.take(prefixedKey(key), amount, -pool, windowMs),
  })
  // Read with get(), never incr(key, 0): incr on a missing key would create an
  // immortal counter at 0 and take's create-only TTL could never arm a window.
  const remaining = async (key) => {
    const raw = await database.get(prefixedKey(key))
    return raw === null ? pool : pool + counterValue(raw)
  }
  return Object.freeze({ limit, remaining })
}

const createResponseCache = (database, defaultTtlMs) => {
  const prefixedKey = (key) => `__resp:${key}`
  const stripPrefix = (key) => key.slice("__resp:".length)
  // Body is stored utf8 when the bytes round-trip through a JS string,
  // base64 otherwise (images, gzip, …).
  const set = (key, { status = 200, headers = {}, body }, ttlMs) => {
    const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body ?? "")
    const utf8 = buffer.toString("utf8")
    const roundTrips = Buffer.from(utf8, "utf8").equals(buffer)
    database.put(
      prefixedKey(key),
      {
        s: status,
        h: headers,
        b: roundTrips ? utf8 : buffer.toString("base64"),
        e: roundTrips ? "utf8" : "base64",
      },
      undefined,
      ttlMs ?? defaultTtlMs,
    )
  }
  const get = async (key) => {
    const entry = await database.get(prefixedKey(key))
    if (entry === null || Buffer.isBuffer(entry)) return null
    return {
      status: entry.s,
      headers: entry.h,
      body: Buffer.from(entry.b, entry.e),
    }
  }
  const del = (key) => database.delete(prefixedKey(key))
  // Plain string → prefix match; "*" (one path segment) and "**" (any depth)
  // make it a glob over full cache keys, e.g. "GET /properties/*/photos".
  const invalidate = async (pattern = "") => {
    if (!hasGlobPattern(pattern)) {
      const keys = await database.prefixScan(prefixedKey(pattern))
      keys.forEach((key) => database.delete(key))
      return keys.length
    }
    const literalPrefix = pattern.slice(0, pattern.indexOf("*"))
    const patternRegex = compilePattern(pattern)
    const scanned = await database.prefixScan(prefixedKey(literalPrefix))
    const matched = scanned.filter((key) => patternRegex.test(stripPrefix(key)))
    matched.forEach((key) => database.delete(key))
    return matched.length
  }
  return Object.freeze({ set, get, del, invalidate })
}

export const createValet = ({
  dir,
  blobThreshold,
  syncEveryWrite,
  hintEveryN,
  spaces = {},
  limits = {},
  responseCache = {},
} = {}) => {
  if (!dir)
    throw valetError("ERR_VALET_BAD_OPTIONS", "createValet requires { dir }")
  Object.keys(spaces).forEach((name) => assertName("space", name))
  Object.keys(limits).forEach((name) => assertName("limit", name))

  // ntee-db fixes indexes at open() and index names are store-global, so every
  // space's indexes are declared up front under namespaced names. Indexing is
  // schema-only: an index without a jsonPath derives from the record field
  // named like the index, so every write indexes automatically.
  const resolveJsonPath = (index) => index.jsonPath ?? index.name
  const indexes = Object.entries(spaces).flatMap(([spaceName, definition]) =>
    (definition.indexes ?? []).map((index) => ({
      ...index,
      name: `${spaceName}.${index.name}`,
      jsonPath: resolveJsonPath(index),
    })),
  )
  const database = NteeDB.open(dir, {
    blobThreshold,
    syncEveryWrite,
    hintEveryN,
    indexes,
  })

  const spaceMap = Object.freeze(
    Object.fromEntries(
      Object.entries(spaces).map(([spaceName, definition]) => [
        spaceName,
        createSpace(database, spaceName, definition),
      ]),
    ),
  )
  const limiters = Object.fromEntries(
    Object.entries(limits).map(([limitName, definition]) => [
      limitName,
      createLimiter(database, limitName, definition),
    ]),
  )
  const limiterOf = (limitName) => {
    const limiter = limiters[limitName]
    if (!limiter)
      throw valetError(
        "ERR_VALET_UNKNOWN_LIMIT",
        `unknown limit "${limitName}" ` +
          `(known: ${Object.keys(limiters).join(", ") || "none"})`,
      )
    return limiter
  }
  const responseCacheTtlMs = responseCache.ttlMs ?? 30_000

  return Object.freeze({
    spaces: spaceMap,
    space: (spaceName) => {
      const space = spaceMap[spaceName]
      if (!space)
        throw valetError(
          "ERR_VALET_UNKNOWN_SPACE",
          `unknown space "${spaceName}" ` +
            `(known: ${Object.keys(spaceMap).join(", ") || "none"})`,
        )
      return space
    },
    limit: (limitName, key, cost) => limiterOf(limitName).limit(key, cost),
    remaining: (limitName, key) => limiterOf(limitName).remaining(key),
    responseCache: createResponseCache(database, responseCacheTtlMs),
    config: Object.freeze({
      limits: Object.freeze(
        Object.fromEntries(
          Object.entries(limits).map(([limitName, definition]) => [
            limitName,
            Object.freeze({ cost: 1, ...definition }),
          ]),
        ),
      ),
      responseCache: Object.freeze({ ttlMs: responseCacheTtlMs }),
    }),
    db: database,
    close: () => database.close(),
    drop: () => database.drop(),
  })
}

export default createValet
