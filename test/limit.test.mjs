// Rate limiter semantics: pool exhaustion, remaining reads, refused takes
// writing nothing, window reset, per-call cost, and concurrent correctness.
import { test } from "node:test"
import assert from "node:assert/strict"
import { withValet, eventually } from "./harness.mjs"

test("pool exhausts exactly: N accepts then rejects", async () => {
  const limits = { api: { pool: 5, windowMs: 60_000 } }
  await withValet({ limits }, async (valet) => {
    for (let i = 0; i < 5; i++) {
      assert.deepEqual(await valet.limit("api", "u1"), { ok: true })
    }
    assert.deepEqual(await valet.limit("api", "u1"), { ok: false })
    // Another key has its own untouched pool.
    assert.deepEqual(await valet.limit("api", "u2"), { ok: true })
  })
})

test("remaining: pool when absent, counts down, unchanged by refused takes", async () => {
  const limits = { api: { pool: 3, windowMs: 60_000 } }
  await withValet({ limits }, async (valet) => {
    assert.equal(await valet.remaining("api", "u1"), 3)
    await valet.limit("api", "u1")
    assert.equal(await valet.remaining("api", "u1"), 2)
    await valet.limit("api", "u1")
    await valet.limit("api", "u1")
    assert.equal(await valet.remaining("api", "u1"), 0)

    // A refused take writes nothing — remaining stays 0, and the window that
    // was armed by the first accepted take is unaffected.
    assert.deepEqual(await valet.limit("api", "u1"), { ok: false })
    assert.equal(await valet.remaining("api", "u1"), 0)
  })
})

test("window reset: a lapsed window re-arms on the next accepted take", async () => {
  const limits = { burst: { pool: 2, windowMs: 100 } }
  await withValet({ limits }, async (valet) => {
    await valet.limit("burst", "u1")
    await valet.limit("burst", "u1")
    assert.deepEqual(await valet.limit("burst", "u1"), { ok: false })
    assert.ok(
      await eventually(async () => (await valet.limit("burst", "u1")).ok),
      "pool should refill after the window lapses",
    )
  })
})

test("cost: limit default cost and per-call override", async () => {
  const limits = { heavy: { pool: 10, windowMs: 60_000, cost: 2 } }
  await withValet({ limits }, async (valet) => {
    await valet.limit("heavy", "u1") // default cost 2
    assert.equal(await valet.remaining("heavy", "u1"), 8)
    await valet.limit("heavy", "u1", 5) // per-call cost
    assert.equal(await valet.remaining("heavy", "u1"), 3)
    // A cost that would overshoot is refused whole (all-or-nothing take).
    assert.deepEqual(await valet.limit("heavy", "u1", 4), { ok: false })
    assert.equal(await valet.remaining("heavy", "u1"), 3)
  })
})

test("concurrency: 100 parallel takes against pool 50 accept exactly 50", async () => {
  const limits = { api: { pool: 50, windowMs: 60_000 } }
  await withValet({ limits }, async (valet) => {
    const results = await Promise.all(
      Array.from({ length: 100 }, () => valet.limit("api", "u1")),
    )
    const accepted = results.filter((r) => r.ok).length
    assert.equal(accepted, 50)
    assert.equal(await valet.remaining("api", "u1"), 0)
  })
})
