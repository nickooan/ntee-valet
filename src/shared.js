// Helpers shared by the core and the express/fastify adapters. Private
// module — not in the package exports map.

// Path patterns: "*" matches exactly one path segment, "**" matches anything
// including "/"; a pattern without wildcards is an exact match.
//
// PERFORMANCE CONTRACT: patterns are compiled ONCE, at middleware-factory /
// boot time. The matcher returned by createPathMatcher (and the regexes from
// compilePattern) run precompiled RegExp.test only — never call
// compilePattern/createPathMatcher inside a per-request handler.
const GLOB_CHARACTERS_REGEX = /[*]/
const REGEX_ESCAPE = /[.*+?^${}()|[\]\\]/g

export const hasGlobPattern = (pattern) => GLOB_CHARACTERS_REGEX.test(pattern)

export const compilePattern = (pattern) => {
  const source = pattern
    .split(/(\*\*|\*)/)
    .map((part) =>
      part === "**"
        ? ".*"
        : part === "*"
          ? "[^/]+"
          : part.replace(REGEX_ESCAPE, "\\$&"),
    )
    .join("")
  return new RegExp(`^${source}$`)
}

// paths undefined → match everything; exclude always wins over paths.
export const createPathMatcher = (paths, exclude) => {
  const includePatterns = paths?.map(compilePattern)
  const excludePatterns = (exclude ?? []).map(compilePattern)
  return (pathname) =>
    (!includePatterns ||
      includePatterns.some((regex) => regex.test(pathname))) &&
    !excludePatterns.some((regex) => regex.test(pathname))
}

export const pathnameOf = (url) => url.split("?")[0]

// Default response-cache guard, request side: Authorization blocks caching
// entirely (RFC 9111 — a shared cache must not reuse responses to authorized
// requests). Cookie deliberately does NOT: nearly every browser request
// carries cookies, so skipping on them would disable the cache for real
// sites. The response side compensates — responses that SET a cookie are
// never stored (see the adapters). Header names are lower-cased by both
// frameworks.
export const hasAuthorizationHeader = (headers) =>
  headers.authorization !== undefined

// Default response-cache key: method + full URL (query string included).
export const defaultKey = (method, url) => `${method} ${url}`

// Lower-cased header allowlist snapshot: content-type always, plus any extras
// the caller opted into. getHeader is framework-provided (res/reply.getHeader).
export const pickHeaders = (getHeader, extra = []) =>
  Object.fromEntries(
    ["content-type", ...extra.map((h) => h.toLowerCase())]
      .map((name) => [name, getHeader(name)])
      .filter(([, v]) => v !== undefined && v !== null)
      .map(([name, v]) => [name, String(v)]),
  )

// Normalizes a res.write/res.end chunk to a Buffer (encoding may arrive as
// the callback when the encoding arg is omitted).
export const toBuffer = (chunk, encoding) =>
  Buffer.isBuffer(chunk)
    ? chunk
    : Buffer.from(chunk, typeof encoding === "string" ? encoding : "utf8")
