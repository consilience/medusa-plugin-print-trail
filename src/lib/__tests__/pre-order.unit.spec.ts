import type { PtFulfilment, PtOrder, PtOrderLine } from "../../modules/printTrail/client/types"
import {
  backOrderKind,
  hasStarted,
  isPreOrderLine,
  isWaitingForRelease,
  markWaitingSkus,
  outOfStockSkus,
  waitingFulfilments,
  memoryPreOrderSeen,
  rememberWaiting,
  wasPreOrder,
} from "../pre-order"

const line = (sku: string, activeState?: string | null) => ({
  quantity: 1,
  lineNumber: `l-${sku}`,
  product: activeState === undefined ? { sku } : { sku, activeState },
})
const f = (over: Partial<PtFulfilment>): PtFulfilment => ({ uuid: "f1", status: "back-order", ...over })

describe("pre-order predicates", () => {
  it.each([
    ["pre-order", "back-order", "pre-order"],
    ["out-of-stock", "back-order", "out-of-stock"],
    ["warehouse", "back-order", "warehouse"],
    [null, "processing", null],
    ["something-new", "back-order", "out-of-stock"],
    // A reason on a fulfilment that isn't back-order counts for nothing.
    ["pre-order", "processing", null],
  ])("backOrderReason decides when present (%s, %s)", (reason, status, kind) => {
    // Lines say pre-order: the key wins over them.
    const x = f({ status, backOrderReason: reason, orderLines: [line("P", "pre-order")] })
    expect(backOrderKind(x)).toBe(kind)
    expect(isWaitingForRelease(x)).toBe(kind === "pre-order")
  })

  it.each([
    ["every line pre-order", [line("P", "pre-order"), line("Q", "pre-order")], "pre-order"],
    ["mixed lines", [line("P", "pre-order"), line("S", "active")], "out-of-stock"],
    ["a line with no activeState", [line("P", "pre-order"), line("S")], "out-of-stock"],
    ["no lines", [], "out-of-stock"],
  ])("the activeState rule is the fallback: %s", (_name, orderLines, kind) => {
    expect(backOrderKind(f({ orderLines }))).toBe(kind)
    expect(backOrderKind(f({ status: "processing", orderLines }))).toBeNull()
  })

  it("isPreOrderLine reads the line product's activeState", () => {
    expect(isPreOrderLine(line("P", "pre-order"))).toBe(true)
    expect(isPreOrderLine(line("P", "active"))).toBe(false)
    expect(isPreOrderLine({ quantity: 1, lineNumber: "x", product: null })).toBe(false)
  })

  it.each([
    ["draft", { status: "draft", sentToWarehouseAt: "2026-10-19T00:00:00Z" }, false],
    ["cancelled", { status: "cancelled", sentToWarehouseAt: "2026-10-19T00:00:00Z" }, false],
    // Processing or dispatched is started whatever sentToWarehouseAt says.
    ["processing with sentToWarehouseAt null", { status: "processing", sentToWarehouseAt: null }, true],
    ["dispatched with sentToWarehouseAt null", { status: "dispatched", sentToWarehouseAt: null }, true],
    ["held draft-like back-order", { status: "back-order", backOrderReason: "pre-order", sentToWarehouseAt: null }, false],
    ["held out-of-stock back-order", { status: "back-order", backOrderReason: "out-of-stock", sentToWarehouseAt: null }, false],
    ["at the warehouse", { status: "processing", sentToWarehouseAt: "2026-10-19T00:00:00Z" }, true],
    ["warehouse back-order", { status: "back-order", backOrderReason: "warehouse", sentToWarehouseAt: "2026-10-19T00:00:00Z" }, true],
    ["no key, pre-order reason", { status: "back-order", backOrderReason: "pre-order" }, false],
    ["no key, out-of-stock reason", { status: "back-order", backOrderReason: "out-of-stock" }, true],
    ["no keys at all (today's rule)", { status: "processing" }, true],
    ["no keys, back-order", { status: "back-order" }, true],
  ] as const)("hasStarted follows sentToWarehouseAt, then the pre-order reason: %s", (_n, over, started) => {
    expect(hasStarted(f(over as Partial<PtFulfilment>))).toBe(started)
  })

  it("lists waiting fulfilments and out-of-stock SKUs", () => {
    const pt: PtOrder = {
      uuid: "o1",
      status: "queued",
      fulfilments: [
        f({ uuid: "a", backOrderReason: "pre-order", orderLines: [line("P")] }),
        f({ uuid: "b", backOrderReason: "out-of-stock", orderLines: [line("Z"), line("Y"), line("Z")] }),
        f({ uuid: "c", status: "processing", backOrderReason: null, orderLines: [line("S")] }),
        f({ uuid: "d", backOrderReason: "warehouse", orderLines: [line("W")] }),
      ],
    }
    expect(waitingFulfilments(pt).map((x) => x.uuid)).toEqual(["a"])
    expect(outOfStockSkus(pt)).toEqual(["Z", "Y"])
    expect(outOfStockSkus({})).toEqual([])
  })
})

// The SKUs ever seen on pre-order, kept add-only, so a stock
// sync between activation and the batched webhook can't hide them.
describe("pre_order_fulfilments", () => {
  const waiting = { uuid: "f-w", status: "back-order", backOrderReason: "pre-order" } as PtFulfilment
  const oos = { uuid: "f-o", status: "back-order", backOrderReason: "out-of-stock" } as PtFulfilment
  const shipped = { uuid: "f-s", status: "dispatched", backOrderReason: null } as PtFulfilment

  it("adds only new waiting fulfilments, keeping what was recorded", () => {
    expect(rememberWaiting(null, { fulfilments: [waiting, oos, shipped] })).toEqual({ pre_order_fulfilments: ["f-w"] })
    expect(rememberWaiting({ pre_order_fulfilments: ["f-w"] }, { fulfilments: [waiting] })).toEqual({})
    expect(rememberWaiting({ pre_order_fulfilments: ["f-old"] }, { fulfilments: [waiting, waiting] })).toEqual({ pre_order_fulfilments: ["f-old", "f-w"] })
    // A released (dispatched) fulfilment is never dropped.
    expect(rememberWaiting({ pre_order_fulfilments: ["f-s"] }, { fulfilments: [shipped] })).toEqual({})
    expect(rememberWaiting({ pre_order_fulfilments: "junk" }, { fulfilments: [] })).toEqual({})
  })

  // A row from before the column has no record; its stored
  // snapshot backfills it, so a parcel released and dispatched before any
  // sync saw it waiting keeps the pre-order wording.
  it("backfills from the row's stored snapshot", () => {
    const row = { pre_order_fulfilments: null, fulfilments: [waiting, oos] }
    expect(rememberWaiting(row, { fulfilments: [{ ...waiting, status: "dispatched", backOrderReason: null } as PtFulfilment] })).toEqual({
      pre_order_fulfilments: ["f-w"],
    })
    expect(rememberWaiting({ pre_order_fulfilments: ["f-w"], fulfilments: [waiting] }, { fulfilments: [] })).toEqual({})
    expect(rememberWaiting({ fulfilments: [null, "junk"] }, { fulfilments: [] })).toEqual({})
  })

  // A fulfilment held by an inactive product gets the pre-order reason.
  it("skips a fulfilment that waits only on an inactive product", () => {
    const line = (activeState: string) => ({ product: { sku: "S", activeState } }) as unknown as PtOrderLine
    const inactive = { ...waiting, uuid: "f-i", orderLines: [line("inactive"), line("active")] } as PtFulfilment
    const mixed = { ...waiting, uuid: "f-m", orderLines: [line("inactive"), line("pre-order")] } as PtFulfilment
    expect(rememberWaiting(null, { fulfilments: [inactive, mixed] })).toEqual({ pre_order_fulfilments: ["f-m"] })
    expect(rememberWaiting({ fulfilments: [inactive] }, { fulfilments: [] })).toEqual({})
    // A genuine pre-order recorded earlier is kept once its product goes inactive.
    expect(rememberWaiting({ pre_order_fulfilments: ["f-i"] }, { fulfilments: [inactive] })).toEqual({})
  })

  it("wasPreOrder reads the record", () => {
    expect(wasPreOrder({ pre_order_fulfilments: ["f-s"] }, "f-s")).toBe(true)
    expect(wasPreOrder({ pre_order_fulfilments: ["f-s"] }, "f-x")).toBe(false)
    expect(wasPreOrder(null, "f-s")).toBe(false)
    expect(wasPreOrder({ pre_order_fulfilments: [1, null] }, "1")).toBe(false)
  })
})

describe("memoryPreOrderSeen", () => {
  it("is add-only and case-insensitive", async () => {
    const seen = memoryPreOrderSeen()
    await seen.markPreOrderSeen(["PRE-1", ""])
    await seen.markPreOrderSeen(["pre-1", "PRE-2"])
    expect(await seen.preOrderSeen(["pre-1", "PRE-2", "978-A"])).toEqual(["pre-1", "PRE-2"])
  })
})

// An out-of-stock back-order can switch to pre-order with no order webhook, so
// its SKUs are recorded too (seen held at Print Trail), not only those waiting
// for release.
describe("markWaitingSkus", () => {
  it("records the SKUs of every back-order Print Trail holds, not one at the warehouse", async () => {
    const seen = memoryPreOrderSeen()
    await markWaitingSkus(seen, {
      fulfilments: [
        f({ backOrderReason: "pre-order", orderLines: [line("PRE-1")] }),
        f({ backOrderReason: "out-of-stock", orderLines: [line("OOS-1")] }),
        f({ backOrderReason: "warehouse", orderLines: [line("WH-1")] }),
        f({ status: "processing", backOrderReason: null, orderLines: [line("978-A")] }),
      ],
    })
    expect([...seen.keys].sort()).toEqual(["oos-1", "pre-1"])
  })
})
