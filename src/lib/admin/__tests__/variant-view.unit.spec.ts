import type { VariantCheckRow } from "../../variant-checks"
import { toVariantView } from "../variant-view"

const row = (over: Partial<VariantCheckRow>): VariantCheckRow => ({
  id: "ptvar_1",
  variant_id: "variant_1",
  product_id: "prod_1",
  check_sku: null,
  check_status: null,
  check_matched_sku: null,
  check_note: null,
  checked_at: null,
  check_source: null,
  ...over,
})

describe("variant view", () => {
  it("resolves the override and reports print on demand", () => {
    const v = toVariantView(
      {
        id: "variant_1",
        sku: "TEE-1",
        manage_inventory: true,
        allow_backorder: true,
        metadata: {
          print_trail_sku: " PT-1 ",
          print_trail_sku_check: { sku: "PT-1", status: "matched", checked_at: "t" },
        },
      },
      { inPtProfile: true, available: 3, backordered: { ids: ["variant_1"], reasons: { variant_1: "print-on-demand" } } }
    )
    expect(v).toEqual({
      in_print_trail_profile: true,
      sku: "TEE-1",
      override: "PT-1",
      resolved_sku: "PT-1",
      check: { sku: "PT-1", status: "matched", checked_at: "t" },
      check_current: true,
      stock: {
        manage_inventory: true,
        allow_backorder: true,
        available: 3,
        print_on_demand: true,
        pre_order: false,
        pre_order_backorder: false,
        pre_order_limit: null,
        pre_order_remaining: null,
        publication_date: null,
      },
    })
    const stale = toVariantView(
      { sku: "TEE-1", metadata: { print_trail_sku_check: { sku: "OLD", status: "matched", checked_at: "t" } } },
      { inPtProfile: false, available: null }
    )
    expect(stale).toMatchObject({ override: null, resolved_sku: "TEE-1", check_current: false, in_print_trail_profile: false })
    expect(stale.stock).toMatchObject({ manage_inventory: false, allow_backorder: false, available: null, print_on_demand: false, pre_order: false })
    expect(toVariantView({ sku: null, metadata: null }, { inPtProfile: true, available: null })).toMatchObject({ check: null, check_current: false, resolved_sku: null })
  })

  it("reads the variant's row first, and its legacy check until it has one", () => {
    const at = "2026-10-19T12:00:00.000Z"
    const metadata = { print_trail_sku_check: { sku: "A", status: "not-found", checked_at: "t" } }
    const fromRow = toVariantView(
      { sku: "A", metadata },
      { inPtProfile: true, available: null, row: row({ check_sku: "A", check_status: "matched", checked_at: at }) }
    )
    expect(fromRow).toMatchObject({ check: { sku: "A", status: "matched", checked_at: at }, check_current: true })
    expect(toVariantView({ sku: "A", metadata }, { inPtProfile: true, available: null, row: null })).toMatchObject({
      check: { sku: "A", status: "not-found", checked_at: "t" },
      check_current: true,
    })
    // Cleared for a re-check: no check, though the legacy one is still there.
    expect(toVariantView({ sku: "A", metadata }, { inPtProfile: true, available: null, row: row({}) })).toMatchObject({
      check: null,
      check_current: false,
    })
  })

  it("reads a numeric override as its digits", () => {
    const v = toVariantView({ sku: "A", metadata: { print_trail_sku: 9780000000026 } }, { inPtProfile: true, available: 0 })
    expect(v.override).toBe("9780000000026")
  })
})

// Why the plugin's backorder is on comes from stock_backordered, not the
// variant's metadata.
describe("the backorder reason", () => {
  const view = (metadata: Record<string, unknown> | null, backordered?: { ids: string[]; reasons?: Record<string, "print-on-demand" | "pre-order"> } | null) =>
    toVariantView({ id: "variant_1", sku: "A", allow_backorder: true, metadata }, { inPtProfile: true, available: 0, backordered }).stock

  it("tracked with a reason", () => {
    // The record's reason wins over a legacy marker that says otherwise.
    expect(view({ print_trail_backorder: true }, { ids: ["variant_1"], reasons: { variant_1: "pre-order" } })).toMatchObject({
      print_on_demand: false,
      pre_order_backorder: true,
    })
    expect(view(null, { ids: ["variant_1"], reasons: { variant_1: "print-on-demand" } })).toMatchObject({
      print_on_demand: true,
      pre_order_backorder: false,
    })
  })

  it("tracked without one: the legacy marker, then print on demand", () => {
    // A 0.2.0 record has no reasons.
    expect(view({ print_trail_backorder: "pre-order" }, { ids: ["variant_1"] })).toMatchObject({ print_on_demand: false, pre_order_backorder: true })
    expect(view({ print_trail_backorder: true }, { ids: ["variant_1"], reasons: {} })).toMatchObject({ print_on_demand: true, pre_order_backorder: false })
    // No marker, or one that isn't the plugin's: what a tracked id meant before pre-orders.
    expect(view(null, { ids: ["variant_1"] })).toMatchObject({ print_on_demand: true, pre_order_backorder: false })
    expect(view({ print_trail_backorder: "true" }, { ids: ["variant_1"] })).toMatchObject({ print_on_demand: true, pre_order_backorder: false })
  })

  it("untracked with a stale marker shows nothing", () => {
    for (const marker of [true, "pre-order"]) {
      expect(view({ print_trail_backorder: marker }, { ids: ["variant_2"], reasons: { variant_2: "print-on-demand" } })).toMatchObject({
        print_on_demand: false,
        pre_order_backorder: false,
      })
      expect(view({ print_trail_backorder: marker }, null)).toMatchObject({ print_on_demand: false, pre_order_backorder: false })
    }
    // A variant without an id is never tracked.
    expect(
      toVariantView({ sku: "A", metadata: { print_trail_backorder: true } }, { inPtProfile: true, available: 0, backordered: { ids: [""] } }).stock
        .print_on_demand
    ).toBe(false)
  })
})

// API 1.3.0: pre-order products.
describe("pre-order variants", () => {
  const check = (status: string) => ({ print_trail_sku_check: { sku: "A", status, checked_at: "t" } })

  it("pre-order from the stock sync, with its date", () => {
    const v = toVariantView(
      { id: "variant_1", sku: "A", manage_inventory: true, allow_backorder: true, metadata: check("matched") },
      {
        inPtProfile: true,
        available: 0,
        preOrder: { publicationDate: "2026-12-01", limit: null, remaining: null },
        backordered: { ids: ["variant_1"], reasons: { variant_1: "pre-order" } },
      }
    )
    expect(v.stock).toEqual({
      manage_inventory: true,
      allow_backorder: true,
      available: 0,
      print_on_demand: false,
      pre_order: true,
      pre_order_backorder: true,
      pre_order_limit: null,
      pre_order_remaining: null,
      publication_date: "2026-12-01",
    })
    const limited = toVariantView({ sku: "A", manage_inventory: true }, { inPtProfile: true, available: 40, preOrder: { publicationDate: null, limit: 50, remaining: 40 } })
    expect(limited.stock).toMatchObject({ pre_order: true, pre_order_backorder: false, pre_order_limit: 50, pre_order_remaining: 40 })
  })

  it("pre-order from the SKU check when the stock sync has no status", () => {
    const v = toVariantView({ sku: "A", metadata: check("pre-order") }, { inPtProfile: true, available: 0 })
    expect(v.stock).toMatchObject({ pre_order: true, pre_order_backorder: false, publication_date: null })
    // The stock sync has a record and the SKU isn't in it: not pre-order.
    const live = toVariantView({ sku: "A", metadata: check("pre-order") }, { inPtProfile: true, available: 0, preOrder: null })
    expect(live.stock.pre_order).toBe(false)
  })

  it("a pre-order backorder isn't print on demand", () => {
    const at = (reason: "print-on-demand" | "pre-order") =>
      toVariantView(
        { id: "variant_1", sku: "A", allow_backorder: true, metadata: null },
        { inPtProfile: true, available: 0, backordered: { ids: ["variant_1"], reasons: { variant_1: reason } } }
      ).stock
    expect(at("pre-order")).toMatchObject({ print_on_demand: false, pre_order_backorder: true })
    expect(at("print-on-demand")).toMatchObject({ print_on_demand: true, pre_order_backorder: false, pre_order: false })
  })
})
