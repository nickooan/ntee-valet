// Fastify adapter: fp plugin decoration reaching root routes, rate-limit
// preHandler (per-route and global), and response caching hooks — all via
// app.inject(), no ports.
import { test } from "node:test"
import assert from "node:assert/strict"
import Fastify from "fastify"
import { valetPlugin, rateLimit, cacheResponse } from "../src/fastify.js"
import { withValet, eventually } from "./harness.mjs"

const withApp = async (fn) => {
  const app = Fastify()
  try {
    await fn(app)
  } finally {
    await app.close()
  }
}

test("valetPlugin decorates app and request on the root instance", async () => {
  await withValet({ spaces: { user: {} } }, async (valet) => {
    await withApp(async (app) => {
      await app.register(valetPlugin, { valet })
      // Route on the ROOT instance still sees the decorators — proves the
      // fp encapsulation-break (a plain plugin would keep them scoped).
      app.get("/who", async (request) => {
        request.valet.spaces.user.set("u1", { seen: true })
        return request.valet.spaces.user.get("u1")
      })
      assert.equal(app.valet, valet)
      const r = await app.inject({ method: "GET", url: "/who" })
      assert.deepEqual(r.json(), { seen: true })
    })
  })
})

test("rateLimit as per-route preHandler: 429 + headers when exhausted", async () => {
  const limits = { api: { pool: 2, windowMs: 60_000 } }
  await withValet({ limits }, async (valet) => {
    await withApp(async (app) => {
      app.get(
        "/limited",
        {
          preHandler: rateLimit(valet, "api", {
            key: () => "fixed",
            remainingHeader: true,
          }),
        },
        async () => ({ ok: true }),
      )
      const first = await app.inject({ method: "GET", url: "/limited" })
      assert.equal(first.statusCode, 200)
      assert.equal(first.headers["x-ratelimit-limit"], "2")
      assert.equal(first.headers["x-ratelimit-remaining"], "1")

      await app.inject({ method: "GET", url: "/limited" })
      const rejected = await app.inject({ method: "GET", url: "/limited" })
      assert.equal(rejected.statusCode, 429)
      assert.equal(rejected.headers["retry-after"], "60")
      assert.deepEqual(rejected.json(), { error: "rate limited" })
    })
  })
})

test("rateLimit as a global addHook applies to every route", async () => {
  const limits = { api: { pool: 1, windowMs: 60_000 } }
  await withValet({ limits }, async (valet) => {
    await withApp(async (app) => {
      app.addHook("preHandler", rateLimit(valet, "api", { key: () => "all" }))
      app.get("/a", async () => ({ route: "a" }))
      app.get("/b", async () => ({ route: "b" }))
      assert.equal((await app.inject({ url: "/a" })).statusCode, 200)
      assert.equal((await app.inject({ url: "/b" })).statusCode, 429)
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

test("hook order: preHandler limiter is free for cache hits; onRequest-first counts them", async () => {
  const limits = { api: { pool: 2, windowMs: 60_000 } }

  // preHandler limiter: onRequest cache hits short-circuit before it runs.
  await withValet({ limits }, async (valet) => {
    await withApp(async (app) => {
      const cache = cacheResponse(valet)
      app.addHook("onRequest", cache.onRequest)
      app.addHook("onSend", cache.onSend)
      app.addHook("preHandler", rateLimit(valet, "api", { key: () => "k" }))
      app.get("/x", async () => ({ v: 1 }))
      for (let i = 0; i < 5; i++) {
        assert.equal((await app.inject({ url: "/x" })).statusCode, 200)
      }
    })
  })

  // Limiter registered as onRequest BEFORE the cache: hits cost a token
  // (the README's documented ordering).
  await withValet({ limits }, async (valet) => {
    await withApp(async (app) => {
      const cache = cacheResponse(valet)
      app.addHook("onRequest", rateLimit(valet, "api", { key: () => "k" }))
      app.addHook("onRequest", cache.onRequest)
      app.addHook("onSend", cache.onSend)
      app.get("/x", async () => ({ v: 1 }))
      assert.equal((await app.inject({ url: "/x" })).statusCode, 200)
      assert.equal((await app.inject({ url: "/x" })).statusCode, 200)
      assert.equal((await app.inject({ url: "/x" })).statusCode, 429)
    })
  })
})

test("cacheResponse per-route: MISS → HIT, handler not re-run, POST bypass", async () => {
  await withValet({}, async (valet) => {
    await withApp(async (app) => {
      const cache = cacheResponse(valet)
      let calls = 0
      app.get(
        "/data",
        { onRequest: cache.onRequest, onSend: cache.onSend },
        async () => ({ n: ++calls }),
      )
      app.post(
        "/data",
        { onRequest: cache.onRequest, onSend: cache.onSend },
        async () => ({ posted: true }),
      )

      const miss = await app.inject({ url: "/data" })
      assert.equal(miss.headers["x-cache"], "MISS")
      assert.deepEqual(miss.json(), { n: 1 })

      const hit = await app.inject({ url: "/data" })
      assert.equal(hit.headers["x-cache"], "HIT")
      assert.deepEqual(hit.json(), { n: 1 })
      assert.equal(calls, 1)
      assert.match(hit.headers["content-type"], /application\/json/)

      const post = await app.inject({ method: "POST", url: "/data" })
      assert.equal(post.headers["x-cache"], undefined)
      assert.deepEqual(post.json(), { posted: true })
    })
  })
})

test("cacheResponse global hooks: hit responses are not re-stored", async () => {
  await withValet({}, async (valet) => {
    await withApp(async (app) => {
      const cache = cacheResponse(valet)
      app.addHook("onRequest", cache.onRequest)
      app.addHook("onSend", cache.onSend)
      app.get("/x", async () => ({ v: 1 }))

      await app.inject({ url: "/x" })
      const before = await valet.responseCache.get("GET /x")
      await app.inject({ url: "/x" }) // HIT — must not overwrite the entry
      const after = await valet.responseCache.get("GET /x")
      assert.deepEqual(after, before)
    })
  })
})

test("cacheResponse: non-200 not stored; TTL expires back to MISS", async () => {
  await withValet({ responseCache: { ttlMs: 80 } }, async (valet) => {
    await withApp(async (app) => {
      const cache = cacheResponse(valet)
      app.addHook("onRequest", cache.onRequest)
      app.addHook("onSend", cache.onSend)
      let calls = 0
      app.get("/flaky", async (request, reply) => {
        calls++
        if (calls === 1) return reply.code(500).send({ err: true })
        return { recovered: true }
      })
      assert.equal((await app.inject({ url: "/flaky" })).statusCode, 500)
      const second = await app.inject({ url: "/flaky" })
      assert.equal(second.statusCode, 200) // 500 was not cached

      assert.ok(
        await eventually(async () => {
          const r = await app.inject({ url: "/flaky" })
          return r.headers["x-cache"] === "MISS"
        }),
        "entry should expire back to MISS",
      )
    })
  })
})

test("cacheResponse: Buffer payload round-trips via the base64 path", async () => {
  await withValet({}, async (valet) => {
    await withApp(async (app) => {
      const cache = cacheResponse(valet)
      const binary = Buffer.from([0xff, 0x00, 0xfe, 0x01])
      app.get(
        "/bin",
        { onRequest: cache.onRequest, onSend: cache.onSend },
        async (request, reply) => {
          reply.type("application/octet-stream")
          return binary
        },
      )
      const miss = await app.inject({ url: "/bin" })
      assert.deepEqual(miss.rawPayload, binary)
      const hit = await app.inject({ url: "/bin" })
      assert.equal(hit.headers["x-cache"], "HIT")
      assert.deepEqual(hit.rawPayload, binary)
      assert.equal(hit.headers["content-type"], "application/octet-stream")
    })
  })
})

test("cacheResponse paths: only matching namespaces cached; exclude wins", async () => {
  await withValet({}, async (valet) => {
    await withApp(async (app) => {
      const cache = cacheResponse(valet, {
        paths: ["/api/**"],
        exclude: ["/api/internal/**"],
      })
      app.addHook("onRequest", cache.onRequest)
      app.addHook("onSend", cache.onSend)
      app.get("/api/items", async () => ({ cached: true }))
      app.get("/api/internal/jobs", async () => ({ secret: true }))
      app.get("/other", async () => ({ plain: true }))

      await app.inject({ url: "/api/items" })
      const hit = await app.inject({ url: "/api/items" })
      assert.equal(hit.headers["x-cache"], "HIT")

      for (const url of ["/api/internal/jobs", "/other"]) {
        await app.inject({ url })
        const second = await app.inject({ url })
        assert.equal(second.headers["x-cache"], undefined, url)
      }
    })
  })
})

test("cacheResponse paths: query string does not break segment matching", async () => {
  await withValet({}, async (valet) => {
    await withApp(async (app) => {
      const cache = cacheResponse(valet, { paths: ["/api/*"] })
      app.addHook("onRequest", cache.onRequest)
      app.addHook("onSend", cache.onSend)
      app.get("/api/items", async () => ({ ok: true }))
      await app.inject({ url: "/api/items?page=1" })
      const hit = await app.inject({ url: "/api/items?page=1" })
      assert.equal(hit.headers["x-cache"], "HIT")
    })
  })
})

test("rateLimit paths: non-matching requests cost no token and get no headers", async () => {
  const limits = { api: { pool: 1, windowMs: 60_000 } }
  await withValet({ limits }, async (valet) => {
    await withApp(async (app) => {
      app.addHook(
        "preHandler",
        rateLimit(valet, "api", { key: () => "k", paths: ["/api/**"] }),
      )
      app.get("/api/x", async () => ({ ok: true }))
      app.get("/free", async () => ({ free: true }))

      const free = await app.inject({ url: "/free" })
      assert.equal(free.statusCode, 200)
      assert.equal(free.headers["x-ratelimit-limit"], undefined)
      assert.equal(await valet.remaining("api", "k"), 1) // untouched

      assert.equal((await app.inject({ url: "/api/x" })).statusCode, 200)
      assert.equal((await app.inject({ url: "/api/x" })).statusCode, 429)
      assert.equal((await app.inject({ url: "/free" })).statusCode, 200)
    })
  })
})

test("valetPlugin with schema options: creates valet at boot, auto-closes with the app", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises")
  const { tmpdir } = await import("node:os")
  const path = await import("node:path")
  const { createValet } = await import("../src/index.js")
  const dir = await mkdtemp(path.join(tmpdir(), "valet-boot-"))
  try {
    const app = Fastify()
    await app.register(valetPlugin, {
      dir,
      spaces: { user: {} },
      limits: { api: { pool: 3, windowMs: 60_000 } },
    })
    app.get("/who", async (request) => {
      request.valet.spaces.user.set("u1", { booted: true })
      return request.valet.spaces.user.get("u1")
    })
    const bootedValet = app.valet
    const response = await app.inject({ url: "/who" })
    assert.deepEqual(response.json(), { booted: true })

    await app.close()
    // Auto-closed: further ops throw, and the flock is released so the same
    // directory opens cleanly again.
    assert.throws(() => bootedValet.spaces.user.set("u2", {}), /closed/)
    const reopened = createValet({ dir })
    reopened.close()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("cacheResponse defaults: Authorization bypasses; cookies participate; Set-Cookie responses not stored", async () => {
  await withValet({}, async (valet) => {
    await withApp(async (app) => {
      const cache = cacheResponse(valet)
      app.addHook("onRequest", cache.onRequest)
      app.addHook("onSend", cache.onSend)
      let calls = 0
      app.get("/me", async () => ({ call: ++calls }))
      app.get("/login", async (request, reply) => {
        reply.header("set-cookie", "session=abc")
        return { session: ++calls }
      })

      const anonymous = await app.inject({ url: "/me" })
      assert.equal(anonymous.headers["x-cache"], "MISS")

      // Authorization: never served the cached body, never stored.
      const authorized = await app.inject({
        url: "/me",
        headers: { authorization: "Bearer t" },
      })
      assert.equal(authorized.headers["x-cache"], undefined)
      assert.deepEqual(authorized.json(), { call: 2 })

      // A plain Cookie header does NOT bypass — the guard is on Set-Cookie
      // responses instead (browsers send cookies on nearly every request).
      const withCookie = await app.inject({
        url: "/me",
        headers: { cookie: "tracking=xyz" },
      })
      assert.equal(withCookie.headers["x-cache"], "HIT")
      assert.deepEqual(withCookie.json(), { call: 1 })

      // A response that SETS a cookie is session-personalized → not stored.
      assert.equal(
        (await app.inject({ url: "/login" })).headers["x-cache"],
        "MISS",
      )
      const loginAgain = await app.inject({ url: "/login" })
      assert.equal(loginAgain.headers["x-cache"], "MISS") // handler re-ran
      assert.deepEqual(loginAgain.json(), { session: calls })
    })
  })
})

test("store decision: valetCache flag wins; store callback replaces default policy", async () => {
  await withValet({}, async (valet) => {
    await withApp(async (app) => {
      const cache = cacheResponse(valet)
      app.addHook("onRequest", cache.onRequest)
      app.addHook("onSend", cache.onSend)
      let calls = 0
      app.get("/never", async (request, reply) => {
        reply.valetCache = false // explicit: don't store this 200
        return { call: ++calls }
      })
      app.get("/always", async (request, reply) => {
        reply.valetCache = true // explicit: store despite Set-Cookie
        reply.header("set-cookie", "session=abc")
        return { forced: true }
      })

      await app.inject({ url: "/never" })
      const second = await app.inject({ url: "/never" })
      assert.equal(second.headers["x-cache"], "MISS") // handler re-ran
      assert.deepEqual(second.json(), { call: 2 })

      await app.inject({ url: "/always" })
      const forcedHit = await app.inject({ url: "/always" })
      assert.equal(forcedHit.headers["x-cache"], "HIT")
      assert.deepEqual(forcedHit.json(), { forced: true })
    })

    // A custom store callback fully replaces the default policy.
    await withApp(async (app) => {
      const cache = cacheResponse(valet, {
        store: (request, reply) => reply.statusCode === 201,
        key: (request) => `custom ${request.url}`,
      })
      app.addHook("onRequest", cache.onRequest)
      app.addHook("onSend", cache.onSend)
      app.get("/created", async (request, reply) =>
        reply.code(201).send({ ok: 1 }),
      )
      app.get("/plain", async () => ({ ok: 2 }))

      await app.inject({ url: "/created" })
      const createdHit = await app.inject({ url: "/created" })
      assert.equal(createdHit.headers["x-cache"], "HIT")
      assert.equal(createdHit.statusCode, 201)

      await app.inject({ url: "/plain" })
      const plainAgain = await app.inject({ url: "/plain" })
      assert.equal(plainAgain.headers["x-cache"], "MISS") // 200 not stored
    })
  })
})
