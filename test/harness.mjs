// Shared test helpers: temp-dir valet lifecycle and a condition poller for
// TTL-expiry assertions (ntee-db expiry is lazy — poll, don't sleep-and-hope).
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { createValet } from "../src/index.js"

export const withValet = async (opts, fn) => {
  const dir = await mkdtemp(path.join(tmpdir(), "valet-"))
  const valet = createValet({ dir, ...opts })
  try {
    await fn(valet, dir)
  } finally {
    try {
      valet.close()
    } catch {}
    await rm(dir, { recursive: true, force: true })
  }
}

// Polls until fn() resolves truthy or the deadline passes (returns false).
export const eventually = async (
  fn,
  { timeoutMs = 3000, stepMs = 25 } = {},
) => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await fn()) return true
    await new Promise((resolve) => setTimeout(resolve, stepMs))
  }
  return fn()
}
