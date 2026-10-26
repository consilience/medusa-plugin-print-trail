import { startMockPrintTrail, type MockPrintTrail } from "../../../dev/mock-print-trail"
import { PrintTrailClient } from "../../modules/printTrail/client/client"
import {
  checkFromResult,
  checkVariantSkus,
  isCheckCurrent,
  SKU_CHECK_KEY,
  unmatchedSkusFromEvents,
  type CheckVariant,
  type SkuCheck,
  type SkuCheckContext,
  type SkuCheckPort,
} from "../sku-check"
import { readUnmatchedSkus, STATE_KEYS } from "../stock"
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
  unmatched() {
    return (this.values.get(STATE_KEYS.skuCheckUnmatched) as { skus: string[] } | undefined)?.skus
  }
}

type Row = { id: string; order_id: string; sequence: number; unmatchedSkus: string[] | null }

class FakePort implements SkuCheckPort {
  writes: { variantId: string; check: SkuCheck }[] = []
  resends: { orderId: string; sequence: number }[] = []
  rows: Row[] = []
  orders: { orderId: string; canceled: boolean; variantIds: string[] }[] = []
  constructor(public variants: (CheckVariant & { productId: string })[]) {}
  async ptProfileIds() {
    return [PT]
  }
  async loadVariants(input: { variantIds?: string[]; productId?: string }) {
    return JSON.parse(
      JSON.stringify(
        this.variants.filter((v) => (input.variantIds ? input.variantIds.includes(v.id) : v.productId === input.productId))
      )
    ) as CheckVariant[]
  }
  failWriteFor: string | null = null
  async writeCheck(variantId: string, check: SkuCheck) {
    if (this.failWriteFor === variantId) {
      this.failWriteFor = null
      throw new Error("write failed")
    }
    this.writes.push({ variantId, check })
    const v = this.variants.find((x) => x.id === variantId)!
    v.metadata = { ...(v.metadata ?? {}), [SKU_CHECK_KEY]: check }
  }
  async blockedRows() {
    return this.rows
  }
  async orderVariants(orderIds: string[]) {
    return this.orders.filter((o) => orderIds.includes(o.orderId))
  }
  async resend(orderId: string, sequence: number) {
    this.resends.push({ orderId, sequence })
  }
  check(id: string) {
    return this.variants.find((v) => v.id === id)!.metadata?.[SKU_CHECK_KEY] as SkuCheck | undefined
  }
}

const v = (id: string, sku: string | null, over: Partial<CheckVariant & { productId: string }> = {}) => ({
  id,
  sku,
  metadata: null,
  profileId: PT,
  productId: "prod_1",
  ...over,
})

let mock: MockPrintTrail
let state: MemoryState
let port: FakePort
let ctx: SkuCheckContext
let refreshed: string[][]

const validateCalls = () => mock.state.requests.filter((r) => r.path.endsWith("/products/validate-skus")).length

const setup = (variants: ReturnType<typeof v>[]) => {
  port = new FakePort(variants)
  ctx = {
    client: new PrintTrailClient({ baseUrl: mock.url, channelId: "acme-medusa1", apiToken: "t", retryDelays: [0] }),
    state,
    port,
    now: () => NOW,
    refreshStock: async (skus: string[]) => {
      refreshed.push(skus)
    },
  }
  refreshed = []
}

beforeEach(async () => {
  mock = await startMockPrintTrail({
    token: "t",
    channelId: "acme-medusa1",
    skus: { "SKU-ACTIVE": 5, "SKU-INACTIVE": 1, "SKU-PRE": 0, "abc-1": 3 },
    skuStatus: { "SKU-INACTIVE": "inactive", "SKU-PRE": "pre-order" },
  })
  state = new MemoryState()
})

afterEach(() => mock.close())

describe("isCheckCurrent and checkFromResult", () => {
  it("decides when a stored check is current", () => {
    const check = (over: Partial<SkuCheck>) => ({ sku: "abc-1", status: "matched", checked_at: "x", ...over })
    expect(isCheckCurrent("ABC-1", check({}))).toBe(true)
    expect(isCheckCurrent("ABC-2", check({}))).toBe(false)
    expect(isCheckCurrent("abc-1", check({ status: "error" }))).toBe(false)
    expect(isCheckCurrent("abc-1", check({ status: "not-found" }))).toBe(true)
    expect(isCheckCurrent(null, check({ sku: null, status: "no-sku" }))).toBe(true)
    expect(isCheckCurrent(null, check({}))).toBe(false)
    expect(isCheckCurrent("abc-1", check({ sku: null, status: "no-sku" }))).toBe(false)
    expect(isCheckCurrent("abc-1", undefined)).toBe(false)
    expect(isCheckCurrent("abc-1", "matched")).toBe(false)
    // A string override later re-saved as a number gets its note.
    expect(isCheckCurrent("123", check({ sku: "123" }), { numericOverride: true })).toBe(false)
    expect(isCheckCurrent("123", check({ sku: "123", note: "numeric-override" }), { numericOverride: true })).toBe(true)
  })

  it("maps validate-skus results to checks", () => {
    expect(checkFromResult("A", undefined, NOW)).toEqual({ sku: "A", status: "not-found", checked_at: NOW.toISOString() })
    expect(checkFromResult("A", { sku: "A", state: "unknown" }, NOW).status).toBe("not-found")
    expect(checkFromResult("A", { sku: "A", state: "matched", matchedSku: "a", status: "inactive" }, NOW)).toEqual({
      sku: "A",
      status: "inactive",
      checked_at: NOW.toISOString(),
    })
    expect(checkFromResult("A", { sku: "A", state: "matched", status: "pre-order" }, NOW).status).toBe("pre-order")
    expect(checkFromResult("A ", { sku: "A ", state: "matched", matchedSku: "A-CANON", status: "active" }, NOW)).toMatchObject({
      status: "matched",
      matched_sku: "A-CANON",
    })
  })
})

describe("checkVariantSkus", () => {
  it("writes matched, inactive, pre-order and not-found checks", async () => {
    setup([v("v1", "SKU-ACTIVE"), v("v2", "SKU-INACTIVE"), v("v3", "SKU-PRE"), v("v4", "NOPE")])
    const out = await checkVariantSkus(ctx, { productId: "prod_1" })
    expect(out.checked.map((c) => [c.variantId, c.check.status])).toEqual([
      ["v1", "matched"],
      ["v2", "inactive"],
      ["v3", "pre-order"],
      ["v4", "not-found"],
    ])
    expect(port.check("v1")).toEqual({ sku: "SKU-ACTIVE", status: "matched", checked_at: NOW.toISOString() })
    expect(state.unmatched()).toEqual(["NOPE"])
  })

  it("makes no call and no write when the check is current", async () => {
    setup([v("v1", "SKU-ACTIVE")])
    await checkVariantSkus(ctx, { variantIds: ["v1"] })
    expect(validateCalls()).toBe(1)
    expect(port.writes).toHaveLength(1)
    // The write-back's own product-variant.updated.
    const again = await checkVariantSkus(ctx, { variantIds: ["v1"] })
    expect(again).toEqual({ checked: [], skipped: ["v1"], resent: [], retry: [], newlyMatched: [] })
    expect(validateCalls()).toBe(1)
    expect(port.writes).toHaveLength(1)

    // A SKU that differs from Print Trail's only in case.
    setup([v("v2", "ABC-1")])
    await checkVariantSkus(ctx, { variantIds: ["v2"] })
    expect(port.check("v2")).toEqual({ sku: "ABC-1", status: "matched", checked_at: NOW.toISOString() })
    await checkVariantSkus(ctx, { variantIds: ["v2"] })
    expect(validateCalls()).toBe(2)
    expect(port.writes).toHaveLength(1)
  })

  it("re-checks after a couldn't-check result", async () => {
    setup([v("v1", "SKU-ACTIVE")])
    // A non-retryable refusal records couldn't check.
    mock.fail(/validate-skus/, 400, { message: "Bad request" }, 1)
    await checkVariantSkus(ctx, { variantIds: ["v1"] })
    expect(port.check("v1")).toMatchObject({ sku: "SKU-ACTIVE", status: "error" })
    expect(state.unmatched()).toBeUndefined()

    await checkVariantSkus(ctx, { variantIds: ["v1"] })
    expect(port.check("v1")).toMatchObject({ status: "matched" })
  })

  it("doesn't rewrite an identical couldn't-check result", async () => {
    setup([v("v1", "SKU-ACTIVE")])
    mock.fail(/validate-skus/, 400, { message: "Bad request" }, 99)
    await checkVariantSkus(ctx, { variantIds: ["v1"] })
    expect(port.writes).toHaveLength(1)
    // The write-back's event re-checks (error is never current) but writes
    // nothing, so there is no further event.
    await checkVariantSkus(ctx, { variantIds: ["v1"] })
    expect(port.writes).toHaveLength(1)
  })

  it("re-checks when the override changes and forgets the old SKU", async () => {
    setup([v("v1", "NOPE-OLD")])
    await checkVariantSkus(ctx, { variantIds: ["v1"] })
    expect(state.unmatched()).toEqual(["NOPE-OLD"])
    port.variants[0].sku = "SKU-ACTIVE"
    const out = await checkVariantSkus(ctx, { variantIds: ["v1"] })
    expect(out.checked[0].check).toMatchObject({ sku: "SKU-ACTIVE", status: "matched" })
    expect(state.unmatched()).toEqual([])
    expect(validateCalls()).toBe(2)
  })

  it("ignores variants outside Print Trail profiles", async () => {
    setup([v("v1", "SKU-ACTIVE", { profileId: "sp_default" }), v("v2", "NOPE", { profileId: null })])
    const out = await checkVariantSkus(ctx, { productId: "prod_1" })
    expect(out).toEqual({ checked: [], skipped: [], resent: [], retry: [], newlyMatched: [] })
    expect(validateCalls()).toBe(0)
    expect(port.writes).toEqual([])
  })

  it("checks every variant of a product in one call", async () => {
    setup([v("v1", "SKU-ACTIVE"), v("v2", "SKU-PRE"), v("v3", "sku-active"), v("v9", "OTHER", { productId: "prod_2" })])
    const out = await checkVariantSkus(ctx, { productId: "prod_1" })
    expect(out.checked).toHaveLength(3)
    expect(validateCalls()).toBe(1)
    const body = mock.state.requests.find((r) => r.path.endsWith("/products/validate-skus"))!.body
    expect(body.skus).toEqual(["SKU-ACTIVE", "SKU-PRE"])
  })

  it("marks a variant without a SKU no-sku without calling Print Trail", async () => {
    setup([v("v1", null)])
    const out = await checkVariantSkus(ctx, { variantIds: ["v1"] })
    expect(out.checked[0].check).toEqual({ sku: null, status: "no-sku", checked_at: NOW.toISOString() })
    expect(validateCalls()).toBe(0)
    await checkVariantSkus(ctx, { variantIds: ["v1"] })
    expect(port.writes).toHaveLength(1)
  })

  it("flags a numeric override, whose leading zeros may be lost", async () => {
    mock.state.stock["9780000000026"] = 1
    setup([v("v1", "9780000000026", { metadata: { print_trail_sku: 9780000000026 } })])
    const out = await checkVariantSkus(ctx, { variantIds: ["v1"] })
    expect(out.checked[0].check).toEqual({
      sku: "9780000000026",
      status: "matched",
      checked_at: NOW.toISOString(),
      note: "numeric-override",
    })
    expect(typeof port.check("v1")!.sku).toBe("string")
    // Current on the next event: no call, no write.
    await checkVariantSkus(ctx, { variantIds: ["v1"] })
    expect(port.writes).toHaveLength(1)
  })

  it("forgets a matched SKU and its canonical spelling from the unmatched list", async () => {
    await state.setState(STATE_KEYS.skuCheckUnmatched, { skus: ["abc-1", "Keep-1", "Pt-Canon"], updatedAt: "x" })
    mock.state.stock["PT-CANON"] = 1
    setup([v("v1", "ABC-1"), v("v2", "pt-canon ")])
    await checkVariantSkus(ctx, { productId: "prod_1" })
    expect(state.unmatched()).toEqual(["Keep-1"])
  })

  it("never writes the stock sync's unmatched list", async () => {
    await state.setState(STATE_KEYS.unmatched, { skus: ["FROM-STOCK"], updatedAt: "x" })
    setup([v("v1", "NOPE"), v("v2", "SKU-ACTIVE")])
    await checkVariantSkus(ctx, { productId: "prod_1" })
    expect(state.values.get(STATE_KEYS.unmatched)).toEqual({ skus: ["FROM-STOCK"], updatedAt: "x" })
    expect(await readUnmatchedSkus(state)).toEqual(["FROM-STOCK", "NOPE"])
  })

  it("re-sends an order blocked on unmatched SKUs once the variant matches", async () => {
    setup([v("v1", "SKU-ACTIVE"), v("v2", "SKU-PRE")])
    port.rows = [
      { id: "pto_1", order_id: "order_1", sequence: 1, unmatchedSkus: ["sku-active"] },
      { id: "pto_2", order_id: "order_2", sequence: 1, unmatchedSkus: ["SKU-ACTIVE"] }, // cancelled
      { id: "pto_3", order_id: "order_3", sequence: 1, unmatchedSkus: null }, // older row, without the variants
      { id: "pto_4", order_id: "order_1", sequence: 2, unmatchedSkus: ["SKU-PRE", "STILL-MISSING"] },
      { id: "pto_5", order_id: "order_5", sequence: 1, unmatchedSkus: ["OTHER-SKU"] }, // has the variant, not the SKU
      { id: "pto_6", order_id: "order_6", sequence: 1, unmatchedSkus: null }, // older row with the variant
    ]
    port.orders = [
      { orderId: "order_1", canceled: false, variantIds: ["v1", "v2"] },
      { orderId: "order_2", canceled: true, variantIds: ["v1"] },
      { orderId: "order_3", canceled: false, variantIds: ["v_other"] },
      { orderId: "order_5", canceled: false, variantIds: ["v1"] },
      { orderId: "order_6", canceled: false, variantIds: ["v2"] },
    ]
    const out = await checkVariantSkus(ctx, { productId: "prod_1" })
    expect(port.resends).toEqual([
      { orderId: "order_1", sequence: 1 },
      { orderId: "order_1", sequence: 2 },
      { orderId: "order_6", sequence: 1 },
    ])
    expect(out.resent).toEqual(["pto_1", "pto_4", "pto_6"])
  })

  it("re-sends only on a real change to matched", async () => {
    // Previously matched for the same SKU; re-checked only because the note
    // was missing (numeric override).
    setup([
      v("v1", "123", {
        metadata: { print_trail_sku: 123, [SKU_CHECK_KEY]: { sku: "123", status: "matched", checked_at: "x" } },
      }),
    ])
    mock.state.stock["123"] = 1
    port.rows = [{ id: "pto_1", order_id: "order_1", sequence: 1, unmatchedSkus: ["123"] }]
    port.orders = [{ orderId: "order_1", canceled: false, variantIds: ["v1"] }]
    const out = await checkVariantSkus(ctx, { variantIds: ["v1"] })
    expect(out.checked[0].check).toMatchObject({ status: "matched", note: "numeric-override" })
    expect(port.resends).toEqual([])
  })

  it("re-queues a retryable failure and records couldn't check after three in a row", async () => {
    setup([v("v1", "SKU-ACTIVE")])
    mock.fail(/validate-skus/, 503, undefined, 99)
    for (let i = 1; i <= 2; i++) {
      const out = await checkVariantSkus(ctx, { variantIds: ["v1"] })
      expect(out.retry).toEqual(["v1"])
      expect(port.writes).toEqual([])
      expect(state.values.get(STATE_KEYS.skuCheckFailures)).toMatchObject({ count: i })
    }
    const third = await checkVariantSkus(ctx, { variantIds: ["v1"] })
    expect(third.retry).toEqual([])
    expect(port.check("v1")).toMatchObject({ status: "error" })
    expect(state.values.get(STATE_KEYS.skuCheckFailures) ?? null).toBeNull()
    // Stock failures are counted apart.
    expect(state.values.get(STATE_KEYS.failures) ?? null).toBeNull()
  })

  it("still re-sends and refreshes after a write fails mid-batch", async () => {
    setup([v("v1", "SKU-ACTIVE"), v("v2", "SKU-PRE")])
    port.rows = [{ id: "pto_1", order_id: "order_1", sequence: 1, unmatchedSkus: ["SKU-ACTIVE"] }]
    port.orders = [{ orderId: "order_1", canceled: false, variantIds: ["v1"] }]
    port.failWriteFor = "v2"
    await expect(checkVariantSkus(ctx, { productId: "prod_1" })).rejects.toThrow("write failed")
    expect(port.check("v1")).toMatchObject({ status: "matched" })
    expect(port.resends).toEqual([])

    // The retry: v1's check is now current, but its follow-ups were recorded.
    const out = await checkVariantSkus(ctx, { productId: "prod_1" })
    expect(out.skipped).toEqual(["v1"])
    expect(port.resends).toEqual([{ orderId: "order_1", sequence: 1 }])
    expect(refreshed.flat().sort()).toEqual(["SKU-ACTIVE", "SKU-PRE"])
    expect(state.values.get(STATE_KEYS.skuCheckFollowUps) ?? null).toBeNull()
  })

  it("doesn't re-send for an inactive SKU", async () => {
    setup([v("v1", "SKU-INACTIVE")])
    port.rows = [{ id: "pto_1", order_id: "order_1", sequence: 1, unmatchedSkus: ["SKU-INACTIVE"] }]
    port.orders = [{ orderId: "order_1", canceled: false, variantIds: ["v1"] }]
    await checkVariantSkus(ctx, { variantIds: ["v1"] })
    expect(port.resends).toEqual([])
  })
})

describe("unmatchedSkusFromEvents", () => {
  it("takes the latest blocked entry's SKUs per row, or null", () => {
    const events = [
      { print_trail_order_id: "r1", kind: "blocked", created_at: "2026-10-19T10:00:00Z", data: { unmatched_skus: ["OLD"] } },
      { print_trail_order_id: "r1", kind: "blocked", created_at: "2026-10-19T11:00:00Z", data: { unmatched_skus: ["NEW"] } },
      { print_trail_order_id: "r1", kind: "sent", created_at: "2026-10-19T12:00:00Z", data: null },
      { print_trail_order_id: "r2", kind: "blocked", created_at: "2026-10-19T10:00:00Z", data: null },
    ]
    const map = unmatchedSkusFromEvents(events)
    expect(map.get("r1")).toEqual(["NEW"])
    expect(map.get("r2") ?? null).toBeNull()
  })
})
