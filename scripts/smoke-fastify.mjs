// Manual smoke server (fastify) on :3002 against scratch/fastify.
//   node scripts/smoke-fastify.mjs
//   curl -i localhost:3002/orders/o1        # x-cache: MISS, then HIT
//   for i in $(seq 6); do curl -s -o /dev/null -w "%{http_code}\n" localhost:3002/orders/o1; done
import Fastify from "fastify"
import { createValet } from "../src/index.js"
import { valetPlugin, rateLimit, cacheResponse } from "../src/fastify.js"

const valet = createValet({
  dir: "./scratch/fastify",
  spaces: {
    order: { ttlMs: 300_000, indexes: [{ name: "customer", kind: "string" }] },
  },
  limits: { api: { pool: 5, windowMs: 10_000 } },
  responseCache: { ttlMs: 5_000 },
})
// The customer index derives from the record field automatically.
valet.spaces.order.set("o1", { total: 42, customer: "acme" })

const app = Fastify({ logger: false })
await app.register(valetPlugin, { valet })
// The limiter is registered as an onRequest hook BEFORE the cache's so cache
// hits count against the pool (fastify runs onRequest before preHandler — a
// preHandler limiter would never see cache-served responses).
app.addHook("onRequest", rateLimit(valet, "api", { remainingHeader: true }))
// Path-scoped: only /orders/** is response-cached; /customers/** is not.
const cache = cacheResponse(valet, { paths: ["/orders/**"] })
app.addHook("onRequest", cache.onRequest)
app.addHook("onSend", cache.onSend)

app.get("/orders/:id", async (request, reply) => {
  const order = await request.valet.spaces.order.get(request.params.id)
  if (!order) return reply.code(404).send({ error: "not found" })
  return order
})
app.get("/customers/:name/orders", async (request) =>
  request.valet.spaces.order.findRecords("customer", request.params.name),
)

await app.listen({ host: "127.0.0.1", port: 3002 })
console.log("fastify smoke on :3002")
const shutdown = async () => {
  await app.close()
  valet.close()
  process.exit(0)
}
process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)
