import { InMemoryLockingProvider } from "@medusajs/locking/dist/providers/in-memory"
import { startMockPrintTrail, type MockPrintTrail } from "../../../dev/mock-print-trail"
import { PrintTrailClient } from "../../modules/printTrail/client/client"
import type { CheckVariant, SkuCheck, SkuCheckPort } from "../sku-check"
import {
  drainSkuChecks,
  runSkuCheckQueue,
  SKU_CHECK_LOCK_KEY,
  type SkuCheckQueue,
  type SkuCheckQueueContext,
} from "../sku-check-queue"
import type { StateStore } from "../team-code"

const NOW = new Date("2026-10-19T12:00:00Z")
const PT = "sp_pt"

class MemoryState implements StateStore {
  values = new Map<string, unknown>()
  async getState<T>(key: string) {
    return (this.values.get(key) as T | undefined) ?? null
  }
  async setState(key: string, value: unknown) {
    this.values.set(key, value === null ? null : JSON.parse(JSON.stringify(value)))
  }
}

class MemoryQueue implements SkuCheckQueue {
  ids: string[] = []
  async add(ids: string[]) {
    for (const id of ids) if (!this.ids.includes(id)) this.ids.push(id)
  }
  async take(limit: number) {
    return this.ids.splice(0, limit)
  }
}

class FakePort implements SkuCheckPort {
  writes: { variantId: string; check: SkuCheck }[] = []
  constructor(public variants: CheckVariant[]) {}
  async ptProfileIds() {
    return [PT]
  }
  async loadVariants(input: { variantIds?: string[] }) {
    return this.variants.filter((v) => input.variantIds?.includes(v.id))
  }
  failWrites = false
  async writeCheck(variant: { id: string; productId: string }, check: SkuCheck) {
    if (this.failWrites) throw new Error("write failed")
    this.writes.push({ variantId: variant.id, check })
    const v = this.variants.find((x) => x.id === variant.id)!
    v.check = check
    v.hasRow = true
  }
  async blockedRows() {
    return []
  }
  async orderVariants() {
    return []
  }
  async resend() {}
}

let mock: MockPrintTrail
let queue: MemoryQueue
let port: FakePort
let logs: string[]
let refreshed: string[][]
let ctx: SkuCheckQueueContext

const validateCalls = () => mock.state.requests.filter((r) => r.path.endsWith("/products/validate-skus")).length
const variants = (n: number) =>
  Array.from({ length: n }, (_, i): CheckVariant => ({ id: `v${i}`, sku: `SKU-${i}`, metadata: null, profileId: PT, productId: "prod_1", check: null, hasRow: false }))

beforeEach(async () => {
  mock = await startMockPrintTrail({ token: "secret-token", channelId: "acme-medusa1", skus: { "SKU-1": 3, "SKU-2": 4 } })
  queue = new MemoryQueue()
  logs = []
  refreshed = []
  port = new FakePort(variants(300))
  ctx = {
    client: new PrintTrailClient({ baseUrl: mock.url, channelId: "acme-medusa1", apiToken: "secret-token", retryDelays: [] }),
    state: new MemoryState(),
    port,
    queue,
    now: () => NOW,
    logger: { warn: (m: string) => logs.push(m), error: (m: string) => logs.push(m) },
    refreshStock: async (skus: string[]) => {
      refreshed.push(skus)
    },
  }
})

afterEach(() => mock.close())

describe("drainSkuChecks", () => {
  it("checks an import of 300 variants in 2 calls", async () => {
    await queue.add(port.variants.map((v) => v.id))
    const out = await drainSkuChecks(ctx)
    expect(validateCalls()).toBe(2)
    expect(out).toMatchObject({ batches: 2, checked: 300 })
    expect(queue.ids).toEqual([])
    expect(port.writes).toHaveLength(300)
    // Newly matched SKUs get their stock right away.
    expect(port.writes.filter((w) => w.check.status === "matched").map((w) => w.check.sku)).toEqual(["SKU-1", "SKU-2"])
    expect(refreshed).toEqual([["SKU-1", "SKU-2"]])
  })

  it("keeps the queue on a 429 and writes no couldn't-check result", async () => {
    await queue.add(["v1", "v2"])
    mock.fail(/validate-skus/, 429, { message: "Too Many Requests" }, 9)
    const out = await drainSkuChecks(ctx)
    expect(out).toMatchObject({ retry: 2 })
    expect(queue.ids).toEqual(["v1", "v2"])
    expect(port.writes).toEqual([])
    expect(logs.join("\n")).toMatch(/will retry/)
  })

  it("logs a client error at warn, without the token, and records couldn't check", async () => {
    await queue.add(["v1"])
    mock.fail(/validate-skus/, 400, { message: "Bad request" }, 9)
    await drainSkuChecks(ctx)
    expect(port.writes[0].check.status).toBe("error")
    expect(logs).toHaveLength(1)
    expect(logs[0]).toMatch(/couldn't check 1 SKU/)
    expect(logs[0]).not.toContain("secret-token")
  })
})

describe("drainSkuChecks limits", () => {
  it("puts the batch back when a write throws", async () => {
    await queue.add(["v1", "v2"])
    port.failWrites = true
    await expect(drainSkuChecks(ctx)).rejects.toThrow("write failed")
    expect(queue.ids).toEqual(["v1", "v2"])
  })

  it("re-queues a 5xx, like a 429", async () => {
    await queue.add(["v1"])
    mock.fail(/validate-skus/, 503, undefined, 9)
    expect(await drainSkuChecks(ctx)).toMatchObject({ retry: 1 })
    expect(queue.ids).toEqual(["v1"])
    expect(port.writes).toEqual([])
  })

  it("stops within its time budget and leaves the rest queued", async () => {
    await queue.add(port.variants.map((v) => v.id))
    let t = 0
    const out = await drainSkuChecks(ctx, {
      clock: () => {
        t += 200_000
        return t
      },
    })
    expect(out.batches).toBe(1)
    expect(queue.ids).toHaveLength(50)
  })
})

describe("runSkuCheckQueue", () => {
  it("leaves the queue for later when another run holds the lock", async () => {
    const locking = new InMemoryLockingProvider()
    await locking.acquire(SKU_CHECK_LOCK_KEY, { ownerId: "someone", expire: 60 })
    await queue.add(["v1"])
    expect(await runSkuCheckQueue(locking, ctx, { settleMs: 0 })).toEqual({ ran: false })
    expect(queue.ids).toEqual(["v1"])
    expect(validateCalls()).toBe(0)

    await locking.release(SKU_CHECK_LOCK_KEY, { ownerId: "someone" })
    expect(await runSkuCheckQueue(locking, ctx, { settleMs: 0 })).toMatchObject({ ran: true })
    expect(queue.ids).toEqual([])
  })
})
