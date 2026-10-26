import { toVariantView } from "../variant-view"

describe("variant view", () => {
  it("resolves the override and reports print on demand", () => {
    const v = toVariantView(
      {
        sku: "TEE-1",
        manage_inventory: true,
        allow_backorder: true,
        metadata: {
          print_trail_sku: " PT-1 ",
          print_trail_backorder: true,
          print_trail_sku_check: { sku: "PT-1", status: "matched", checked_at: "t" },
        },
      },
      { inPtProfile: true, available: 3 }
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

  it("treats a string backorder marker as not print on demand", () => {
    const v = toVariantView({ sku: "A", allow_backorder: true, metadata: { print_trail_backorder: "true" } }, { inPtProfile: true, available: 0 })
    expect(v.stock.print_on_demand).toBe(false)
  })

  it("reads a numeric override as its digits", () => {
    const v = toVariantView({ sku: "A", metadata: { print_trail_sku: 9780000000026 } }, { inPtProfile: true, available: 0 })
    expect(v.override).toBe("9780000000026")
  })
})

// API 1.3.0: pre-order products.
describe("pre-order variants", () => {
  const check = (status: string) => ({ print_trail_sku_check: { sku: "A", status, checked_at: "t" } })

  it("pre-order from the stock sync, with its date", () => {
    const v = toVariantView(
      { sku: "A", manage_inventory: true, allow_backorder: true, metadata: { print_trail_backorder: "pre-order", ...check("matched") } },
      { inPtProfile: true, available: 0, preOrder: { publicationDate: "2026-12-01", limit: null, remaining: null } }
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
    const v = toVariantView({ sku: "A", allow_backorder: true, metadata: { print_trail_backorder: "pre-order" } }, { inPtProfile: true, available: 0 })
    expect(v.stock).toMatchObject({ print_on_demand: false, pre_order_backorder: true })
    const pod = toVariantView({ sku: "A", allow_backorder: true, metadata: { print_trail_backorder: true } }, { inPtProfile: true, available: 0 })
    expect(pod.stock).toMatchObject({ print_on_demand: true, pre_order_backorder: false, pre_order: false })
  })
})
