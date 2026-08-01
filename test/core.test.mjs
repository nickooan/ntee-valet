// Core valet: spaces (prefixing, TTL semantics, index namespacing, counters),
// name validation, response-cache store, and error codes.
import { test } from "node:test"
import assert from "node:assert/strict"
import { createValet } from "../src/index.js"
import { withValet, eventually } from "./harness.mjs"

test("space round-trip: set/get/has/del with invisible prefixing", async () => {
  await withValet({ spaces: { user: {} } }, async (valet) => {
    const user = valet.spaces.user
    user.set("u1", { name: "amy" })
    assert.deepEqual(await user.get("u1"), { name: "amy" })
    assert.equal(await user.has("u1"), true)
    assert.equal(await user.get("missing"), null)

    // The raw store sees the prefixed key; the space API never exposes it.
    assert.deepEqual(await valet.db.get("user:u1"), { name: "amy" })
    assert.deepEqual(await user.keys(), ["u1"])

    user.del("u1")
    assert.equal(await user.has("u1"), false)
  })
})

test("spaces are isolated: same key in two spaces never collides", async () => {
  await withValet({ spaces: { a: {}, b: {} } }, async (valet) => {
    valet.spaces.a.set("k", { from: "a" })
    valet.spaces.b.set("k", { from: "b" })
    assert.deepEqual(await valet.spaces.a.records(), [
      { key: "k", value: { from: "a" } },
    ])
    assert.deepEqual(await valet.spaces.b.records(), [
      { key: "k", value: { from: "b" } },
    ])
  })
})

test("space(name) lookup and unknown-name error codes", async () => {
  await withValet({ spaces: { user: {} }, limits: {} }, async (valet) => {
    assert.equal(valet.space("user"), valet.spaces.user)
    assert.throws(() => valet.space("nope"), {
      code: "ERR_VALET_UNKNOWN_SPACE",
    })
    assert.throws(() => valet.limit("nope", "k"), {
      code: "ERR_VALET_UNKNOWN_LIMIT",
    })
    await assert.rejects(valet.spaces.user.find("nope", "x"), {
      code: "ERR_VALET_UNKNOWN_INDEX",
    })
  })
})

test("indexes derive from the record automatically (schema-only)", async () => {
  const spaces = { order: { indexes: [{ name: "customer", kind: "string" }] } }
  await withValet({ spaces }, async (valet) => {
    const order = valet.spaces.order
    // No index values passed anywhere — the schema is the source of truth.
    order.set("o1", { total: 42, customer: "acme" })
    order.set("o2", { total: 7, customer: "globex" })
    order.set("o3", { total: 1 }) // field missing → simply not indexed
    order.set("o4", "plain-string") // non-object → simply not indexed

    assert.deepEqual(await order.find("customer", "acme"), ["o1"])
    assert.deepEqual(await order.findRecords("customer", "globex"), [
      { key: "o2", value: { total: 7, customer: "globex" } },
    ])
    assert.equal((await order.find("customer", "acme")).includes("o3"), false)
    assert.equal(await order.findHas("customer", "plain-string"), false)
  })
})

test("bad space/limit names are rejected at createValet", () => {
  for (const name of ["__x", "a:b", "a.b", "1a", "_lead", ""]) {
    assert.throws(
      () => createValet({ dir: "/tmp/never-opened", spaces: { [name]: {} } }),
      { code: "ERR_VALET_BAD_NAME" },
      `space name ${JSON.stringify(name)} should be rejected`,
    )
    assert.throws(
      () =>
        createValet({
          dir: "/tmp/never-opened",
          limits: { [name]: { pool: 1, windowMs: 1000 } },
        }),
      { code: "ERR_VALET_BAD_NAME" },
      `limit name ${JSON.stringify(name)} should be rejected`,
    )
  }
  assert.throws(() => createValet({}), { code: "ERR_VALET_BAD_OPTIONS" })
})

test("TTL: space default applies, per-call override wins, null = immortal", async () => {
  await withValet(
    { spaces: { hot: { ttlMs: 80 }, cold: {} } },
    async (valet) => {
      const hot = valet.spaces.hot
      hot.set("default-ttl", 1) // space default 80ms
      hot.set("long-ttl", 2, { ttlMs: 60_000 }) // per-call override
      hot.set("immortal", 3, { ttlMs: null }) // explicitly no TTL
      valet.spaces.cold.set("no-default", 4) // space without a default

      assert.ok(
        await eventually(async () => (await hot.get("default-ttl")) === null),
        "space-default TTL should expire the key",
      )
      assert.equal(await hot.get("long-ttl"), 2)
      assert.equal(await hot.get("immortal"), 3)
      assert.equal(await valet.spaces.cold.get("no-default"), 4)

      // Re-setting with ttlMs: null clears a pending TTL (put-without-ttl rule).
      hot.set("resurrect", 5) // armed with 80ms
      hot.set("resurrect", 5, { ttlMs: null }) // cleared
      await new Promise((resolve) => setTimeout(resolve, 150))
      assert.equal(await hot.get("resurrect"), 5)
    },
  )
})

test("index namespacing: same index name in two spaces stays isolated", async () => {
  const spaces = {
    user: { indexes: [{ name: "email", kind: "string" }] },
    admin: { indexes: [{ name: "email", kind: "string" }] },
  }
  await withValet({ spaces }, async (valet) => {
    valet.spaces.user.set("u1", { role: "u", email: "x@y.z" })
    valet.spaces.admin.set("a1", { role: "a", email: "x@y.z" })

    assert.deepEqual(await valet.spaces.user.find("email", "x@y.z"), ["u1"])
    assert.deepEqual(await valet.spaces.admin.find("email", "x@y.z"), ["a1"])
    assert.equal(await valet.spaces.user.findHas("email", "none@y.z"), false)
  })
})

test("jsonPath index: findRange/findPrefix/findRecords through a space", async () => {
  const spaces = {
    order: {
      indexes: [
        { name: "status", kind: "number", jsonPath: "status" },
        { name: "customer", kind: "string", jsonPath: "customer" },
      ],
    },
  }
  await withValet({ spaces }, async (valet) => {
    const order = valet.spaces.order
    order.set("o1", { status: 200, customer: "acme-east" })
    order.set("o2", { status: 404, customer: "acme-west" })
    order.set("o3", { status: 500, customer: "globex" })

    assert.deepEqual(await order.findRange("status", 400, 599), ["o2", "o3"])
    assert.deepEqual(await order.findPrefix("customer", "acme-"), ["o1", "o2"])
    assert.deepEqual(await order.findRecords("customer", "globex"), [
      { key: "o3", value: { status: 500, customer: "globex" } },
    ])
    assert.deepEqual(await order.findPrefixRecords("customer", "acme-e"), [
      { key: "o1", value: { status: 200, customer: "acme-east" } },
    ])
  })
})

test("setMany batches with derived indexes; keys/records scan by sub-prefix", async () => {
  const spaces = { doc: { indexes: [{ name: "tag", kind: "string" }] } }
  await withValet({ spaces }, async (valet) => {
    const doc = valet.spaces.doc
    const n = await doc.setMany([
      { key: "a:1", value: { t: 1, tag: "x" } },
      { key: "a:2", value: { t: 2, tag: "x" } },
      { key: "b:1", value: { t: 3 } },
    ])
    assert.equal(n, 3)
    assert.deepEqual(await doc.keys("a:"), ["a:1", "a:2"])
    assert.deepEqual(await doc.find("tag", "x"), ["a:1", "a:2"])
    assert.equal((await doc.records()).length, 3)
  })
})

test("space counters: incr/take with explicit TTL only", async () => {
  await withValet({ spaces: { quota: { ttlMs: 50 } } }, async (valet) => {
    const quota = valet.spaces.quota
    assert.equal(await quota.incr("hits"), 1)
    assert.equal(await quota.incr("hits", 4), 5)
    assert.equal(await quota.decr("hits", 2), 3)
    assert.equal(await quota.take("hits", 3, 0), true)
    assert.equal(await quota.take("hits", 1, 0), false)

    // The 50ms space default must NOT have been applied to the counter.
    await new Promise((resolve) => setTimeout(resolve, 120))
    assert.equal(await quota.incr("hits", 0), 0)
  })
})

test("responseCache store: set/get/del/invalidate, utf8 and base64 bodies", async () => {
  await withValet({ responseCache: { ttlMs: 60_000 } }, async (valet) => {
    const responseCache = valet.responseCache
    responseCache.set("GET /a", {
      status: 200,
      headers: { "content-type": "text/plain" },
      body: "hello",
    })
    const hit = await responseCache.get("GET /a")
    assert.equal(hit.status, 200)
    assert.deepEqual(hit.headers, { "content-type": "text/plain" })
    assert.equal(hit.body.toString(), "hello")

    // A non-utf8 body survives byte-exact via the base64 path.
    const binary = Buffer.from([0xff, 0x00, 0xfe, 0x01])
    responseCache.set("GET /bin", { body: binary })
    assert.deepEqual((await responseCache.get("GET /bin")).body, binary)

    assert.equal(await responseCache.get("GET /missing"), null)
    responseCache.del("GET /a")
    assert.equal(await responseCache.get("GET /a"), null)

    responseCache.set("GET /x/1", { body: "1" })
    responseCache.set("GET /x/2", { body: "2" })
    responseCache.set("GET /y", { body: "3" })
    assert.equal(await responseCache.invalidate("GET /x/"), 2)
    assert.equal(await responseCache.get("GET /x/1"), null)
    assert.notEqual(await responseCache.get("GET /y"), null)
  })
})

test("responseCache invalidate: glob patterns (* one segment, ** any depth)", async () => {
  await withValet({}, async (valet) => {
    const responseCache = valet.responseCache
    for (const key of ["GET /p/1", "GET /p/1/photos", "GET /p/2", "GET /q"]) {
      responseCache.set(key, { body: key })
    }

    // "*" matches exactly one segment — /p/1 and /p/2, NOT /p/1/photos.
    assert.equal(await responseCache.invalidate("GET /p/*"), 2)
    assert.equal(await responseCache.get("GET /p/1"), null)
    assert.equal(await responseCache.get("GET /p/2"), null)
    assert.notEqual(await responseCache.get("GET /p/1/photos"), null)
    assert.notEqual(await responseCache.get("GET /q"), null)

    // "**" matches any depth — clears the rest of the /p subtree.
    assert.equal(await responseCache.invalidate("GET /p/**"), 1)
    assert.equal(await responseCache.get("GET /p/1/photos"), null)
    assert.notEqual(await responseCache.get("GET /q"), null)

    // Mid-pattern segment glob.
    responseCache.set("GET /p/7/photos", { body: "a" })
    responseCache.set("GET /p/7/docs", { body: "b" })
    assert.equal(await responseCache.invalidate("GET /p/*/photos"), 1)
    assert.equal(await responseCache.get("GET /p/7/photos"), null)
    assert.notEqual(await responseCache.get("GET /p/7/docs"), null)
  })
})

test("responseCache TTL expires entries", async () => {
  await withValet({ responseCache: { ttlMs: 60 } }, async (valet) => {
    valet.responseCache.set("GET /soon", { body: "gone" })
    assert.notEqual(await valet.responseCache.get("GET /soon"), null)
    assert.ok(
      await eventually(
        async () => (await valet.responseCache.get("GET /soon")) === null,
      ),
    )
  })
})

test("drop() deletes the store", async () => {
  await withValet({ spaces: { s: {} } }, async (valet) => {
    valet.spaces.s.set("k", 1)
    valet.drop()
    assert.throws(() => valet.spaces.s.set("k", 2), /closed/)
  })
})
