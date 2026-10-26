import {
  acceptDelivery,
  advanceWatermark,
  dispatchedSkus,
  mergeUnmatched,
  planStockSync,
  shortfallSkus,
  stockFigure,
  type StockVariant,
} from "../stock"
import { preOrderKind } from "../pre-order"

const PT = "sp_pt"
const profiles = new Set([PT])

const variant = (over: Partial<StockVariant> & { id: string }): StockVariant => ({
  sku: "SKU-1",
  profileId: PT,
  manageInventory: true,
  allowBackorder: false,
  backorderMarker: null,
  inventory: [
    { inventoryItemId: `iitem_${over.id}`, requiredQuantity: 1, levels: [{ locationId: "sloc_a", stockedQuantity: 0 }] },
  ],
  ...over,
})

const twoLevels = (id: string, a = 0, b = 0) => [
  {
    inventoryItemId: `iitem_${id}`,
    requiredQuantity: 1,
    levels: [
      { locationId: "sloc_a", stockedQuantity: a },
      { locationId: "sloc_b", stockedQuantity: b },
    ],
  },
]

describe("stockFigure", () => {
  it("reads print-on-demand as the marker plus warehouse stock", () => {
    expect(stockFigure(10003)).toEqual({ stock: 3, printOnDemand: true })
    expect(stockFigure(10000)).toEqual({ stock: 0, printOnDemand: true })
    expect(stockFigure(12.7)).toEqual({ stock: 12, printOnDemand: false })
    expect(stockFigure(-2)).toEqual({ stock: 0, printOnDemand: false })
    expect(stockFigure(NaN)).toEqual({ stock: 0, printOnDemand: false })
  })
})

describe("planStockSync", () => {
  it("writes every level of the item, or only stockLocationIds", () => {
    const v = variant({ id: "v1", inventory: twoLevels("v1", 1, 2) })
    const levels = [{ sku: "SKU-1", stock: 7 }]
    expect(planStockSync({ levels, variants: [v], ptProfileIds: profiles }).levelUpdates).toEqual([
      { inventory_item_id: "iitem_v1", location_id: "sloc_a", stocked_quantity: 7 },
      { inventory_item_id: "iitem_v1", location_id: "sloc_b", stocked_quantity: 7 },
    ])
    expect(
      planStockSync({ levels, variants: [v], ptProfileIds: profiles, stockLocationIds: ["sloc_b"] }).levelUpdates
    ).toEqual([{ inventory_item_id: "iitem_v1", location_id: "sloc_b", stocked_quantity: 7 }])
    // An unchanged level gives no entry.
    const same = variant({ id: "v2", inventory: twoLevels("v2", 7, 3) })
    expect(planStockSync({ levels, variants: [same], ptProfileIds: profiles }).levelUpdates).toEqual([
      { inventory_item_id: "iitem_v2", location_id: "sloc_b", stocked_quantity: 7 },
    ])
  })

  it("never creates a level and skips a variant with none", () => {
    const none = variant({ id: "v1", inventory: [{ inventoryItemId: "iitem_v1", requiredQuantity: 1, levels: [] }] })
    const elsewhere = variant({ id: "v2", sku: "SKU-2" })
    const plan = planStockSync({
      levels: [{ sku: "SKU-1", stock: 4 }, { sku: "SKU-2", stock: 4 }],
      variants: [none, elsewhere],
      ptProfileIds: profiles,
      stockLocationIds: ["sloc_z"],
    })
    expect(plan.levelUpdates).toEqual([])
    expect(plan.skipped).toEqual([
      { variantId: "v1", reason: "no-level" },
      { variantId: "v2", reason: "no-level" },
    ])
  })

  it("skips kits and variants without a SKU", () => {
    const noSku = variant({ id: "v1", sku: null })
    const twoItems = variant({
      id: "v2",
      inventory: [...twoLevels("v2a"), ...twoLevels("v2b")],
    })
    const double = variant({
      id: "v3",
      inventory: [{ inventoryItemId: "iitem_v3", requiredQuantity: 2, levels: [{ locationId: "sloc_a", stockedQuantity: 0 }] }],
    })
    const plan = planStockSync({
      levels: [{ sku: "SKU-1", stock: 4 }],
      variants: [noSku, twoItems, double],
      ptProfileIds: profiles,
    })
    expect(plan.levelUpdates).toEqual([])
    expect(plan.skipped).toEqual([
      { variantId: "v1", reason: "no-sku" },
      { variantId: "v2", reason: "kit" },
      { variantId: "v3", reason: "kit" },
    ])
  })

  it("leaves an unmatched variant's stock alone and lists it", () => {
    const v = variant({ id: "v1", sku: "Gone-1", inventory: twoLevels("v1", 5, 5) })
    const plan = planStockSync({ levels: [{ sku: "SKU-1", stock: 0 }], variants: [v], ptProfileIds: profiles })
    expect(plan.levelUpdates).toEqual([])
    expect(plan.unmatched).toEqual(["Gone-1"])
    expect(plan.matched).toEqual([])
  })

  it("touches only own-stock variants", () => {
    const otherProfile = variant({ id: "v1", profileId: "sp_default", allowBackorder: false })
    const unmanaged = variant({ id: "v2", manageInventory: false })
    const noProfile = variant({ id: "v3", profileId: null, sku: "NOT-PT" })
    const plan = planStockSync({
      levels: [{ sku: "SKU-1", stock: 10004 }],
      variants: [otherProfile, unmanaged, noProfile],
      ptProfileIds: profiles,
    })
    expect(plan).toEqual({
      levelUpdates: [],
      backorderOn: [],
      backorderReason: {},
      backorderOff: [],
      staleMarkers: [],
      matched: [],
      unmatched: [],
      unknown: [],
      duplicateSkus: [],
      multiLocationSkus: [],
      skipped: [],
      inScope: [],
    })
  })

  it("turns backorders on for print-on-demand and off when it ends", () => {
    const v = variant({ id: "v1" })
    const on = planStockSync({ levels: [{ sku: "SKU-1", stock: 10003 }], variants: [v], ptProfileIds: profiles })
    expect(on.backorderOn).toEqual(["v1"])
    expect(on.levelUpdates).toEqual([{ inventory_item_id: "iitem_v1", location_id: "sloc_a", stocked_quantity: 3 }])

    const marked = variant({ id: "v1", allowBackorder: true, backorderMarker: "print-on-demand" })
    const tracked = new Set(["v1"])
    const still = planStockSync({ levels: [{ sku: "SKU-1", stock: 10003 }], variants: [marked], ptProfileIds: profiles, tracked })
    expect(still.backorderOn).toEqual([])
    expect(still.backorderOff).toEqual([])
    const off = planStockSync({ levels: [{ sku: "SKU-1", stock: 4 }], variants: [marked], ptProfileIds: profiles, tracked })
    expect(off.backorderOff).toEqual(["v1"])
    expect(off.backorderOn).toEqual([])
  })

  it("never switches off a backorder the plugin didn't set", () => {
    const merchant = variant({ id: "v1", allowBackorder: true, backorderMarker: null })
    for (const stock of [10005, 9999, 3]) {
      const plan = planStockSync({ levels: [{ sku: "SKU-1", stock }], variants: [merchant], ptProfileIds: profiles })
      expect(plan.backorderOff).toEqual([])
      expect(plan.backorderOn).toEqual([])
    }
    const gone = planStockSync({ levels: [], variants: [merchant], ptProfileIds: profiles })
    expect(gone.backorderOff).toEqual([])
    // A marker alone (say, copied by the merchant) isn't the plugin's record.
    const markedOnly = variant({ id: "v2", allowBackorder: true, backorderMarker: "print-on-demand" })
    expect(planStockSync({ levels: [{ sku: "SKU-1", stock: 3 }], variants: [markedOnly], ptProfileIds: profiles }).backorderOff).toEqual([])
  })

  it("switches off a tracked backorder whose marker was lost", () => {
    const lost = variant({ id: "v1", allowBackorder: true, backorderMarker: null })
    const plan = planStockSync({ levels: [{ sku: "SKU-1", stock: 3 }], variants: [lost], ptProfileIds: profiles, tracked: new Set(["v1"]) })
    expect(plan.backorderOff).toEqual(["v1"])
  })

  it("switches off a plugin backorder when the SKU leaves Print Trail", () => {
    const marked = variant({ id: "v1", allowBackorder: true, backorderMarker: "print-on-demand" })
    const plan = planStockSync({
      levels: [{ sku: "OTHER", stock: 10003 }],
      variants: [marked],
      ptProfileIds: profiles,
      tracked: new Set(["v1"]),
    })
    expect(plan.backorderOff).toEqual(["v1"])
    expect(plan.unmatched).toEqual(["SKU-1"])
    expect(plan.levelUpdates).toEqual([])
  })

  it("switches off a plugin backorder on a variant that loses its SKU or becomes a kit", () => {
    const noSku = variant({ id: "v1", sku: null, allowBackorder: true, backorderMarker: "print-on-demand" })
    const kit = variant({
      id: "v2",
      allowBackorder: true,
      backorderMarker: "print-on-demand",
      inventory: [...twoLevels("v2a"), ...twoLevels("v2b")],
    })
    const merchant = variant({ id: "v3", sku: null, allowBackorder: true })
    const plan = planStockSync({
      levels: [{ sku: "SKU-1", stock: 10004 }],
      variants: [noSku, kit, merchant],
      ptProfileIds: profiles,
      tracked: new Set(["v1", "v2"]),
    })
    expect(plan.backorderOff).toEqual(["v1", "v2"])
    expect(plan.inScope).toEqual(["v1", "v2", "v3"])
  })

  it("leaves a variant alone when Print Trail's figure is unknown", () => {
    const v = variant({ id: "v1", inventory: twoLevels("v1", 5, 5), allowBackorder: true, backorderMarker: "print-on-demand" })
    const tracked = new Set(["v1"])
    for (const stock of [null, "abc", undefined, ""] as unknown as number[]) {
      const plan = planStockSync({ levels: [{ sku: "SKU-1", stock }], variants: [v], ptProfileIds: profiles, tracked })
      expect(plan.levelUpdates).toEqual([])
      expect(plan.backorderOff).toEqual([])
      expect(plan.unmatched).toEqual([])
      expect(plan.unknown).toEqual(["SKU-1"])
      expect(plan.skipped).toEqual([{ variantId: "v1", reason: "unknown-figure" }])
    }
    // A bad row doesn't hide a good one for the same SKU.
    const plan = planStockSync({
      levels: [{ sku: "SKU-1", stock: null as unknown as number }, { sku: "sku-1", stock: "7" as unknown as number }],
      variants: [v],
      ptProfileIds: profiles,
    })
    expect(plan.levelUpdates).toHaveLength(2)
    expect(plan.unknown).toEqual([])
  })

  it("refuses a SKU shared by variants with their own inventory items", () => {
    const a = variant({ id: "va", sku: "DUP-1" })
    const b = variant({ id: "vb", sku: "dup-1" })
    const c = variant({ id: "vc", sku: "OK-1" })
    const plan = planStockSync({
      levels: [{ sku: "DUP-1", stock: 10005 }, { sku: "OK-1", stock: 2 }],
      variants: [a, b, c],
      ptProfileIds: profiles,
    })
    expect(plan.levelUpdates).toEqual([{ inventory_item_id: "iitem_vc", location_id: "sloc_a", stocked_quantity: 2 }])
    expect(plan.skipped).toEqual([
      { variantId: "va", reason: "duplicate-sku" },
      { variantId: "vb", reason: "duplicate-sku" },
    ])
    expect(plan.duplicateSkus).toEqual(["DUP-1"])
    expect(plan.backorderOn).toEqual([])
  })

  it("warns when one SKU's figure goes to several locations", () => {
    const many = variant({ id: "v1", inventory: twoLevels("v1") })
    const one = variant({ id: "v2", sku: "SKU-2" })
    const levels = [{ sku: "SKU-1", stock: 3 }, { sku: "SKU-2", stock: 3 }]
    expect(planStockSync({ levels, variants: [many, one], ptProfileIds: profiles }).multiLocationSkus).toEqual(["SKU-1"])
    // Not when stockLocationIds says where Print Trail's stock lives.
    expect(
      planStockSync({ levels, variants: [many, one], ptProfileIds: profiles, stockLocationIds: ["sloc_a", "sloc_b"] }).multiLocationSkus
    ).toEqual([])
  })

  it("refuses conflicting writes to a shared inventory item", () => {
    const shared = [{ inventoryItemId: "iitem_shared", requiredQuantity: 1, levels: [{ locationId: "sloc_a", stockedQuantity: 0 }] }]
    const a = variant({ id: "va", sku: "A", inventory: shared })
    const b = variant({ id: "vb", sku: "B", inventory: shared })
    const conflict = planStockSync({
      levels: [{ sku: "A", stock: 3 }, { sku: "B", stock: 5 }],
      variants: [a, b],
      ptProfileIds: profiles,
    })
    expect(conflict.levelUpdates).toEqual([])
    expect(conflict.skipped).toEqual([
      { variantId: "va", reason: "shared-item-conflict" },
      { variantId: "vb", reason: "shared-item-conflict" },
    ])
    const agree = planStockSync({
      levels: [{ sku: "A", stock: 5 }, { sku: "B", stock: 5 }],
      variants: [a, b],
      ptProfileIds: profiles,
    })
    expect(agree.levelUpdates).toEqual([{ inventory_item_id: "iitem_shared", location_id: "sloc_a", stocked_quantity: 5 }])
    expect(agree.skipped).toEqual([])
  })

  it("limits a shortfall refresh to its SKUs", () => {
    const a = variant({ id: "va", sku: "A" })
    const b = variant({ id: "vb", sku: "B" })
    const plan = planStockSync({
      levels: [{ sku: "A", stock: 3 }, { sku: "B", stock: 5 }],
      variants: [a, b],
      ptProfileIds: profiles,
      onlySkus: ["a"],
    })
    expect(plan.levelUpdates).toEqual([{ inventory_item_id: "iitem_va", location_id: "sloc_a", stocked_quantity: 3 }])
    expect(plan.matched).toEqual(["A"])
  })

  it("matches SKUs case-insensitively and ignores null SKUs", () => {
    const v = variant({ id: "v1", sku: "abc-1" })
    const plan = planStockSync({
      levels: [
        { sku: null, stock: 5 },
        { sku: "", stock: 5 },
        { sku: "ABC-1", stock: 2 },
        { sku: "Abc-1", stock: 9 },
      ],
      variants: [v],
      ptProfileIds: profiles,
    })
    expect(plan.levelUpdates).toEqual([{ inventory_item_id: "iitem_v1", location_id: "sloc_a", stocked_quantity: 2 }])
    expect(plan.matched).toEqual(["abc-1"])
  })
})

describe("watermark", () => {
  it("drops a delivery not newer than the watermark", () => {
    const w = { changedAt: "2026-10-19T10:00:00Z" }
    expect(acceptDelivery(null, "2026-10-19T10:00:00Z")).toBe(true)
    expect(acceptDelivery(w, "2026-10-19T10:00:00Z")).toBe(false)
    expect(acceptDelivery(w, "2026-10-19T09:59:59Z")).toBe(false)
    expect(acceptDelivery(w, "2026-10-19T10:00:01Z")).toBe(true)
    expect(advanceWatermark(w, "2026-10-19T09:00:00Z")).toEqual(w)
    expect(advanceWatermark(w, "2026-10-19T11:00:00Z")).toEqual({ changedAt: "2026-10-19T11:00:00Z" })
    expect(advanceWatermark({ changedAt: "garbage" }, "2026-10-19T09:00:00Z")).toEqual({ changedAt: "2026-10-19T09:00:00Z" })
  })

  it("compares changedAt as instants", () => {
    const w = { changedAt: "2026-10-19T10:00:00Z" }
    expect(acceptDelivery(w, "2026-10-19T11:00:00+01:00")).toBe(false)
    expect(acceptDelivery(w, "2026-10-19T11:00:01+01:00")).toBe(true)
    // String order would say "2026-10-19T09:30:00-01:00" < w; as an instant it's later.
    expect(acceptDelivery(w, "2026-10-19T09:30:00-01:00")).toBe(true)
    expect(advanceWatermark({ changedAt: "2026-10-19T11:00:00+01:00" }, "2026-10-19T10:00:00Z")).toEqual({
      changedAt: "2026-10-19T11:00:00+01:00",
    })
  })

  it("applies a delivery without changedAt but keeps the watermark", () => {
    const w = { changedAt: "2026-10-19T10:00:00Z" }
    expect(acceptDelivery(w, null)).toBe(true)
    expect(acceptDelivery(w, undefined)).toBe(true)
    expect(acceptDelivery(w, "not a date")).toBe(true)
    expect(advanceWatermark(w, null)).toEqual(w)
    expect(advanceWatermark(w, "not a date")).toEqual(w)
    expect(advanceWatermark(null, undefined)).toBeNull()
  })
})

describe("mergeUnmatched and shortfallSkus", () => {
  it("merges the unmatched list case-insensitively", () => {
    expect(mergeUnmatched(["b", "A"], { replace: ["Z", "z", "y"] })).toEqual(["y", "Z"])
    expect(mergeUnmatched(["b", "A"], { add: ["a", "C"] })).toEqual(["A", "b", "C"])
    expect(mergeUnmatched(["b", "A", "c"], { forget: ["B"], add: ["d"] })).toEqual(["A", "c", "d"])
    expect(mergeUnmatched([], {})).toEqual([])
  })

  it("reads distinct SKUs from a stored shortfall", () => {
    expect(
      shortfallSkus([
        { sku: "A", requested: 2, available: 0 },
        { sku: "a", requested: 1, available: 0 },
        { sku: "", requested: 1, available: 0 },
        { requested: 1 },
        { sku: "B", requested: 1, available: 0 },
      ])
    ).toEqual(["A", "B"])
    expect(shortfallSkus(null)).toEqual([])
    expect(shortfallSkus({ sku: "A" })).toEqual([])
  })
})

describe("dispatchedSkus", () => {
  it("reads a dispatched fulfilment's SKUs, falling back to the submitted lines", () => {
    const row = {
      fulfilments: [
        {
          uuid: "f-1",
          orderLines: [
            { lineNumber: "item_1", product: { sku: "A-1" } },
            { lineNumber: "item_2", product: { uuid: "prod-x" } },
            { lineNumber: "item_3", product: { sku: "a-1" } },
          ],
        },
        { uuid: "f-2", orderLines: [{ lineNumber: "item_9", product: { sku: "OTHER" } }] },
      ],
      submitted_lines: [
        { lineNumber: "item_1", product: { sku: "A-1" } },
        { lineNumber: "item_2", product: { sku: "B-2" } },
      ],
    }
    expect(dispatchedSkus(row, "f-1")).toEqual(["A-1", "B-2"])
    expect(dispatchedSkus(row, "missing")).toEqual([])
    expect(dispatchedSkus({ fulfilments: null, submitted_lines: null }, "f-1")).toEqual([])
  })
})

// API 1.3.0: status, preOrderLimit and preOrderRemaining.
describe("planStockSync with pre-order rows", () => {
  const pre = (over: Record<string, unknown> = {}) => ({
    sku: "SKU-1",
    stock: 0,
    status: "pre-order" as const,
    publicationDate: "2026-12-01",
    preOrderLimit: null,
    preOrderRemaining: null,
    ...over,
  })
  const active = (stock: number, over: Record<string, unknown> = {}) => ({
    sku: "SKU-1",
    stock,
    status: "active" as const,
    publicationDate: null,
    preOrderLimit: null,
    preOrderRemaining: null,
    ...over,
  })

  it("an unlimited pre-order gets backorders", () => {
    const v = variant({ id: "v1", inventory: [{ inventoryItemId: "iitem_v1", requiredQuantity: 1, levels: [{ locationId: "sloc_a", stockedQuantity: 4 }] }] })
    const plan = planStockSync({ levels: [pre()], variants: [v], ptProfileIds: profiles })
    expect(plan.backorderOn).toEqual(["v1"])
    expect(plan.backorderReason).toEqual({ v1: "pre-order" })
    expect(plan.levelUpdates).toEqual([{ inventory_item_id: "iitem_v1", location_id: "sloc_a", stocked_quantity: 0 }])
    expect(plan.preOrders).toEqual([{ sku: "SKU-1", publicationDate: "2026-12-01", limit: null, remaining: null }])
  })

  it("a limited pre-order is written as stock, without backorders", () => {
    const v = variant({ id: "v1" })
    const plan = planStockSync({ levels: [pre({ stock: 40, preOrderLimit: 50, preOrderRemaining: 40 })], variants: [v], ptProfileIds: profiles })
    expect(plan.levelUpdates).toEqual([{ inventory_item_id: "iitem_v1", location_id: "sloc_a", stocked_quantity: 40 }])
    expect(plan.backorderOn).toEqual([])
    expect(plan.backorderOff).toEqual([])
    expect(plan.preOrders).toEqual([{ sku: "SKU-1", publicationDate: "2026-12-01", limit: 50, remaining: 40 }])
    // A tracked variant whose SKU becomes limited comes off.
    const tracked = variant({ id: "v1", allowBackorder: true, backorderMarker: "pre-order" })
    const off = planStockSync({ levels: [pre({ stock: 40, preOrderLimit: 50, preOrderRemaining: 40 })], variants: [tracked], ptProfileIds: profiles, tracked: new Set(["v1"]) })
    expect(off.backorderOff).toEqual(["v1"])
  })

  it("a sold-out limited pre-order is 0 without backorders", () => {
    const v = variant({ id: "v1", inventory: [{ inventoryItemId: "iitem_v1", requiredQuantity: 1, levels: [{ locationId: "sloc_a", stockedQuantity: 3 }] }] })
    const plan = planStockSync({ levels: [pre({ stock: 0, preOrderLimit: 50, preOrderRemaining: 0 })], variants: [v], ptProfileIds: profiles })
    expect(plan.levelUpdates).toEqual([{ inventory_item_id: "iitem_v1", location_id: "sloc_a", stocked_quantity: 0 }])
    expect(plan.backorderOn).toEqual([])
  })

  it("a limited pre-order on a print-on-demand product reports what remains, not 10000", () => {
    // Print Trail: the remaining allowance replaces the sentinel.
    const plan = planStockSync({ levels: [pre({ stock: 12, preOrderLimit: 20, preOrderRemaining: 12 })], variants: [variant({ id: "v1" })], ptProfileIds: profiles })
    expect(plan.levelUpdates[0].stocked_quantity).toBe(12)
    expect(plan.backorderOn).toEqual([])
    // An unlimited pre-order with print-on-demand is print-on-demand.
    const pod = planStockSync({ levels: [pre({ stock: 10002 })], variants: [variant({ id: "v1" })], ptProfileIds: profiles })
    expect(pod.backorderReason).toEqual({ v1: "print-on-demand" })
    expect(pod.levelUpdates[0].stocked_quantity).toBe(2)
  })

  it("a pre-order row without the limit keys is today's behaviour", () => {
    const row = { sku: "SKU-1", stock: 0, status: "pre-order" as const }
    const plan = planStockSync({ levels: [row], variants: [variant({ id: "v1" })], ptProfileIds: profiles })
    expect(plan.backorderOn).toEqual([])
  })

  it("a stale preOrderLimit on an active product is ignored", () => {
    const plan = planStockSync({ levels: [active(3, { preOrderLimit: 50 })], variants: [variant({ id: "v1" })], ptProfileIds: profiles })
    expect(plan.levelUpdates[0].stocked_quantity).toBe(3)
    expect(plan.backorderOn).toEqual([])
    expect(plan.preOrders).toEqual([])
  })

  it("going active turns off only a plugin backorder", () => {
    const mine = variant({ id: "v1", allowBackorder: true, backorderMarker: "pre-order" })
    const theirs = variant({ id: "v2", allowBackorder: true })
    const plan = planStockSync({ levels: [active(0)], variants: [mine, theirs], ptProfileIds: profiles, tracked: new Set(["v1"]) })
    expect(plan.backorderOff).toEqual(["v1"])
  })

  it("leaves a store's own backorder alone", () => {
    const own = variant({ id: "v1", allowBackorder: true })
    const plan = planStockSync({ levels: [pre()], variants: [own], ptProfileIds: profiles })
    expect(plan.backorderOn).toEqual([])
    expect(plan.backorderOff).toEqual([])
    expect(plan.backorderReason).toEqual({})
  })

  it("print-on-demand and pre-order: stays on until neither", () => {
    const tracked = new Set(["v1"])
    const v = variant({ id: "v1", allowBackorder: true, backorderMarker: "pre-order" })
    // Pre-order with print-on-demand: on (re-marked as print-on-demand).
    expect(planStockSync({ levels: [pre({ stock: 10000 })], variants: [v], ptProfileIds: profiles, tracked }).backorderOff).toEqual([])
    // Active, still print-on-demand: on.
    const pod = variant({ id: "v1", allowBackorder: true, backorderMarker: "print-on-demand" })
    const still = planStockSync({ levels: [active(10000)], variants: [pod], ptProfileIds: profiles, tracked })
    expect(still.backorderOn).toEqual([])
    expect(still.backorderOff).toEqual([])
    // Neither: off.
    expect(planStockSync({ levels: [active(2)], variants: [pod], ptProfileIds: profiles, tracked }).backorderOff).toEqual(["v1"])
  })

  it("re-marks a tracked variant whose reason changed", () => {
    const tracked = new Set(["v1"])
    const v = variant({ id: "v1", allowBackorder: true, backorderMarker: "pre-order" })
    const plan = planStockSync({ levels: [active(10004)], variants: [v], ptProfileIds: profiles, tracked })
    expect(plan.backorderOn).toEqual(["v1"])
    expect(plan.backorderReason).toEqual({ v1: "print-on-demand" })
    // An untracked one is never claimed.
    expect(planStockSync({ levels: [active(10004)], variants: [v], ptProfileIds: profiles }).backorderOn).toEqual([])
  })

  it("rows without status change nothing", () => {
    const v = variant({ id: "v1" })
    const plan = planStockSync({ levels: [{ sku: "SKU-1", stock: 10003 }], variants: [v], ptProfileIds: profiles })
    expect(plan.preOrders).toBeUndefined()
    expect(plan.backorderOn).toEqual(["v1"])
    expect(plan.backorderReason).toEqual({ v1: "print-on-demand" })
  })
})

describe("preOrderKind", () => {
  it("needs pre-order status and the limit key", () => {
    expect(preOrderKind({ sku: "a", stock: 0, status: "pre-order", preOrderLimit: null })).toBe("unlimited")
    expect(preOrderKind({ sku: "a", stock: 0, status: "pre-order", preOrderLimit: 5, preOrderRemaining: 5 })).toBe("limited")
    expect(preOrderKind({ sku: "a", stock: 0, status: "pre-order" })).toBeNull()
    expect(preOrderKind({ sku: "a", stock: 0, status: "active", preOrderLimit: 5 })).toBeNull()
    expect(preOrderKind({ sku: "a", stock: 0 })).toBeNull()
  })
})

// Print Trail's preOrderRemaining already deducts confirmed pre-orders,
// and Medusa still holds its own reservations for them, so the level written
// adds the level's reservations back (availability = remaining).
describe("a limited pre-order with Medusa reservations", () => {
  it("writes remaining plus the level's reserved quantity", () => {
    const v = variant({
      id: "v1",
      inventory: [{ inventoryItemId: "iitem_v1", requiredQuantity: 1, levels: [{ locationId: "sloc_a", stockedQuantity: 0, reservedQuantity: 10 }] }],
    })
    const row = { sku: "SKU-1", stock: 40, status: "pre-order" as const, publicationDate: null, preOrderLimit: 50, preOrderRemaining: 40 }
    const plan = planStockSync({ levels: [row], variants: [v], ptProfileIds: profiles })
    expect(plan.levelUpdates).toEqual([{ inventory_item_id: "iitem_v1", location_id: "sloc_a", stocked_quantity: 50 }])
    // Already right: nothing written.
    const same = variant({
      id: "v1",
      inventory: [{ inventoryItemId: "iitem_v1", requiredQuantity: 1, levels: [{ locationId: "sloc_a", stockedQuantity: 50, reservedQuantity: 10 }] }],
    })
    expect(planStockSync({ levels: [row], variants: [same], ptProfileIds: profiles }).levelUpdates).toEqual([])
    // Ordinary stock is on-hand with nothing deducted: written as it is.
    const active = { sku: "SKU-1", stock: 40, status: "active" as const, publicationDate: null, preOrderLimit: null, preOrderRemaining: null }
    expect(planStockSync({ levels: [active], variants: [v], ptProfileIds: profiles }).levelUpdates[0].stocked_quantity).toBe(40)
  })
})

// A limited pre-order's figure is what remains, never the
// print-on-demand sentinel.
it("a limited pre-order with 10000 or more remaining isn't print-on-demand", () => {
  const row = { sku: "SKU-1", stock: 12000, status: "pre-order" as const, publicationDate: null, preOrderLimit: 20000, preOrderRemaining: 12000 }
  const plan = planStockSync({ levels: [row], variants: [variant({ id: "v1" })], ptProfileIds: profiles })
  expect(plan.levelUpdates[0].stocked_quantity).toBe(12000)
  expect(plan.backorderOn).toEqual([])
})

// Medusa sums availability over levels, so a limited
// pre-order's allowance goes to one level; the others are left with nothing
// available (stocked = their own reservations).
it("a limited pre-order with several levels puts the allowance on one", () => {
  const v = variant({
    id: "v1",
    inventory: [
      {
        inventoryItemId: "iitem_v1",
        requiredQuantity: 1,
        levels: [
          { locationId: "sloc_b", stockedQuantity: 9, reservedQuantity: 3 },
          { locationId: "sloc_a", stockedQuantity: 9, reservedQuantity: 2 },
        ],
      },
    ],
  })
  const row = { sku: "SKU-1", stock: 40, status: "pre-order" as const, publicationDate: null, preOrderLimit: 50, preOrderRemaining: 40 }
  const byLocation = (updates: { location_id: string; stocked_quantity: number }[]) =>
    Object.fromEntries(updates.map((u) => [u.location_id, u.stocked_quantity]))
  // No stockLocationIds: the first by location id.
  expect(byLocation(planStockSync({ levels: [row], variants: [v], ptProfileIds: profiles }).levelUpdates)).toEqual({ sloc_a: 42, sloc_b: 3 })
  // stockLocationIds: the first configured one.
  expect(byLocation(planStockSync({ levels: [row], variants: [v], ptProfileIds: profiles, stockLocationIds: ["sloc_b", "sloc_a"] }).levelUpdates)).toEqual({ sloc_b: 43, sloc_a: 2 })
})
