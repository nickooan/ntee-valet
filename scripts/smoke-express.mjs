// Manual smoke server (express) on :3001 against scratch/express.
//   node scripts/smoke-express.mjs
//   curl -i localhost:3001/orders/o1        # X-Cache: MISS, then HIT
//   for i in $(seq 6); do curl -s -o /dev/null -w "%{http_code}\n" localhost:3001/orders/o1; done
import express from "express"
import { createValet } from "../src/index.js"
import { valetContext, rateLimit, cacheResponse } from "../src/express.js"

const valet = createValet({
  dir: "./scratch/express",
  spaces: {
    order: { ttlMs: 300_000, indexes: [{ name: "customer", kind: "string" }] },
  },
  limits: { api: { pool: 5, windowMs: 10_000 } },
  responseCache: { ttlMs: 5_000 },
})
// The customer index derives from the record field automatically.
valet.spaces.order.set("o1", { total: 42, customer: "acme" })

const app = express()
app.use(valetContext(valet))
app.use(rateLimit(valet, "api", { remainingHeader: true }))
// Path-scoped: only /orders/** is response-cached; /customers/** is not.
app.use(cacheResponse(valet, { paths: ["/orders/**"] }))

app.get("/orders/:id", async (req, res) => {
  const order = await req.valet.spaces.order.get(req.params.id)
  if (!order) return res.status(404).json({ error: "not found" })
  res.json(order)
})
app.get("/customers/:name/orders", async (req, res) => {
  res.json(
    await req.valet.spaces.order.findRecords("customer", req.params.name),
  )
})

const server = app.listen(3001, () => console.log("express smoke on :3001"))
const shutdown = () => {
  server.close()
  valet.close()
  process.exit(0)
}
process.on("SIGINT", shutdown)
process.on("SIGTERM", shutdown)
