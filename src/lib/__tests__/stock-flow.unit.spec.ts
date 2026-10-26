import { startMockPrintTrail, type MockPrintTrail } from "../../../dev/mock-print-trail"
import { resolvePluginOptions } from "../../config"
import { PrintTrailClient } from "../../modules/printTrail/client/client"
import { STATE_KEYS, type BackorderReason, type StockPlan, type StockVariant } from "../stock"
import {
  admitStockRequest,
  deferOnLockBusy,
  deferStockRequest,
  runLockedStockSync,
  runStockSync,
  scanPluginMetadata,
  takePendingStockRequest,
  type MetadataScan,
  type MetadataScanLimits,
  type MetadataScanRun,
  type StockCatalogue,
  type StockContext,
} from "../stock-flow"
import type { StateStore } from "../team-code"
import { markWaitingSkus, memoryPreOrderSeen } from "../pre-order"
import { checkVariantSkus, type CheckVariant, type SkuCheck, type SkuCheckPort } from "../sku-check"
import { checkColumns, LEGACY_SKU_CHECK_KEY, legacyCheckOf, toSkuCheck, type VariantCheckRow } from "../variant-checks"
import type { CheckStatusUpdate } from "../../modules/printTrail/service"

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

// A variant as the fake stores it: what loadVariants returns, plus the keys
// 0.2.0 kept in its metadata, which only the metadata scan reads: the
// backorder marker and the SKU check (any value).
type FakeVariant = StockVariant & { backorderMarker: BackorderReason | null; skuCheck?: unknown }

class FakeCatalogue implements StockCatalogue {
  calls: { method: string; args: unknown[] }[] = []
  // Variants that left Print Trail's profiles: never loaded, still writable.
  outside: FakeVariant[] = []
  private failing = new Set<string>()
  constructor(public variants: FakeVariant[], public profiles = [PT]) {}
  failNext(method: keyof StockCatalogue) {
    this.failing.add(method)
  }
  private check(method: string, args: unknown[]) {
    this.calls.push({ method, args })
    if (this.failing.delete(method)) throw new Error(`${method} broke`)
  }
  async ptProfileIds() {
    this.check("ptProfileIds", [])
    return this.profiles
  }
  async loadVariants(ids: string[]) {
    this.check("loadVariants", [ids])
    return JSON.parse(JSON.stringify(this.variants.map(({ backorderMarker: _marker, skuCheck: _check, ...v }) => v))) as StockVariant[]
  }
  async updateLevels(updates: StockPlan["levelUpdates"]) {
    this.check("updateLevels", [updates])
    for (const u of updates) {
      for (const v of this.variants) {
        for (const item of v.inventory) {
          if (item.inventoryItemId !== u.inventory_item_id) continue
          for (const l of item.levels) if (l.locationId === u.location_id) l.stockedQuantity = u.stocked_quantity
        }
      }
    }
  }
  // allow_backorder alone: the variant's metadata isn't written.
  async setBackorder(ids: string[], on: boolean) {
    this.check("setBackorder", [ids, on])
    for (const v of [...this.variants, ...this.outside]) {
      if (ids.includes(v.id)) v.allowBackorder = on
    }
  }
  async setPreOrderFields(updates: { id: string; value: string | true | null }[]) {
    this.check("setPreOrderFields", [updates])
    for (const v of [...this.variants, ...this.outside]) {
      const u = updates.find((x) => x.id === v.id)
      if (u) v.preOrderField = u.value ?? undefined
    }
  }
  async deleteLegacyKeys(updates: { id: string; preOrderField: boolean }[]) {
    this.check("deleteLegacyKeys", [updates])
    for (const u of updates) {
      const v = [...this.variants, ...this.outside].find((x) => x.id === u.id)
      if (!v) continue
      v.backorderMarker = null
      v.skuCheck = undefined
      if (u.preOrderField) v.preOrderField = undefined
    }
  }
  // Each variant's product (prod_{id} unless set), and the variants Medusa
  // no longer has (deleted without an event): never live.
  productOf = new Map<string, string>()
  deleted = new Set<string>()
  product(id: string) {
    return this.productOf.get(id) ?? `prod_${id}`
  }
  async ptProductIds(profiles: string[]) {
    this.check("ptProductIds", [profiles])
    return new Set(this.variants.filter((v) => v.profileId && profiles.includes(v.profileId)).map((v) => this.product(v.id)))
  }
  async liveVariants(ids: string[]) {
    this.check("liveVariants", [ids])
    return [...this.variants, ...this.outside]
      .filter((v) => ids.includes(v.id) && !this.deleted.has(v.id))
      .map((v) => ({ id: v.id, productId: this.product(v.id) }))
  }
  // Called after each page is read, before it is returned: a variant can be
  // deleted, or the clock moved, between pages.
  onPage?: (page: number) => void
  private pages = 0
  // Keyset, like the Medusa adapter: ids after `after`, ascending.
  async listPluginMetadata(after: string | null, take: number) {
    this.check("listPluginMetadata", [after, take])
    const rows = [...this.variants, ...this.outside]
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .filter((v) => after === null || v.id > after)
      .slice(0, take)
    this.onPage?.(++this.pages)
    const legacyKeys = (v: FakeVariant) => v.backorderMarker !== null || v.skuCheck !== undefined
    return {
      found: rows
        .filter((v) => (v.preOrderField !== undefined && v.preOrderField !== null) || legacyKeys(v))
        .map((v) => ({
          id: v.id,
          productId: this.product(v.id),
          preOrderField: v.preOrderField,
          backorderMarker: v.backorderMarker,
          check: legacyCheckOf({ [LEGACY_SKU_CHECK_KEY]: v.skuCheck }),
          legacyKeys: legacyKeys(v),
        })),
      lastId: rows.length ? rows[rows.length - 1].id : null,
      read: rows.length,
    }
  }
  scanPages() {
    return this.calls.filter((c) => c.method === "listPluginMetadata").map((c) => c.args)
  }
  remove(id: string) {
    this.variants = this.variants.filter((v) => v.id !== id)
    this.outside = this.outside.filter((v) => v.id !== id)
  }
  writes() {
    return this.calls.filter((c) => c.method === "updateLevels" || c.method === "setBackorder")
  }
  fieldWrites() {
    return this.calls.filter((c) => c.method === "setPreOrderFields").map((c) => c.args[0])
  }
  legacyDeletes() {
    return this.calls.filter((c) => c.method === "deleteLegacyKeys").map((c) => c.args[0])
  }
  level(id: string, loc = "sloc_a") {
    return this.variants.find((v) => v.id === id)!.inventory[0].levels.find((l) => l.locationId === loc)!.stockedQuantity
  }
  get(id: string) {
    return this.variants.find((v) => v.id === id)!
  }
}

// print_trail_variant rows, in memory.
class MemoryVariantRows {
  rows: VariantCheckRow[] = []
  queued: string[] = []
  calls: string[] = []
  private failing = new Set<string>()
  failNext(method: string) {
    this.failing.add(method)
  }
  private hit(method: string) {
    this.calls.push(method)
    if (this.failing.delete(method)) throw new Error(`${method} broke`)
  }
  add(variantId: string, productId: string, check: SkuCheck | null) {
    this.rows.push({ id: `ptvar_${variantId}`, variant_id: variantId, product_id: productId, ...checkColumns(check, "sku-check") })
  }
  get(variantId: string) {
    return this.rows.find((r) => r.variant_id === variantId)
  }
  async rowPage(after: string | null, take: number) {
    this.hit("rowPage")
    return JSON.parse(
      JSON.stringify(
        [...this.rows].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).filter((r) => after === null || r.id > after).slice(0, take)
      )
    ) as VariantCheckRow[]
  }
  async forget(filter: { variantIds?: string[]; productIds?: string[] }) {
    this.hit("forget")
    const before = this.rows.length
    this.rows = this.rows.filter((r) => !filter.variantIds?.includes(r.variant_id) && !filter.productIds?.includes(r.product_id))
    return before - this.rows.length
  }
  async setCheckStatuses(updates: CheckStatusUpdate[]) {
    this.hit("setCheckStatuses")
    let n = 0
    for (const u of updates) {
      const r = this.rows.find((x) => x.id === u.id)
      if (!r || r.check_sku !== u.expect.sku || r.check_status !== u.expect.status) continue
      if (u.status === null) Object.assign(r, checkColumns(null, "stock-sync"))
      else Object.assign(r, { check_status: u.status, checked_at: u.at, check_source: "stock-sync" })
      n++
    }
    return n
  }
  async queueChecks(ids: string[]) {
    this.hit("queueChecks")
    for (const id of ids) if (!this.queued.includes(id)) this.queued.push(id)
  }
  // Variants whose row the database refuses: skipped and logged by the
  // service, not thrown.
  refused = new Set<string>()
  // Creates only the missing rows; a row written meanwhile wins.
  async adopt(checks: { variantId: string; productId: string; check: SkuCheck }[]) {
    this.hit("adopt")
    let created = 0
    for (const c of checks) {
      if (this.get(c.variantId) || this.refused.has(c.variantId)) continue
      this.rows.push({ id: `ptvar_${c.variantId}`, variant_id: c.variantId, product_id: c.productId, ...checkColumns(c.check, "metadata") })
      created++
    }
    return created
  }
}

const variant = (id: string, sku: string, over: Partial<FakeVariant> = {}): FakeVariant => ({
  id,
  sku,
  profileId: PT,
  manageInventory: true,
  allowBackorder: false,
  backorderMarker: null,
  inventory: [
    {
      inventoryItemId: `iitem_${id}`,
      requiredQuantity: 1,
      levels: [
        { locationId: "sloc_a", stockedQuantity: 0 },
        { locationId: "sloc_b", stockedQuantity: 0 },
      ],
    },
  ],
  ...over,
})

let mock: MockPrintTrail
let state: MemoryState
let catalogue: FakeCatalogue
let variantRows: MemoryVariantRows
let ctx: StockContext
let warnings: string[]

const stockRequests = () => mock.state.requests.filter((r) => r.path.endsWith("/stock-levels")).length

beforeEach(async () => {
  mock = await startMockPrintTrail({
    token: "t",
    channelId: "acme-medusa1",
    skus: { "9780000000002": 25, "9780000000019": 0, "9780000000026": 10003 },
  })
  state = new MemoryState()
  variantRows = new MemoryVariantRows()
  catalogue = new FakeCatalogue([
    variant("v1", "9780000000002"),
    variant("v2", "9780000000019"),
    variant("v3", "9780000000026"),
    variant("v4", "UNKNOWN-1"),
  ])
  ctx = {
    client: new PrintTrailClient({ baseUrl: mock.url, channelId: "acme-medusa1", apiToken: "t", retryDelays: [0] }),
    state,
    catalogue,
    options: resolvePluginOptions({}),
    now: () => NOW,
    logger: { warn: (m: string) => warnings.push(m), error: (m: string) => warnings.push(m) },
    seen: memoryPreOrderSeen(),
    variants: variantRows,
  }
  warnings = []
})

afterEach(() => mock.close())

describe("runStockSync", () => {
  it("writes Print Trail stock to every level of own-stock variants", async () => {
    const result = await runStockSync(ctx, { trigger: "schedule" })
    expect(result.status).toBe("completed")
    expect(catalogue.level("v1", "sloc_a")).toBe(25)
    expect(catalogue.level("v1", "sloc_b")).toBe(25)
    const v1Updates = (result as { plan: StockPlan }).plan.levelUpdates.filter((u) => u.inventory_item_id === "iitem_v1")
    expect(v1Updates).toHaveLength(2)
    expect(state.values.get(STATE_KEYS.lastRun)).toMatchObject({
      trigger: "schedule",
      levelsUpdated: 4, // v1 ×2, v3 ×2 (v2 is already 0)
      backorderOn: 1,
      backorderOff: 0,
      matched: 3,
      unmatched: 1,
    })
  })

  it("writes nothing on a second run with unchanged stock", async () => {
    await runStockSync(ctx, { trigger: "schedule" })
    catalogue.calls = []
    const second = await runStockSync(ctx, { trigger: "schedule" })
    expect(second.status).toBe("completed")
    expect(catalogue.writes()).toEqual([])
  })

  it("handles print-on-demand: stock 3, backorder on, then off when it ends", async () => {
    await runStockSync(ctx, { trigger: "schedule" })
    expect(catalogue.level("v3")).toBe(3)
    expect(catalogue.get("v3")).toMatchObject({ allowBackorder: true })
    expect(catalogue.calls).toContainEqual({ method: "setBackorder", args: [["v3"], true] })
    expect(state.values.get(STATE_KEYS.backordered)).toEqual({ ids: ["v3"], reasons: { v3: "print-on-demand" } })

    mock.state.stock["9780000000026"] = 4
    await runStockSync(ctx, { trigger: "schedule" })
    expect(catalogue.level("v3")).toBe(4)
    expect(catalogue.get("v3")).toMatchObject({ allowBackorder: false })
    expect(state.values.get(STATE_KEYS.backordered)).toEqual({ ids: [], reasons: {} })
    expect(catalogue.calls).toContainEqual({ method: "setBackorder", args: [["v3"], false] })
  })

  it("replaces the unmatched list on a full run and edits it on a shortfall run", async () => {
    await state.setState(STATE_KEYS.unmatched, { skus: ["OLD-1", "9780000000019"], updatedAt: "x" })
    await runStockSync(ctx, { trigger: "schedule" })
    expect(state.values.get(STATE_KEYS.unmatched)).toEqual({ skus: ["UNKNOWN-1"], updatedAt: NOW.toISOString() })

    await state.setState(STATE_KEYS.unmatched, { skus: ["OLD-1", "9780000000019"], updatedAt: "x" })
    catalogue.variants.push(variant("v5", "GONE-2"))
    await runStockSync(ctx, { trigger: "shortfall", skus: ["9780000000019", "GONE-2"] })
    expect(state.values.get(STATE_KEYS.unmatched)).toEqual({ skus: ["GONE-2", "OLD-1"], updatedAt: NOW.toISOString() })
  })

  it("refreshes only the shortfall SKUs", async () => {
    mock.state.stock["9780000000019"] = 6
    const result = await runStockSync(ctx, { trigger: "shortfall", skus: ["9780000000019"] })
    expect(result.status).toBe("completed")
    expect(catalogue.level("v2")).toBe(6)
    expect(catalogue.level("v1")).toBe(0)
    expect(catalogue.get("v3").allowBackorder).toBe(false)
  })

  it("keeps the watermark when the sync fails", async () => {
    await state.setState(STATE_KEYS.watermark, { changedAt: "2026-10-19T10:00:00Z" })
    mock.fail(/stock-levels/, 503, undefined, 9)
    const result = await runStockSync(ctx, { trigger: "webhook", changedAt: "2026-10-19T11:00:00Z" })
    expect(result.status).toBe("failed")
    expect(state.values.get(STATE_KEYS.watermark)).toEqual({ changedAt: "2026-10-19T10:00:00Z" })
    expect(catalogue.writes()).toEqual([])
    const last = state.values.get(STATE_KEYS.lastRun) as { error: string }
    expect(last.error).toMatch(/503/)
    expect(last.error).not.toContain("t@")
  })

  it("records a catalogue failure and keeps the writes made", async () => {
    catalogue.failNext("setBackorder")
    const result = await runStockSync(ctx, { trigger: "webhook", changedAt: "2026-10-19T11:00:00Z" })
    expect(result).toEqual({ status: "failed", error: "setBackorder broke" })
    expect(catalogue.level("v1")).toBe(25)
    expect(state.values.get(STATE_KEYS.lastRun)).toMatchObject({ trigger: "webhook", error: "setBackorder broke" })
    expect(state.values.get(STATE_KEYS.watermark) ?? null).toBeNull()
  })

  it("drops a webhook not newer than the watermark when it reaches the lock", async () => {
    await state.setState(STATE_KEYS.watermark, { changedAt: "2026-10-19T11:00:00Z" })
    const result = await runStockSync(ctx, { trigger: "webhook", changedAt: "2026-10-19T11:00:00Z" })
    expect(result).toEqual({ status: "dropped" })
    expect(stockRequests()).toBe(0)
    // A pending run made only of webhooks is dropped the same way…
    expect(await runStockSync(ctx, { trigger: "pending", changedAt: "2026-10-19T10:00:00Z", webhookOnly: true })).toEqual({
      status: "dropped",
    })
    // …but not one that also carries a shortfall or schedule request.
    const mixed = await runStockSync(ctx, { trigger: "pending", changedAt: "2026-10-19T10:00:00Z", webhookOnly: false })
    expect(mixed.status).toBe("completed")
    expect(stockRequests()).toBe(1)
    expect(state.values.get(STATE_KEYS.watermark)).toEqual({ changedAt: "2026-10-19T11:00:00Z" })
  })
})

describe("admitStockRequest", () => {
  it("does nothing when stock sync is disabled", async () => {
    const off = { ...ctx, options: resolvePluginOptions({ stockSync: { enabled: false } }) }
    expect(await admitStockRequest(off, { trigger: "schedule" })).toBe("disabled")
    expect(await admitStockRequest(off, { trigger: "webhook", changedAt: "2026-10-19T11:00:00Z" })).toBe("disabled")
    expect(stockRequests()).toBe(0)
  })

  it("drops a replayed webhook and advances the watermark on a new one", async () => {
    await state.setState(STATE_KEYS.watermark, { changedAt: "2026-10-19T10:00:00Z" })
    expect(await admitStockRequest(ctx, { trigger: "webhook", changedAt: "2026-10-19T10:00:00Z" })).toBe("dropped")
    expect(await admitStockRequest(ctx, { trigger: "schedule" })).toBe("run")
    const later = { trigger: "webhook" as const, changedAt: "2026-10-19T10:05:00Z" }
    expect(await admitStockRequest(ctx, later)).toBe("run")
    expect((await runStockSync(ctx, later)).status).toBe("completed")
    expect(state.values.get(STATE_KEYS.watermark)).toEqual({ changedAt: "2026-10-19T10:05:00Z" })
    expect(await admitStockRequest(ctx, later)).toBe("dropped")
  })
})

describe("pending requests", () => {
  it("records a delivery that finds the lock held and runs it from the sweep", async () => {
    const T = "2026-10-19T11:00:00Z"
    await deferStockRequest(state, { trigger: "webhook", changedAt: T }, NOW)
    await deferStockRequest(state, { trigger: "shortfall", skus: ["a"] }, new Date("2026-10-19T12:01:00Z"))
    expect(state.values.get(STATE_KEYS.pending)).toMatchObject({
      requestedAt: "2026-10-19T12:01:00.000Z",
      full: true,
      skus: ["a"],
      changedAt: T,
    })
    expect(await takePendingStockRequest(state)).toEqual({ trigger: "pending", changedAt: T, skus: undefined, webhookOnly: false })
    expect(state.values.get(STATE_KEYS.pending) ?? null).toBeNull()
    expect(await takePendingStockRequest(state)).toBeNull()
  })

  it("merges SKU-only requests and keeps the later changedAt", async () => {
    await deferStockRequest(state, { trigger: "shortfall", skus: ["a", "B"] }, NOW)
    await deferStockRequest(state, { trigger: "shortfall", skus: ["b", "c"] }, NOW)
    expect(await takePendingStockRequest(state)).toEqual({ trigger: "pending", changedAt: null, skus: ["a", "B", "c"], webhookOnly: false })

    await deferStockRequest(state, { trigger: "webhook", changedAt: "2026-10-19T11:00:00Z" }, NOW)
    await deferStockRequest(state, { trigger: "webhook", changedAt: "2026-10-19T10:00:00Z" }, NOW)
    expect(await takePendingStockRequest(state)).toEqual({
      trigger: "pending",
      changedAt: "2026-10-19T11:00:00Z",
      skus: undefined,
      webhookOnly: true,
    })
  })
})

describe("backorders that leave scope", () => {
  it("turns off a plugin backorder on a variant that leaves Print Trail's profiles", async () => {
    await runStockSync(ctx, { trigger: "schedule" })
    expect(state.values.get(STATE_KEYS.backordered)).toEqual({ ids: ["v3"], reasons: { v3: "print-on-demand" } })
    // The product moves to the default profile (or the option is deleted).
    const v3 = catalogue.variants.splice(2, 1)[0]
    catalogue.outside.push(v3)
    catalogue.calls = []
    await runStockSync(ctx, { trigger: "schedule" })
    expect(catalogue.calls).toContainEqual({ method: "setBackorder", args: [["v3"], false] })
    expect(v3).toMatchObject({ allowBackorder: false })
    expect(state.values.get(STATE_KEYS.backordered)).toEqual({ ids: [], reasons: {} })
  })

  it("keeps tracking on a SKU-only run and never touches a merchant's backorder", async () => {
    await runStockSync(ctx, { trigger: "schedule" })
    catalogue.calls = []
    await runStockSync(ctx, { trigger: "shortfall", skus: ["9780000000019"] })
    expect(catalogue.writes().filter((c) => c.method === "setBackorder")).toEqual([])
    expect(state.values.get(STATE_KEYS.backordered)).toEqual({ ids: ["v3"], reasons: { v3: "print-on-demand" } })

    // The merchant's own backorder (untracked, even with a legacy marker) leaving scope.
    const own = variant("v9", "9780000000002", { allowBackorder: true, backorderMarker: "print-on-demand" })
    catalogue.outside.push(own)
    await runStockSync(ctx, { trigger: "schedule" })
    expect(own.allowBackorder).toBe(true)
  })

  it("switches off a tracked backorder whose marker a concurrent write lost", async () => {
    await runStockSync(ctx, { trigger: "schedule" })
    catalogue.get("v3").backorderMarker = null
    mock.state.stock["9780000000026"] = 2
    await runStockSync(ctx, { trigger: "schedule" })
    expect(catalogue.get("v3").allowBackorder).toBe(false)
    expect(state.values.get(STATE_KEYS.backordered)).toEqual({ ids: [], reasons: {} })
  })

  it("a deleted tracked variant is untracked without an error", async () => {
    await state.setState(STATE_KEYS.backordered, { ids: ["v3", "v_deleted"], reasons: { v3: "print-on-demand", v_deleted: "pre-order" } })
    const result = await runStockSync(ctx, { trigger: "schedule" })
    expect(result.status).toBe("completed")
    // The selector update matches nothing for it.
    expect(catalogue.calls).toContainEqual({ method: "setBackorder", args: [["v_deleted"], false] })
    expect(state.values.get(STATE_KEYS.backordered)).toEqual({ ids: ["v3"], reasons: { v3: "print-on-demand" } })
  })
})

// stock_backordered: { ids, reasons }. ids decide what the plugin may switch
// off; reasons say why each is on, for display.
describe("the backorder record", () => {
  const record = () => state.values.get(STATE_KEYS.backordered)

  it("the reason is recorded before the on-write", async () => {
    catalogue.failNext("setBackorder")
    const result = await runStockSync(ctx, { trigger: "schedule" })
    expect(result).toEqual({ status: "failed", error: "setBackorder broke" })
    expect(record()).toEqual({ ids: ["v3"], reasons: { v3: "print-on-demand" } })
  })

  it("an off-write removes the id and its reason", async () => {
    catalogue.get("v1").allowBackorder = true
    catalogue.get("v3").allowBackorder = true
    await state.setState(STATE_KEYS.backordered, { ids: ["v1", "v3"], reasons: { v1: "pre-order", v3: "print-on-demand" } })
    await runStockSync(ctx, { trigger: "schedule" })
    expect(catalogue.calls).toContainEqual({ method: "setBackorder", args: [["v1"], false] })
    expect(record()).toEqual({ ids: ["v3"], reasons: { v3: "print-on-demand" } })
  })

  it("a SKU-only run keeps other variants' reasons", async () => {
    catalogue.get("v3").allowBackorder = true
    await state.setState(STATE_KEYS.backordered, { ids: ["v3", "v_other"], reasons: { v3: "pre-order", v_other: "pre-order" } })
    await runStockSync(ctx, { trigger: "shortfall", skus: ["9780000000026"] })
    // v3's reason changes in the record only: no write.
    expect(catalogue.calls.filter((c) => c.method === "setBackorder")).toEqual([])
    expect(record()).toEqual({ ids: ["v3", "v_other"], reasons: { v3: "print-on-demand", v_other: "pre-order" } })
  })

  it("a 0.2.0 record without reasons is read", async () => {
    catalogue.get("v3").allowBackorder = true
    await state.setState(STATE_KEYS.backordered, { ids: ["v3"] })
    await runStockSync(ctx, { trigger: "schedule" })
    expect(catalogue.calls.filter((c) => c.method === "setBackorder")).toEqual([])
    expect(record()).toEqual({ ids: ["v3"], reasons: { v3: "print-on-demand" } })
  })
})

describe("runs that can't be trusted", () => {
  it("fails a run when no Print Trail profiles exist, touching nothing", async () => {
    await runStockSync(ctx, { trigger: "schedule" })
    const before = JSON.stringify([...state.values])
    catalogue.profiles = []
    const result = await runStockSync(ctx, { trigger: "schedule" })
    expect(result).toMatchObject({ status: "failed", error: expect.stringMatching(/no Print Trail shipping profiles/i) })
    expect(catalogue.writes().filter((c) => c.args[1] === false)).toEqual([])
    const after = new Map(state.values)
    expect(after.get(STATE_KEYS.unmatched)).toEqual(new Map(JSON.parse(before)).get(STATE_KEYS.unmatched))
    expect(after.get(STATE_KEYS.backordered)).toEqual({ ids: ["v3"], reasons: { v3: "print-on-demand" } })
    expect(after.get(STATE_KEYS.lastRun)).toMatchObject({ error: expect.any(String) })
    expect(warnings.join("\n")).toMatch(/no Print Trail shipping profiles/i)
  })

  it("fails a run when Print Trail lists no stock for in-scope variants", async () => {
    await runStockSync(ctx, { trigger: "schedule" })
    for (const k of Object.keys(mock.state.stock)) delete mock.state.stock[k]
    mock.state.nullSkuRows = 2
    catalogue.calls = []
    const result = await runStockSync(ctx, { trigger: "schedule" })
    expect(result).toMatchObject({ status: "failed", error: expect.stringMatching(/no stock levels/i) })
    expect(catalogue.writes()).toEqual([])
    expect((state.values.get(STATE_KEYS.unmatched) as { skus: string[] }).skus).toEqual(["UNKNOWN-1"])
  })

  it("records duplicate SKUs, unknown figures and multi-location writes, warning once", async () => {
    catalogue.variants.push(variant("v5", "9780000000002"))
    mock.state.stock["UNKNOWN-1"] = null as unknown as number
    const result = await runStockSync(ctx, { trigger: "schedule" })
    expect(result.status).toBe("completed")
    expect(state.values.get(STATE_KEYS.lastRun)).toMatchObject({
      warnings: [
        { type: "duplicate-sku", skus: ["9780000000002"] },
        { type: "unknown-figure", skus: ["UNKNOWN-1"] },
        { type: "multi-location", skus: ["9780000000019", "9780000000026"] },
      ],
    })
    expect(warnings.filter((w) => /locations/.test(w))).toHaveLength(1)
  })
})

describe("forgetting variants", () => {
  const notFound = (sku: string): SkuCheck => ({ sku, status: "not-found", checked_at: NOW.toISOString() })

  it("a full run deletes the row of a variant deleted without an event", async () => {
    variantRows.add("v1", "prod_v1", notFound("9780000000002"))
    // Deleted through the product module, or replaced by a product update.
    for (let i = 0; i < 600; i++) variantRows.add(`vgone${String(i).padStart(3, "0")}`, "prod_v1", notFound(`GONE-${i}`))
    catalogue.variants.push(variant("v_soft", "SOFT-1"))
    catalogue.deleted.add("v_soft")
    variantRows.add("v_soft", "prod_v_soft", notFound("SOFT-1"))
    const result = await runStockSync(ctx, { trigger: "schedule" })
    expect(result.status).toBe("completed")
    expect(variantRows.rows.map((r) => r.variant_id)).toEqual(["v1"])
  })

  it("a full run deletes rows outside Print Trail's profiles", async () => {
    variantRows.add("v1", "prod_v1", notFound("9780000000002"))
    catalogue.outside.push(variant("v9", "9780000000002", { profileId: "sp_default" }))
    variantRows.add("v9", "prod_v9", notFound("9780000000002"))
    await runStockSync(ctx, { trigger: "schedule" })
    expect(variantRows.rows.map((r) => r.variant_id)).toEqual(["v1"])
  })

  // The run read Print Trail's products when it started: a product that
  // joined a profile since (a bulk import, say) has rows the run can't tell
  // from rows outside the profiles.
  it("a full run leaves a row created or updated since it started for the next full run", async () => {
    const before = new Date(NOW.getTime() - 60_000)
    const since = new Date(NOW.getTime() + 1_000)
    for (const id of ["v_new", "v_updated", "v_old"]) {
      catalogue.outside.push(variant(id, `NEW-${id}`, { profileId: "sp_default" }))
      variantRows.add(id, `prod_${id}`, notFound(`NEW-${id}`))
    }
    Object.assign(variantRows.get("v_new")!, { created_at: since, updated_at: since })
    Object.assign(variantRows.get("v_updated")!, { created_at: before, updated_at: since })
    Object.assign(variantRows.get("v_old")!, { created_at: before, updated_at: before })
    await runStockSync(ctx, { trigger: "schedule" })
    expect(variantRows.rows.map((r) => r.variant_id).sort()).toEqual(["v_new", "v_updated"])

    // The next run started after both were written: they go.
    ctx.now = () => new Date(since.getTime() + 60_000)
    await runStockSync(ctx, { trigger: "schedule" })
    expect(variantRows.rows).toEqual([])
  })

  it("a SKU-only run, or a run that isn't trusted (no profiles, no levels), prunes nothing", async () => {
    variantRows.add("v_gone", "prod_v1", notFound("GONE-1"))
    await runStockSync(ctx, { trigger: "shortfall", skus: ["9780000000002"] })
    expect(variantRows.get("v_gone")).toBeDefined()

    catalogue.profiles = []
    expect((await runStockSync(ctx, { trigger: "schedule" })).status).toBe("failed")
    expect(variantRows.get("v_gone")).toBeDefined()

    catalogue.profiles = [PT]
    for (const k of Object.keys(mock.state.stock)) delete mock.state.stock[k]
    mock.state.nullSkuRows = 2
    expect((await runStockSync(ctx, { trigger: "schedule" })).status).toBe("failed")
    expect(variantRows.get("v_gone")).toBeDefined()
    expect(variantRows.calls).toEqual([])
  })

  it("a prune failure doesn't fail the run", async () => {
    variantRows.add("v_gone", "prod_v1", notFound("GONE-1"))
    variantRows.failNext("rowPage")
    const result = await runStockSync(ctx, { trigger: "schedule" })
    expect(result.status).toBe("completed")
    expect(variantRows.get("v_gone")).toBeDefined()
    expect(warnings.join("\n")).toMatch(/rowPage broke/)
    // The next full run prunes it.
    await runStockSync(ctx, { trigger: "schedule" })
    expect(variantRows.get("v_gone")).toBeUndefined()
  })
})

// Full runs bring the stored SKU checks up to date from Print Trail's
// statuses (API 1.3.0), so the variant page and the notice don't wait for
// the next save.
describe("refreshing stored checks", () => {
  const check = (sku: string, status: SkuCheck["status"]): SkuCheck => ({ sku, status, checked_at: "2026-10-01T00:00:00.000Z" })
  const statusOf = (id: string) => variantRows.get(id)?.check_status

  beforeEach(() => {
    mock.state.preOrderRelease = true
  })

  it("a full run updates statuses that changed at Print Trail", async () => {
    mock.state.skuStatus["9780000000002"] = "inactive"
    variantRows.add("v1", "prod_v1", check("9780000000002", "matched"))
    variantRows.add("v2", "prod_v2", check("9780000000019", "pre-order"))
    variantRows.add("v3", "prod_v3", check("9780000000026", "matched"))
    const result = await runStockSync(ctx, { trigger: "schedule" })
    expect(result.status).toBe("completed")
    expect(variantRows.get("v1")).toMatchObject({ check_status: "inactive", check_source: "stock-sync", checked_at: NOW })
    expect(variantRows.get("v2")).toMatchObject({ check_status: "matched", check_source: "stock-sync", check_sku: "9780000000019" })
    // Unchanged: not written.
    expect(variantRows.get("v3")).toMatchObject({ check_status: "matched", check_source: "sku-check" })
    expect(variantRows.queued).toEqual([])
  })

  it("a SKU missing from stock levels is never downgraded", async () => {
    variantRows.add("v1", "prod_v1", check("NOT-LISTED-1", "matched"))
    variantRows.add("v2", "prod_v2", check("NOT-LISTED-2", "pre-order"))
    await runStockSync(ctx, { trigger: "schedule" })
    expect([statusOf("v1"), statusOf("v2")]).toEqual(["matched", "pre-order"])
    expect(variantRows.queued).toEqual([])
  })

  it("an older API without status changes nothing", async () => {
    mock.state.preOrderRelease = false
    mock.state.skuStatus["9780000000002"] = "inactive"
    variantRows.add("v1", "prod_v1", check("9780000000002", "matched"))
    variantRows.add("v2", "prod_v2", check("9780000000019", "not-found"))
    await runStockSync(ctx, { trigger: "schedule" })
    expect([statusOf("v1"), statusOf("v2")]).toEqual(["matched", "not-found"])
    expect(variantRows.calls).not.toContain("setCheckStatuses")
    expect(variantRows.queued).toEqual([])
  })

  it("a SKU-only run refreshes nothing", async () => {
    mock.state.skuStatus["9780000000002"] = "inactive"
    variantRows.add("v1", "prod_v1", check("9780000000002", "matched"))
    await runStockSync(ctx, { trigger: "shortfall", skus: ["9780000000002"] })
    expect(statusOf("v1")).toBe("matched")
    expect(variantRows.calls).toEqual([])
  })

  it("a check changed since it was read is skipped", async () => {
    mock.state.skuStatus["9780000000002"] = "inactive"
    variantRows.add("v1", "prod_v1", check("9780000000002", "matched"))
    // The SKU check writes a new check between the read and the update.
    const original = variantRows.setCheckStatuses.bind(variantRows)
    variantRows.setCheckStatuses = async (updates) => {
      Object.assign(variantRows.get("v1")!, checkColumns(check("9780000000002", "pre-order"), "sku-check"))
      return original(updates)
    }
    await runStockSync(ctx, { trigger: "schedule" })
    expect(variantRows.get("v1")).toMatchObject({ check_status: "pre-order", check_source: "sku-check" })
  })

  it("a refresh failure is logged and the run completes", async () => {
    mock.state.skuStatus["9780000000002"] = "inactive"
    variantRows.add("v1", "prod_v1", check("9780000000002", "matched"))
    variantRows.failNext("setCheckStatuses")
    const result = await runStockSync(ctx, { trigger: "schedule" })
    expect(result.status).toBe("completed")
    expect(warnings.join("\n")).toMatch(/setCheckStatuses broke/)
    expect(statusOf("v1")).toBe("matched")
    // The next full run catches up.
    await runStockSync(ctx, { trigger: "schedule" })
    expect(statusOf("v1")).toBe("inactive")
  })

  it("a not-found SKU now listed is cleared and queued, and the SKU check then re-sends its blocked order", async () => {
    variantRows.add("v1", "prod_v1", check("9780000000002", "not-found"))
    variantRows.add("v2", "prod_v2", check("9780000000019", "inactive"))
    await runStockSync(ctx, { trigger: "schedule" })
    // Cleared for a re-check: the SKU check makes the change and its follow-ups.
    expect(variantRows.get("v1")).toMatchObject({ check_status: null, check_sku: null, check_source: "stock-sync" })
    expect(variantRows.get("v2")).toMatchObject({ check_status: null, check_source: "stock-sync" })
    expect(variantRows.queued).toEqual(["v1", "v2"])

    // The sweep's SKU check of the queued variants, over the same rows.
    const resends: { orderId: string; sequence: number }[] = []
    const refreshed: string[][] = []
    const port: SkuCheckPort = {
      ptProfileIds: async () => [PT],
      loadVariants: async ({ variantIds }) =>
        catalogue.variants
          .filter((v) => variantIds?.includes(v.id))
          .map((v): CheckVariant => {
            const r = variantRows.get(v.id)
            return { id: v.id, sku: v.sku, metadata: null, profileId: v.profileId, productId: `prod_${v.id}`, check: toSkuCheck(r), hasRow: !!r }
          }),
      writeCheck: async (v, c) => {
        Object.assign(variantRows.get(v.id)!, checkColumns(c, "sku-check"))
      },
      blockedRows: async () => [{ id: "ptord_1", order_id: "order_1", sequence: 1, unmatchedSkus: ["9780000000002"] }],
      orderVariants: async () => [{ orderId: "order_1", canceled: false, variantIds: ["v1"] }],
      resend: async (orderId, sequence) => {
        resends.push({ orderId, sequence })
      },
    }
    const outcome = await checkVariantSkus(
      { client: ctx.client as PrintTrailClient, state, port, now: () => NOW, refreshStock: async (skus) => void refreshed.push(skus) },
      { variantIds: variantRows.queued }
    )
    expect(outcome.checked.map((c) => [c.variantId, c.check.status])).toEqual([
      ["v1", "matched"],
      ["v2", "matched"],
    ])
    expect(statusOf("v1")).toBe("matched")
    expect(resends).toEqual([{ orderId: "order_1", sequence: 1 }])
    expect(refreshed).toEqual([["9780000000002", "9780000000019"]])
  })
})

describe("runLockedStockSync", () => {
  it("drops a stale webhook-only request the sweep picks up", async () => {
    await state.setState(STATE_KEYS.watermark, { changedAt: "2026-10-19T11:00:00Z" })
    await deferStockRequest(state, { trigger: "webhook", changedAt: "2026-10-19T11:00:00Z" }, NOW)
    expect(await runLockedStockSync(ctx, { trigger: "pending" })).toEqual({ status: "dropped" })
    expect(stockRequests()).toBe(0)
    expect(state.values.get(STATE_KEYS.pending) ?? null).toBeNull()
  })

  it("runs a deferred shortfall refresh for its SKUs only", async () => {
    mock.state.stock["9780000000019"] = 6
    await deferStockRequest(state, { trigger: "shortfall", skus: ["9780000000019"] }, NOW)
    const result = await runLockedStockSync(ctx, { trigger: "pending" })
    expect(result.status).toBe("completed")
    expect(catalogue.level("v2")).toBe(6)
    expect(catalogue.level("v1")).toBe(0)
  })

  it("drops a pending run when another sweep took the request", async () => {
    expect(await runLockedStockSync(ctx, { trigger: "pending" })).toEqual({ status: "dropped" })
    expect(stockRequests()).toBe(0)
  })

  it("merges a pending request into a direct run", async () => {
    await deferStockRequest(state, { trigger: "webhook", changedAt: "2026-10-19T11:00:00Z" }, NOW)
    const result = await runLockedStockSync(ctx, { trigger: "shortfall", skus: ["9780000000019"] })
    expect(result.status).toBe("completed")
    expect(catalogue.level("v1")).toBe(25) // full wins
    expect(state.values.get(STATE_KEYS.watermark)).toEqual({ changedAt: "2026-10-19T11:00:00Z" })
  })

  it("keeps a failed run's request for the sweep", async () => {
    mock.fail(/stock-levels/, 503, undefined, 9)
    const result = await runLockedStockSync(ctx, { trigger: "webhook", changedAt: "2026-10-19T11:00:00Z" })
    expect(result.status).toBe("failed")
    expect(state.values.get(STATE_KEYS.pending)).toMatchObject({ full: true, changedAt: "2026-10-19T11:00:00Z", webhookOnly: true })
  })

  it("puts the taken request back when the run throws", async () => {
    await deferStockRequest(state, { trigger: "shortfall", skus: ["a"] }, NOW)
    const setState = state.setState.bind(state)
    state.setState = async (key, value) => {
      if (key === STATE_KEYS.lastRun) throw new Error("db down")
      return setState(key, value)
    }
    await expect(runLockedStockSync(ctx, { trigger: "pending" })).rejects.toThrow("db down")
    state.setState = setState
    expect(state.values.get(STATE_KEYS.pending)).toMatchObject({ full: false, skus: ["a"] })
  })
})

describe("failures", () => {
  it("re-defers the merged request when the run throws", async () => {
    await deferStockRequest(state, { trigger: "webhook", changedAt: "2026-10-19T11:00:00Z" }, NOW)
    const setState = state.setState.bind(state)
    state.setState = async (key, value) => {
      if (key === STATE_KEYS.lastRun) throw new Error("db down")
      return setState(key, value)
    }
    await expect(runLockedStockSync(ctx, { trigger: "shortfall", skus: ["9780000000019"] })).rejects.toThrow("db down")
    state.setState = setState
    // The merged run (full, with the webhook's changedAt), not just the pending part.
    expect(state.values.get(STATE_KEYS.pending)).toMatchObject({ full: true, changedAt: "2026-10-19T11:00:00Z", webhookOnly: false })
  })

  it("reports the run's own error when recording the failure also throws", async () => {
    const setState = state.setState.bind(state)
    state.setState = async (key, value) => {
      if (key === STATE_KEYS.lastRun) throw new Error("first")
      if (key === STATE_KEYS.failures) throw new Error("second")
      return setState(key, value)
    }
    await expect(runLockedStockSync(ctx, { trigger: "schedule" })).rejects.toThrow("first")
    state.setState = setState
    expect(warnings.join("\n")).toMatch(/second/)
  })

  it("stops retrying after three failures in a row and waits for the schedule", async () => {
    mock.fail(/stock-levels/, 503, undefined, 99)
    for (let i = 1; i <= 3; i++) {
      await state.setState(STATE_KEYS.pending, null)
      const result = await runLockedStockSync(ctx, { trigger: "webhook", changedAt: `2026-10-19T11:0${i}:00Z` })
      expect(result.status).toBe("failed")
      expect(state.values.get(STATE_KEYS.failures)).toMatchObject({ count: i })
      const pending = state.values.get(STATE_KEYS.pending) ?? null
      if (i < 3) expect(pending).toMatchObject({ full: true })
      else expect(pending).toBeNull()
    }
    expect(warnings.some((w) => /3 times in a row/.test(w))).toBe(true)

    // The next scheduled run that works resets the count.
    mock.state.requests.length = 0
    const ok = new FakeOk()
    const result = await runLockedStockSync({ ...ctx, client: ok }, { trigger: "schedule" })
    expect(result.status).toBe("completed")
    expect(state.values.get(STATE_KEYS.failures) ?? null).toBeNull()
  })
})

class FakeOk {
  async stockLevels() {
    return [{ sku: "9780000000002", stock: 25 }]
  }
}

describe("deferOnLockBusy", () => {
  it("records a busy request, except the sweep's own pending run", async () => {
    await deferOnLockBusy(state, { trigger: "pending" }, NOW)
    expect(state.values.get(STATE_KEYS.pending) ?? null).toBeNull()
    await deferStockRequest(state, { trigger: "webhook", changedAt: "2026-10-19T11:00:00Z" }, NOW)
    await deferOnLockBusy(state, { trigger: "pending" }, NOW)
    expect(state.values.get(STATE_KEYS.pending)).toMatchObject({ full: true, webhookOnly: true })
    await deferOnLockBusy(state, { trigger: "shortfall", skus: ["b"] }, NOW)
    expect(state.values.get(STATE_KEYS.pending)).toMatchObject({ full: true, webhookOnly: false })
  })
})

// API 1.3.0: status and the pre-order limit on stock rows.
describe("pre-order stock", () => {
  const P = "PRE-1"
  beforeEach(() => {
    mock.state.stock[P] = 0
    mock.state.skuStatus[P] = "pre-order"
    mock.state.publicationDate[P] = "2026-12-01"
    catalogue.variants.push(variant("v5", P))
  })

  it("tracks pre-order backorders in stock_backordered", async () => {
    await runStockSync(ctx, { trigger: "schedule" })
    expect(catalogue.get("v5")).toMatchObject({ allowBackorder: true, backorderMarker: null })
    expect(state.values.get(STATE_KEYS.backordered)).toEqual({ ids: ["v3", "v5"], reasons: { v3: "print-on-demand", v5: "pre-order" } })
  })

  it("a stock webhook after going active turns the backorder off", async () => {
    await runStockSync(ctx, { trigger: "schedule" })
    mock.state.stock[P] = 5
    mock.state.skuStatus[P] = "active"
    const result = await runStockSync(ctx, { trigger: "webhook", changedAt: "2026-10-19T12:05:00Z" })
    expect(result.status).toBe("completed")
    expect(catalogue.get("v5")).toMatchObject({ allowBackorder: false })
    expect(catalogue.level("v5")).toBe(5)
    expect(state.values.get(STATE_KEYS.backordered)).toEqual({ ids: ["v3"], reasons: { v3: "print-on-demand" } })
  })

  it("records pre-order SKUs and dates; a SKU-only run merges", async () => {
    mock.state.stock["PRE-2"] = 7
    mock.state.skuStatus["PRE-2"] = "pre-order"
    mock.state.preOrderLimit = { "PRE-2": 10 }
    await runStockSync(ctx, { trigger: "schedule" })
    expect(state.values.get(STATE_KEYS.preOrders)).toEqual({
      skus: {
        "pre-1": { sku: P, publicationDate: "2026-12-01", limit: null, remaining: null },
        "pre-2": { sku: "PRE-2", publicationDate: null, limit: 10, remaining: 10 },
      },
      updatedAt: NOW.toISOString(),
    })
    // PRE-1 goes live; a SKU-only refresh of it drops only PRE-1.
    mock.state.skuStatus[P] = "active"
    await runStockSync(ctx, { trigger: "shortfall", skus: [P] })
    expect(state.values.get(STATE_KEYS.preOrders)).toEqual({
      skus: { "pre-2": { sku: "PRE-2", publicationDate: null, limit: 10, remaining: 10 } },
      updatedAt: NOW.toISOString(),
    })
    // A full run replaces it.
    mock.state.skuStatus["PRE-2"] = "active"
    await runStockSync(ctx, { trigger: "schedule" })
    expect(state.values.get(STATE_KEYS.preOrders)).toEqual({ skus: {}, updatedAt: NOW.toISOString() })
  })

  it("rows without status leave pre_order_skus alone", async () => {
    await runStockSync(ctx, { trigger: "schedule" })
    const before = state.values.get(STATE_KEYS.preOrders)
    mock.state.preOrderRelease = false
    catalogue.calls = []
    const result = await runStockSync(ctx, { trigger: "schedule" })
    expect(result.status).toBe("completed")
    expect(state.values.get(STATE_KEYS.preOrders)).toEqual(before)
    // And the variant's plugin backorder comes off as for any stocked SKU
    // (no status: today's rule).
    expect(catalogue.get("v5")).toMatchObject({ allowBackorder: false })
  })
})

// 0.1.1: the store-facing print_trail_pre_order flag in variant metadata.
describe("print_trail_pre_order", () => {
  const P = "PRE-1"
  beforeEach(() => {
    mock.state.stock[P] = 0
    mock.state.skuStatus[P] = "pre-order"
    mock.state.publicationDate[P] = "2026-12-01"
    catalogue.variants.push(variant("v5", P))
  })

  it("writes the publication date on a pre-order variant, only once", async () => {
    await runStockSync(ctx, { trigger: "schedule" })
    expect(catalogue.fieldWrites()).toEqual([[{ id: "v5", value: "2026-12-01" }]])
    expect(catalogue.get("v5").preOrderField).toBe("2026-12-01")
    expect(state.values.get(STATE_KEYS.preOrderFlagged)).toEqual({ ids: ["v5"] })
    catalogue.calls = []
    await runStockSync(ctx, { trigger: "schedule" })
    expect(catalogue.fieldWrites()).toEqual([])
  })

  it("writes true when Print Trail has no date, and the new date when it gets one", async () => {
    delete mock.state.publicationDate[P]
    await runStockSync(ctx, { trigger: "schedule" })
    expect(catalogue.get("v5").preOrderField).toBe(true)
    mock.state.publicationDate[P] = "2027-01-15"
    catalogue.calls = []
    await runStockSync(ctx, { trigger: "schedule" })
    expect(catalogue.fieldWrites()).toEqual([[{ id: "v5", value: "2027-01-15" }]])
  })

  it("flags a limited pre-order and one whose backorders were already on", async () => {
    mock.state.stock["PRE-2"] = 0
    mock.state.skuStatus["PRE-2"] = "pre-order"
    mock.state.preOrderLimit = { "PRE-2": 10 }
    catalogue.variants.push(variant("v6", "PRE-2"))
    // The store's own backorder: never claimed, still flagged.
    catalogue.get("v5").allowBackorder = true
    await runStockSync(ctx, { trigger: "schedule" })
    expect(catalogue.get("v5")).toMatchObject({ allowBackorder: true, backorderMarker: null, preOrderField: "2026-12-01" })
    expect(catalogue.get("v6")).toMatchObject({ allowBackorder: false, preOrderField: true })
    expect(catalogue.level("v6")).toBe(10)
  })

  it("deletes it when the product goes live, and from an unmatched variant", async () => {
    await runStockSync(ctx, { trigger: "schedule" })
    mock.state.skuStatus[P] = "active"
    catalogue.get("v1").preOrderField = "2020-01-01"
    catalogue.calls = []
    await runStockSync(ctx, { trigger: "schedule" })
    expect(catalogue.fieldWrites()).toEqual([[{ id: "v1", value: null }, { id: "v5", value: null }]])
    expect(catalogue.get("v5").preOrderField).toBeUndefined()
    expect(state.values.get(STATE_KEYS.preOrderFlagged)).toEqual({ ids: [] })
    // A SKU Print Trail doesn't list loses it too.
    catalogue.get("v4").preOrderField = true
    await runStockSync(ctx, { trigger: "schedule" })
    expect(catalogue.get("v4").preOrderField).toBeUndefined()
  })

  it("a SKU-only run writes its own SKUs only", async () => {
    mock.state.stock["PRE-2"] = 0
    mock.state.skuStatus["PRE-2"] = "pre-order"
    catalogue.variants.push(variant("v6", "PRE-2"))
    await runStockSync(ctx, { trigger: "shortfall", skus: [P] })
    expect(catalogue.fieldWrites()).toEqual([[{ id: "v5", value: "2026-12-01" }]])
    expect(catalogue.get("v6").preOrderField).toBeUndefined()
  })

  it("deletes it from a variant that leaves Print Trail's profiles, on a full run", async () => {
    await runStockSync(ctx, { trigger: "schedule" })
    const v5 = catalogue.variants.pop()!
    catalogue.outside.push(v5)
    await runStockSync(ctx, { trigger: "shortfall", skus: ["9780000000002"] })
    expect(v5.preOrderField).toBe("2026-12-01")
    await runStockSync(ctx, { trigger: "schedule" })
    expect(v5.preOrderField).toBeUndefined()
    expect(state.values.get(STATE_KEYS.preOrderFlagged)).toEqual({ ids: [] })
  })

  it("rows without status write nothing", async () => {
    catalogue.get("v5").preOrderField = "2026-12-01"
    mock.state.preOrderRelease = false
    await runStockSync(ctx, { trigger: "schedule" })
    expect(catalogue.fieldWrites()).toEqual([])
    expect(catalogue.get("v5").preOrderField).toBe("2026-12-01")
  })
})

// Before 0.2.0, on Medusa 2.19+ (which merges variant metadata), a delete
// left the key in place and the plugin forgot the variant: what the first
// runs after the upgrade find.
describe("stale keys from 0.1.x on Medusa 2.19+", () => {
  const P = "PRE-1"
  beforeEach(() => {
    mock.state.stock[P] = 0
    mock.state.skuStatus[P] = "pre-order"
    mock.state.publicationDate[P] = "2026-12-01"
  })

  it("turns on an untracked variant with a stale marker, and records its reason", async () => {
    // A stale "pre-order" marker on a variant that is on pre-order again.
    catalogue.variants.push(variant("v5", P, { backorderMarker: "pre-order" }))
    await runStockSync(ctx, { trigger: "schedule" })
    expect(catalogue.get("v5")).toMatchObject({ allowBackorder: true })
    expect(state.values.get(STATE_KEYS.backordered)).toEqual({ ids: ["v3", "v5"], reasons: { v3: "print-on-demand", v5: "pre-order" } })
  })

  it("deletes a stale pre-order flag in scope, on the first run", async () => {
    // v1 isn't on pre-order at Print Trail.
    catalogue.get("v1").preOrderField = "2020-01-01"
    await runStockSync(ctx, { trigger: "shortfall", skus: ["9780000000002"] })
    expect(catalogue.get("v1").preOrderField).toBeUndefined()
  })

  it("the first full run scans every variant once, for keys outside its scope", async () => {
    // Left Print Trail's profiles (or inventory management) while flagged and
    // print-on-demand, and forgotten by both state rows.
    const gone = variant("v8", "9780000000002", { profileId: "sp_default", backorderMarker: "print-on-demand", preOrderField: "2026-12-01" })
    // The store's own backorder outside the scope, with a stale marker.
    const own = variant("v9", "OWN-1", { profileId: "sp_default", allowBackorder: true, backorderMarker: "pre-order" })
    const clean = variant("v10", "OWN-2", { profileId: "sp_default" })
    catalogue.outside.push(gone, own, clean)

    // A SKU-only run doesn't scan.
    await runStockSync(ctx, { trigger: "shortfall", skus: ["9780000000002"] })
    expect(catalogue.scanPages()).toEqual([])
    expect(gone).toMatchObject({ preOrderField: "2026-12-01", backorderMarker: "print-on-demand" })

    await runStockSync(ctx, { trigger: "schedule" })
    expect(gone).toMatchObject({ allowBackorder: false, backorderMarker: null, preOrderField: undefined })
    expect(own).toMatchObject({ allowBackorder: true, backorderMarker: null })
    expect(catalogue.legacyDeletes()).toEqual([
      [
        { id: "v8", preOrderField: true },
        { id: "v9", preOrderField: false },
      ],
    ])
    // One short page: v1, v10, v2, v3, v4, v8, v9 by id.
    expect(catalogue.scanPages()).toEqual([[null, 500]])
    const at = NOW.toISOString()
    expect(state.values.get(STATE_KEYS.metadataScan)).toEqual({
      version: 2,
      after: "v9",
      scanned: 7,
      preOrderFields: 1,
      markers: 2,
      checks: 0,
      startedAt: at,
      updatedAt: at,
      completedAt: at,
    })

    // Once only.
    gone.preOrderField = "2026-12-01"
    catalogue.calls = []
    await runStockSync(ctx, { trigger: "schedule" })
    expect(catalogue.scanPages()).toEqual([])
    expect(gone.preOrderField).toBe("2026-12-01")
  })

  it("a failed scan is logged and runs again with the next full run", async () => {
    const gone = variant("v8", "9780000000002", { profileId: "sp_default", preOrderField: true })
    catalogue.outside.push(gone)
    catalogue.failNext("listPluginMetadata")
    const result = await runStockSync(ctx, { trigger: "schedule" })
    expect(result.status).toBe("completed")
    expect(warnings.some((w) => w.includes("couldn't check variant metadata"))).toBe(true)
    expect(state.values.get(STATE_KEYS.metadataScan)).toBeUndefined()
    expect(gone.preOrderField).toBe(true)
    await runStockSync(ctx, { trigger: "schedule" })
    expect(gone.preOrderField).toBeUndefined()
    expect(state.values.get(STATE_KEYS.metadataScan)).toMatchObject({ preOrderFields: 1, markers: 0, completedAt: NOW.toISOString() })
  })

  it("the scan's reasons outlast the run that calls it", async () => {
    // A 0.2.0 record: v6 is tracked, without a reason, and Print Trail lists
    // its SKU without a figure, so the run doesn't decide it.
    mock.state.stock["UNKNOWN-FIG"] = null as unknown as number
    catalogue.variants.push(variant("v6", "UNKNOWN-FIG", { allowBackorder: true, backorderMarker: "pre-order" }))
    await state.setState(STATE_KEYS.backordered, { ids: ["v6"] })
    await runStockSync(ctx, { trigger: "schedule" })
    expect(catalogue.get("v6")).toMatchObject({ allowBackorder: true, backorderMarker: null })
    expect(state.values.get(STATE_KEYS.backordered)).toEqual({ ids: ["v3", "v6"], reasons: { v3: "print-on-demand", v6: "pre-order" } })
  })

  it("the scan's deadline counts from the run's start, not its own", async () => {
    catalogue.outside.push(variant("v8", "OWN-1", { profileId: "sp_default", preOrderField: true }))
    // The run's main work takes 301 s.
    let reads = 0
    ctx.now = () => new Date(NOW.getTime() + (reads++ ? 301_000 : 0))
    const result = await runStockSync(ctx, { trigger: "schedule" })
    expect(result.status).toBe("completed")
    expect(catalogue.scanPages()).toEqual([])
    expect(warnings).toContainEqual(expect.stringContaining("no time left in this run to check variant metadata"))
    expect(state.values.get(STATE_KEYS.metadataScan)).toBeUndefined()
  })
})

// The scan must not outlive the stock lock, and offset pages would skip a
// variant when one already read was deleted.
describe("the variant metadata scan", () => {
  const stale = (id: string) => variant(id, `OWN-${id}`, { profileId: "sp_default", preOrderField: "2020-01-01" })
  let clock: number
  const run = (over: Partial<MetadataScanRun> = {}): MetadataScanRun => ({
    inScope: new Set(),
    ptProducts: null,
    startedAt: new Date(clock),
    ...over,
  })
  const limits = (over: Partial<MetadataScanLimits> = {}): MetadataScanLimits => ({
    pageSize: 2,
    maxPages: 10,
    deadlineMs: 300_000,
    ...over,
  })
  const scan = () => state.values.get(STATE_KEYS.metadataScan) as MetadataScan | undefined
  const flagged = () => catalogue.outside.filter((v) => v.preOrderField !== undefined).map((v) => v.id)

  beforeEach(() => {
    clock = NOW.getTime()
    ctx.now = () => new Date(clock)
    catalogue = new FakeCatalogue([])
    // Five variants outside the scope, each with a stale flag.
    catalogue.outside.push(...["v1", "v2", "v3", "v4", "v5"].map(stale))
    ctx.catalogue = catalogue
  })

  it("reads by id after the cursor, so deleting a variant already read hides none", async () => {
    // Offset pages would read [v1, v2], then skip 2 of [v2…v5]: [v4, v5].
    catalogue.onPage = (page) => {
      if (page === 1) catalogue.remove("v1")
    }
    await scanPluginMetadata(ctx, run(), limits())
    expect(catalogue.scanPages()).toEqual([
      [null, 2],
      ["v2", 2],
      ["v4", 2],
    ])
    expect(catalogue.legacyDeletes()).toContainEqual([
      { id: "v3", preOrderField: true },
      { id: "v4", preOrderField: true },
    ])
    expect(flagged()).toEqual([])
    const at = NOW.toISOString()
    expect(scan()).toEqual({
      version: 2,
      after: "v5",
      scanned: 5,
      preOrderFields: 5,
      markers: 0,
      checks: 0,
      startedAt: at,
      updatedAt: at,
      completedAt: at,
    })
  })

  it("stops at the page limit, and the next full run continues from the cursor", async () => {
    await scanPluginMetadata(ctx, run(), limits({ maxPages: 1 }))
    expect(scan()).toMatchObject({ after: "v2", scanned: 2, preOrderFields: 2, completedAt: null })
    expect(flagged()).toEqual(["v3", "v4", "v5"])

    catalogue.calls = []
    await scanPluginMetadata(ctx, run(), limits({ maxPages: 1 }))
    expect(catalogue.scanPages()).toEqual([["v2", 2]])
    expect(scan()).toMatchObject({ after: "v4", scanned: 4, preOrderFields: 4, completedAt: null })

    await scanPluginMetadata(ctx, run(), limits({ maxPages: 1 }))
    expect(scan()).toMatchObject({ after: "v5", scanned: 5, preOrderFields: 5, completedAt: NOW.toISOString() })
    expect(flagged()).toEqual([])
  })

  it("starts no page past the deadline, and the next full run continues from the cursor", async () => {
    // Each page takes 200 s: pages start at 0 s and 200 s, none at 400 s.
    catalogue.onPage = () => {
      clock += 200_000
    }
    await scanPluginMetadata(ctx, run(), limits())
    expect(catalogue.scanPages()).toEqual([
      [null, 2],
      ["v2", 2],
    ])
    expect(scan()).toMatchObject({ after: "v4", scanned: 4, completedAt: null })
    expect(flagged()).toEqual(["v5"])

    catalogue.calls = []
    await scanPluginMetadata(ctx, run(), limits())
    expect(catalogue.scanPages()).toEqual([["v4", 2]])
    expect(scan()).toMatchObject({ after: "v5", scanned: 5, preOrderFields: 5, completedAt: expect.any(String) })
    expect(flagged()).toEqual([])
  })

  it("reads nothing when the run is already past the deadline", async () => {
    await scanPluginMetadata(ctx, run({ startedAt: new Date(clock - 300_000) }), limits())
    expect(catalogue.scanPages()).toEqual([])
    expect(scan()).toBeUndefined()
    expect(warnings).toContainEqual(expect.stringContaining("no time left"))
  })

  it("records completion only once a page comes back short", async () => {
    // Four variants: two full pages, then an empty one.
    catalogue.remove("v5")
    await scanPluginMetadata(ctx, run(), limits({ maxPages: 2 }))
    expect(scan()).toMatchObject({ after: "v4", scanned: 4, completedAt: null })

    catalogue.calls = []
    await scanPluginMetadata(ctx, run(), limits({ maxPages: 2 }))
    expect(catalogue.scanPages()).toEqual([["v4", 2]])
    expect(scan()).toMatchObject({ after: "v4", scanned: 4, preOrderFields: 4, completedAt: NOW.toISOString() })

    // And it never runs again.
    catalogue.calls = []
    await scanPluginMetadata(ctx, run(), limits())
    expect(catalogue.scanPages()).toEqual([])
  })

  it("a failed write keeps the page's cursor, and the next full run reads it again", async () => {
    // Page 1 has nothing to delete; page 2's write fails.
    for (const v of catalogue.outside.slice(0, 2)) v.preOrderField = undefined
    catalogue.failNext("deleteLegacyKeys")
    await scanPluginMetadata(ctx, run(), limits())
    expect(warnings).toContainEqual(expect.stringContaining("couldn't check variant metadata for stale keys: deleteLegacyKeys broke"))
    expect(scan()).toMatchObject({ after: "v2", scanned: 2, preOrderFields: 0, completedAt: null })
    expect(flagged()).toEqual(["v3", "v4", "v5"])

    catalogue.calls = []
    await scanPluginMetadata(ctx, run(), limits())
    expect(catalogue.scanPages()).toEqual([
      ["v2", 2],
      ["v4", 2],
    ])
    expect(scan()).toMatchObject({ after: "v5", scanned: 5, preOrderFields: 3, completedAt: NOW.toISOString() })
    expect(flagged()).toEqual([])
  })

  it("a failed read keeps the cursor too", async () => {
    catalogue.onPage = (page) => {
      if (page === 1) catalogue.failNext("listPluginMetadata")
    }
    await scanPluginMetadata(ctx, run(), limits())
    expect(scan()).toMatchObject({ after: "v2", scanned: 2, completedAt: null })
    catalogue.calls = []
    await scanPluginMetadata(ctx, run(), limits())
    expect(catalogue.scanPages()[0]).toEqual(["v2", 2])
    expect(scan()).toMatchObject({ after: "v5", scanned: 5, completedAt: NOW.toISOString() })
  })

  it("acts on the scope it is given", async () => {
    // v1 is in this run's scope: the run itself keeps its flag right.
    await scanPluginMetadata(ctx, run({ inScope: new Set(["v1"]) }), limits())
    expect(flagged()).toEqual(["v1"])
    expect(scan()).toMatchObject({ preOrderFields: 4 })
  })

  it("scans again after a record from the first 0.2.0 build, which has no cursor", async () => {
    await state.setState(STATE_KEYS.metadataScan, { at: NOW.toISOString(), preOrderFields: 0, markers: 0 })
    await scanPluginMetadata(ctx, run(), limits())
    expect(catalogue.scanPages()[0]).toEqual([null, 2])
    expect(scan()).toMatchObject({ version: 2, after: "v5", scanned: 5, completedAt: NOW.toISOString() })
  })

  it("a completed 0.2.0 scan record restarts as version 2", async () => {
    const at = "2026-10-01T00:00:00.000Z"
    await state.setState(STATE_KEYS.metadataScan, {
      after: "v5",
      scanned: 5,
      preOrderFields: 3,
      markers: 1,
      startedAt: at,
      updatedAt: at,
      completedAt: at,
    })
    await scanPluginMetadata(ctx, run(), limits())
    expect(catalogue.scanPages()[0]).toEqual([null, 2])
    // Counted afresh.
    expect(scan()).toEqual({
      version: 2,
      after: "v5",
      scanned: 5,
      preOrderFields: 5,
      markers: 0,
      checks: 0,
      startedAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
      completedAt: NOW.toISOString(),
    })
    // A completed version 2 record is done.
    catalogue.calls = []
    await scanPluginMetadata(ctx, run(), limits())
    expect(catalogue.scanPages()).toEqual([])
  })

  describe("the keys 0.2.0 kept in variant metadata", () => {
    const legacy = (sku: string, status = "not-found") => ({ sku, status, checked_at: "2026-10-01T00:00:00.000Z" })
    const variantOf = (id: string) => catalogue.outside.find((v) => v.id === id)!

    beforeEach(() => {
      for (const v of catalogue.outside) delete v.preOrderField
    })

    it("a legacy check is adopted, then deleted; an existing row wins", async () => {
      variantOf("v1").skuCheck = legacy("OWN-v1")
      variantOf("v2").skuCheck = { ...legacy("OWN-v2", "matched"), matched_sku: "own-v2-canon" }
      // The SKU check wrote v3's row after 0.2.0 wrote its metadata.
      variantOf("v3").skuCheck = legacy("OWN-v3")
      variantRows.add("v3", "prod_v3", { sku: "OWN-v3", status: "matched", checked_at: NOW.toISOString() })
      await scanPluginMetadata(ctx, run(), limits())
      expect(variantRows.get("v1")).toMatchObject({ check_sku: "OWN-v1", check_status: "not-found", check_source: "metadata", product_id: "prod_v1" })
      expect(variantRows.get("v2")).toMatchObject({ check_status: "matched", check_matched_sku: "own-v2-canon", check_source: "metadata" })
      expect(variantRows.get("v3")).toMatchObject({ check_status: "matched", check_source: "sku-check" })
      expect(catalogue.outside.map((v) => v.skuCheck)).toEqual([undefined, undefined, undefined, undefined, undefined])
      expect(scan()).toMatchObject({ checks: 2, completedAt: NOW.toISOString() })
    })

    it("a failed adoption keeps the legacy check and the page's cursor", async () => {
      variantOf("v1").skuCheck = legacy("OWN-v1")
      variantRows.failNext("adopt")
      await scanPluginMetadata(ctx, run(), limits())
      expect(warnings).toContainEqual(expect.stringContaining("adopt broke"))
      // Not deleted before it was adopted.
      expect(variantOf("v1").skuCheck).toEqual(legacy("OWN-v1"))
      expect(scan()).toBeUndefined()
      await scanPluginMetadata(ctx, run(), limits())
      expect(variantRows.get("v1")).toMatchObject({ check_status: "not-found", check_source: "metadata" })
      expect(variantOf("v1").skuCheck).toBeUndefined()
    })

    // Unlike a failed adoption (above), a row the database refuses doesn't
    // stop the page: the key's deletion is a metadata write, whose
    // product-variant.updated has the SKU check check the variant again.
    it("a check the database refuses isn't adopted, and its key is still deleted", async () => {
      variantOf("v1").skuCheck = legacy("OWN-v1")
      variantOf("v2").skuCheck = legacy("OWN-v2")
      variantRows.refused.add("v2")
      await scanPluginMetadata(ctx, run(), limits())
      expect(variantRows.get("v1")).toMatchObject({ check_sku: "OWN-v1", check_source: "metadata" })
      expect(variantRows.get("v2")).toBeUndefined()
      expect(variantOf("v2").skuCheck).toBeUndefined()
      expect(catalogue.legacyDeletes().flat()).toContainEqual({ id: "v2", preOrderField: false })
      expect(scan()).toMatchObject({ checks: 1, completedAt: NOW.toISOString() })
    })

    it("a check outside Print Trail's profiles isn't adopted, but is deleted", async () => {
      variantOf("v1").skuCheck = legacy("OWN-v1")
      variantOf("v2").skuCheck = legacy("OWN-v2")
      // A malformed value: nothing to adopt, still deleted.
      variantOf("v4").skuCheck = "matched"
      await scanPluginMetadata(ctx, run({ ptProducts: new Set(["prod_v1"]) }), limits())
      expect(variantRows.rows.map((r) => r.variant_id)).toEqual(["v1"])
      expect(variantOf("v2").skuCheck).toBeUndefined()
      expect(variantOf("v4").skuCheck).toBeUndefined()
      expect(scan()).toMatchObject({ checks: 1 })
    })

    it("a tracked variant's marker becomes its reason, then is deleted", async () => {
      Object.assign(variantOf("v1"), { allowBackorder: true, backorderMarker: "pre-order" })
      Object.assign(variantOf("v2"), { allowBackorder: true, backorderMarker: "pre-order" })
      // v2's reason is already recorded: the record wins.
      await state.setState(STATE_KEYS.backordered, { ids: ["v1", "v2"], reasons: { v2: "print-on-demand" } })
      await scanPluginMetadata(ctx, run(), limits())
      expect(state.values.get(STATE_KEYS.backordered)).toEqual({ ids: ["v1", "v2"], reasons: { v1: "pre-order", v2: "print-on-demand" } })
      expect(catalogue.outside.map((v) => v.backorderMarker)).toEqual([null, null, null, null, null])
      // allow_backorder isn't written.
      expect(catalogue.calls.filter((c) => c.method === "setBackorder")).toEqual([])
      expect(scan()).toMatchObject({ markers: 2 })
    })

    it("an untracked variant's marker is deleted and its backorder left alone", async () => {
      Object.assign(variantOf("v3"), { allowBackorder: true, backorderMarker: "print-on-demand" })
      await state.setState(STATE_KEYS.backordered, { ids: [], reasons: {} })
      await scanPluginMetadata(ctx, run(), limits())
      expect(variantOf("v3")).toMatchObject({ allowBackorder: true, backorderMarker: null })
      expect(state.values.get(STATE_KEYS.backordered)).toEqual({ ids: [], reasons: {} })
      expect(catalogue.calls.filter((c) => c.method === "setBackorder")).toEqual([])
    })

    it("with an unknown scope, print_trail_pre_order is left", async () => {
      variantOf("v1").preOrderField = "2026-12-01"
      variantOf("v2").preOrderField = true
      variantOf("v2").backorderMarker = "pre-order"
      variantOf("v2").skuCheck = legacy("OWN-v2", "pre-order")
      await scanPluginMetadata(ctx, run({ inScope: null }), limits())
      expect(variantOf("v1").preOrderField).toBe("2026-12-01")
      expect(variantOf("v2")).toMatchObject({ preOrderField: true, backorderMarker: null, skuCheck: undefined })
      // v1 has nothing else to delete: not written.
      expect(catalogue.legacyDeletes()).toEqual([[{ id: "v2", preOrderField: false }]])
      expect(scan()).toMatchObject({ preOrderFields: 0, completedAt: NOW.toISOString() })
    })

    it("completion deletes sku_check_unmatched", async () => {
      await state.setState(STATE_KEYS.skuCheckUnmatched, { skus: ["OWN-v1"] })
      await scanPluginMetadata(ctx, run(), limits({ maxPages: 1 }))
      // Not until every variant has been read.
      expect(state.values.get(STATE_KEYS.skuCheckUnmatched)).toEqual({ skus: ["OWN-v1"] })
      await scanPluginMetadata(ctx, run(), limits())
      expect(scan()?.completedAt).toBe(NOW.toISOString())
      expect(state.values.get(STATE_KEYS.skuCheckUnmatched)).toBeNull()
    })
  })
})

// The activation scan doesn't depend on pre_order_skus,
// which any stock run between activation and the batched webhook rewrites.
describe("pre-order SKUs seen", () => {
  it("a stock sync between activation and the webhook leaves the SKU seen", async () => {
    const seen = memoryPreOrderSeen()
    ctx.seen = seen
    mock.state.stock["PRE-1"] = 0
    mock.state.skuStatus["PRE-1"] = "pre-order"
    await runStockSync(ctx, { trigger: "schedule" })
    // Live at Print Trail; a shortfall refresh and the daily job run before
    // the batched webhook arrives.
    mock.state.skuStatus["PRE-1"] = "active"
    await runStockSync(ctx, { trigger: "shortfall", skus: ["PRE-1"] })
    await runStockSync(ctx, { trigger: "schedule" })
    expect(await seen.preOrderSeen(["PRE-1"])).toEqual(["PRE-1"])
  })

  it("marks pre-order SKUs even when the run fails or isn't trusted", async () => {
    const seen = memoryPreOrderSeen()
    ctx.seen = seen
    mock.state.stock["PRE-1"] = 0
    mock.state.skuStatus["PRE-1"] = "pre-order"
    catalogue.variants.push(variant("v5", "PRE-1"))
    catalogue.failNext("updateLevels")
    expect((await runStockSync(ctx, { trigger: "schedule" })).status).toBe("failed")
    expect(await seen.preOrderSeen(["PRE-1"])).toEqual(["PRE-1"])
    // No Print Trail profiles: an untrusted run changes nothing, but the SKU
    // is still recorded.
    const other = memoryPreOrderSeen()
    ctx.seen = other
    catalogue.profiles = []
    expect((await runStockSync(ctx, { trigger: "schedule" })).status).toBe("failed")
    expect(await other.preOrderSeen(["PRE-1"])).toEqual(["PRE-1"])
  })

  it("a fresh install's SKU-only run hides nothing", async () => {
    const seen = memoryPreOrderSeen()
    ctx.seen = seen
    // The first run ever is a SKU-only refresh, before PRE-1 is on pre-order.
    mock.state.stock["PRE-1"] = 0
    await runStockSync(ctx, { trigger: "shortfall", skus: ["9780000000002"] })
    expect(await seen.preOrderSeen(["PRE-1"])).toEqual([])
    // PRE-1 goes pre-order; an order for it is confirmed with a waiting
    // fulfilment, and the confirm path marks what it holds.
    mock.state.skuStatus["PRE-1"] = "pre-order"
    const c = new PrintTrailClient({ baseUrl: mock.url, channelId: "acme-medusa1", apiToken: "t", retryDelays: [0] })
    const o = await c.createOrder({ orderNumber: "ORD-F1", orderLines: [{ quantity: 1, lineNumber: "l1", product: { sku: "PRE-1" } }] })
    const pt = await c.confirmOrder(o.uuid, {})
    await markWaitingSkus(seen, pt)
    expect(await seen.preOrderSeen(["PRE-1", "9780000000002"])).toEqual(["PRE-1"])
    // A later SKU-only run doesn't hide it.
    await runStockSync(ctx, { trigger: "shortfall", skus: ["9780000000002"] })
    expect(await seen.preOrderSeen(["PRE-1"])).toEqual(["PRE-1"])
  })
})
