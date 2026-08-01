// Express adapter: context injection, rate-limit middleware headers/429, and
// response caching (MISS→HIT, TTL expiry, method/status bypass, invalidation)
// against a real express app on an ephemeral port.
import { test } from "node:test"
import assert from "node:assert/strict"
import express from "express"
import { valetContext, rateLimit, cacheResponse } from "../src/express.js"
import { withValet, eventually } from "./harness.mjs"

const withServer = async (app, fn) => {
  const server = app.listen(0)
  await new Promise((resolve) => server.once("listening", resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    await fn(base)
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

test("valetContext injects req.valet", async () => {
  await withValet({ spaces: { user: {} } }, async (valet) => {
    const app = express()
    app.use(valetContext(valet))
    app.get("/who", async (req, res) => {
      req.valet.spaces.user.set("u1", { seen: true })
      res.json(await req.valet.spaces.user.get("u1"))
    })
    await withServer(app, async (base) => {
      const r = await fetch(`${base}/who`)
      assert.deepEqual(await r.json(), { seen: true })
    })
  })
})

test("rateLimit: accepts under pool, 429 with headers when exhausted", async () => {
  const limits = { api: { pool: 2, windowMs: 60_000 } }
  await withValet({ limits }, async (valet) => {
    const app = express()
    app.get(
      "/limited",
      rateLimit(valet, "api", { key: () => "fixed", remainingHeader: true }),
      (req, res) => res.json({ ok: true }),
    )
    await withServer(app, async (base) => {
      const first = await fetch(`${base}/limited`)
      assert.equal(first.status, 200)
      assert.equal(first.headers.get("x-ratelimit-limit"), "2")
      assert.equal(first.headers.get("x-ratelimit-remaining"), "1")

      await fetch(`${base}/limited`)
      const rejected = await fetch(`${base}/limited`)
      assert.equal(rejected.status, 429)
      assert.equal(rejected.headers.get("retry-after"), "60")
      assert.deepEqual(await rejected.json(), { error: "rate limited" })
    })
  })
})

test("rateLimit: unknown limit name throws at factory time", async () => {
  await withValet({}, async (valet) => {
    assert.throws(() => rateLimit(valet, "nope"), {
      code: "ERR_VALET_UNKNOWN_LIMIT",
    })
  })
})

test("cacheResponse: MISS then HIT with identical body, POST bypass", async () => {
  await withValet({}, async (valet) => {
    let handlerCalls = 0
    const app = express()
    app.use(cacheResponse(valet))
    app.get("/data", (req, res) => {
      handlerCalls++
      res.json({ n: handlerCalls })
    })
    app.post("/data", (req, res) => res.json({ posted: true }))

    await withServer(app, async (base) => {
      const miss = await fetch(`${base}/data`)
      assert.equal(miss.headers.get("x-cache"), "MISS")
      assert.deepEqual(await miss.json(), { n: 1 })

      const hit = await fetch(`${base}/data`)
      assert.equal(hit.headers.get("x-cache"), "HIT")
      assert.equal(
        hit.headers.get("content-type"),
        "application/json; charset=utf-8",
      )
      assert.deepEqual(await hit.json(), { n: 1 }) // served from cache, not the handler
      assert.equal(handlerCalls, 1)

      const post = await fetch(`${base}/data`, { method: "POST" })
      assert.equal(post.headers.get("x-cache"), null)
      assert.deepEqual(await post.json(), { posted: true })
    })
  })
})

test("cacheResponse: streamed res.write body is captured too", async () => {
  await withValet({}, async (valet) => {
    const app = express()
    app.use(cacheResponse(valet))
    app.get("/stream", (req, res) => {
      res.set("Content-Type", "text/plain")
      res.write("part1-")
      res.write("part2-")
      res.end("part3")
    })
    await withServer(app, async (base) => {
      assert.equal(
        await (await fetch(`${base}/stream`)).text(),
        "part1-part2-part3",
      )
      const hit = await fetch(`${base}/stream`)
      assert.equal(hit.headers.get("x-cache"), "HIT")
      assert.equal(await hit.text(), "part1-part2-part3")
    })
  })
})

test("cacheResponse: non-200 responses are not stored", async () => {
  await withValet({}, async (valet) => {
    let calls = 0
    const app = express()
    app.use(cacheResponse(valet))
    app.get("/flaky", (req, res) => {
      calls++
      if (calls === 1) return res.status(500).json({ err: true })
      res.json({ recovered: true })
    })
    await withServer(app, async (base) => {
      assert.equal((await fetch(`${base}/flaky`)).status, 500)
      const second = await fetch(`${base}/flaky`)
      assert.equal(second.status, 200) // the 500 was not served from cache
      assert.deepEqual(await second.json(), { recovered: true })
    })
  })
})

test("cacheResponse: TTL expiry and manual invalidation", async () => {
  await withValet({ responseCache: { ttlMs: 80 } }, async (valet) => {
    let calls = 0
    const app = express()
    app.use(cacheResponse(valet))
    app.get("/short", (req, res) => res.json({ call: ++calls }))
    app.get("/manual", (req, res) => res.json({ call: ++calls }))

    await withServer(app, async (base) => {
      await fetch(`${base}/short`)
      assert.ok(
        await eventually(async () => {
          const r = await fetch(`${base}/short`)
          return r.headers.get("x-cache") === "MISS"
        }),
        "cache entry should expire back to MISS",
      )

      await fetch(`${base}/manual`)
      await valet.responseCache.invalidate("GET /manual")
      const after = await fetch(`${base}/manual`)
      assert.equal(after.headers.get("x-cache"), "MISS")
    })
  })
})

test("cacheResponse paths: only matching namespaces cached; exclude wins", async () => {
  await withValet({}, async (valet) => {
    const app = express()
    app.use(
      cacheResponse(valet, {
        paths: ["/api/**"],
        exclude: ["/api/internal/**"],
      }),
    )
    app.get("/api/items", (req, res) => res.json({ cached: true }))
    app.get("/api/internal/jobs", (req, res) => res.json({ secret: true }))
    app.get("/other", (req, res) => res.json({ plain: true }))

    await withServer(app, async (base) => {
      await fetch(`${base}/api/items`)
      const hit = await fetch(`${base}/api/items`)
      assert.equal(hit.headers.get("x-cache"), "HIT")

      // Excluded and non-matching paths never touch the cache.
      for (const path of ["/api/internal/jobs", "/other"]) {
        await fetch(`${base}${path}`)
        const second = await fetch(`${base}${path}`)
        assert.equal(second.headers.get("x-cache"), null, path)
      }
    })
  })
})

test("cacheResponse paths: query string does not break segment matching", async () => {
  await withValet({}, async (valet) => {
    const app = express()
    app.use(cacheResponse(valet, { paths: ["/api/*"] }))
    app.get("/api/items", (req, res) => res.json({ ok: true }))
    await withServer(app, async (base) => {
      await fetch(`${base}/api/items?page=1`)
      const hit = await fetch(`${base}/api/items?page=1`)
      assert.equal(hit.headers.get("x-cache"), "HIT")
    })
  })
})

test("rateLimit paths: non-matching requests cost no token and get no headers", async () => {
  const limits = { api: { pool: 1, windowMs: 60_000 } }
  await withValet({ limits }, async (valet) => {
    const app = express()
    app.use(rateLimit(valet, "api", { key: () => "k", paths: ["/api/**"] }))
    app.get("/api/x", (req, res) => res.json({ ok: true }))
    app.get("/free", (req, res) => res.json({ free: true }))

    await withServer(app, async (base) => {
      const free = await fetch(`${base}/free`)
      assert.equal(free.status, 200)
      assert.equal(free.headers.get("x-ratelimit-limit"), null)
      assert.equal(await valet.remaining("api", "k"), 1) // untouched

      assert.equal((await fetch(`${base}/api/x`)).status, 200)
      assert.equal((await fetch(`${base}/api/x`)).status, 429)
      assert.equal((await fetch(`${base}/free`)).status, 200) // still free
    })
  })
})

test("valetContext(options) creates the valet and exposes it on the middleware", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises")
  const { tmpdir } = await import("node:os")
  const path = await import("node:path")
  const dir = await mkdtemp(path.join(tmpdir(), "valet-boot-"))
  const context = valetContext({
    dir,
    spaces: { user: {} },
    limits: { api: { pool: 3, windowMs: 60_000 } },
  })
  try {
    const app = express()
    app.use(context)
    app.use(rateLimit(context.valet, "api"))
    app.get("/who", async (req, res) => {
      req.valet.spaces.user.set("u1", { booted: true })
      res.json(await req.valet.spaces.user.get("u1"))
    })
    await withServer(app, async (base) => {
      const response = await fetch(`${base}/who`)
      assert.deepEqual(await response.json(), { booted: true })
    })
  } finally {
    context.valet.close()
    await rm(dir, { recursive: true, force: true })
  }
})

test("cacheResponse defaults: Authorization bypasses; cookies participate; Set-Cookie responses not stored", async () => {
  await withValet({}, async (valet) => {
    let calls = 0
    const app = express()
    app.use(cacheResponse(valet))
    app.get("/me", (req, res) => res.json({ call: ++calls }))
    app.get("/login", (req, res) => {
      res.set("Set-Cookie", "session=abc").json({ session: ++calls })
    })

    await withServer(app, async (base) => {
      // Anonymous request warms the cache.
      const anonymous = await fetch(`${base}/me`)
      assert.equal(anonymous.headers.get("x-cache"), "MISS")

      // Authorization: never served the cached body, never stored.
      const authorized = await fetch(`${base}/me`, {
        headers: { authorization: "Bearer t" },
      })
      assert.equal(authorized.headers.get("x-cache"), null)
      assert.deepEqual(await authorized.json(), { call: 2 })

      // A plain Cookie header does NOT bypass — browsers send cookies on
      // nearly every request; the guard is on Set-Cookie responses instead.
      const withCookie = await fetch(`${base}/me`, {
        headers: { cookie: "tracking=xyz" },
      })
      assert.equal(withCookie.headers.get("x-cache"), "HIT")
      assert.deepEqual(await withCookie.json(), { call: 1 })

      // A response that SETS a cookie is session-personalized → not stored.
      const login = await fetch(`${base}/login`)
      assert.equal(login.headers.get("x-cache"), "MISS")
      const loginAgain = await fetch(`${base}/login`)
      assert.equal(loginAgain.headers.get("x-cache"), "MISS") // handler re-ran
      assert.deepEqual(await loginAgain.json(), { session: calls })
    })

    // Explicit opt-out of the guard restores caching for authorized
    // requests (deliberate choice, e.g. identity folded into the key).
    const optedApp = express()
    optedApp.use(
      cacheResponse(valet, { skip: () => false, key: () => "opted" }),
    )
    optedApp.get("/opted", (req, res) => res.json({ opted: true }))
    await withServer(optedApp, async (base) => {
      await fetch(`${base}/opted`, { headers: { authorization: "Bearer t" } })
      const optedHit = await fetch(`${base}/opted`, {
        headers: { authorization: "Bearer t" },
      })
      assert.equal(optedHit.headers.get("x-cache"), "HIT")
    })
  })
})

test("store decision: valetCache flag wins; store callback replaces default policy", async () => {
  await withValet({}, async (valet) => {
    let calls = 0
    const app = express()
    app.use(cacheResponse(valet))
    app.get("/never", (req, res) => {
      res.valetCache = false // explicit: don't store this 200
      res.json({ call: ++calls })
    })
    app.get("/always", (req, res) => {
      res.valetCache = true // explicit: store despite the default policy
      res.status(404).json({ negative: "cached" })
    })

    await withServer(app, async (base) => {
      await fetch(`${base}/never`)
      const second = await fetch(`${base}/never`)
      assert.equal(second.headers.get("x-cache"), "MISS") // handler re-ran
      assert.deepEqual(await second.json(), { call: 2 })

      assert.equal((await fetch(`${base}/always`)).status, 404)
      const negativeHit = await fetch(`${base}/always`)
      assert.equal(negativeHit.headers.get("x-cache"), "HIT")
      assert.equal(negativeHit.status, 404)
    })

    // A custom store callback fully replaces the default policy.
    const customApp = express()
    customApp.use(
      cacheResponse(valet, {
        store: (req, res) => res.statusCode === 201,
      }),
    )
    customApp.get("/created", (req, res) => res.status(201).json({ ok: 1 }))
    customApp.get("/plain", (req, res) => res.json({ ok: 2 }))
    await withServer(customApp, async (base) => {
      await fetch(`${base}/created`)
      const createdHit = await fetch(`${base}/created`)
      assert.equal(createdHit.headers.get("x-cache"), "HIT")
      assert.equal(createdHit.status, 201)

      await fetch(`${base}/plain`)
      const plainAgain = await fetch(`${base}/plain`)
      assert.equal(plainAgain.headers.get("x-cache"), "MISS") // 200 not stored
    })
  })
})

test("dynamic cost: per-request and async cost functions", async () => {
  const limits = { api: { pool: 10, windowMs: 60_000 } }
  await withValet({ limits }, async (valet) => {
    const app = express()
    app.get(
      "/work",
      rateLimit(valet, "api", {
        key: () => "k",
        // Async on purpose — proves the middleware awaits the cost decider.
        cost: async (req) => Number(req.headers["x-cost"]),
      }),
      (req, res) => res.json({ ok: true }),
    )

    await withServer(app, async (base) => {
      const request = (cost) =>
        fetch(`${base}/work`, { headers: { "x-cost": String(cost) } })

      assert.equal((await request(4)).status, 200)
      assert.equal(await valet.remaining("api", "k"), 6)
      assert.equal((await request(6)).status, 200)
      assert.equal(await valet.remaining("api", "k"), 0)

      // Overshooting cost is refused whole — nothing written.
      assert.equal((await request(1)).status, 429)
      assert.equal(await valet.remaining("api", "k"), 0)
    })
  })
})
