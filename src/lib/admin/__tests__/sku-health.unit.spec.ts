import { lastRunView, skuProblems } from "../sku-health"

const variant = (id: string, check: unknown, over: Record<string, unknown> = {}) => ({
  id,
  product_id: "prod_1",
  title: `V ${id}`,
  sku: `SKU-${id}`,
  metadata: check === undefined ? {} : { print_trail_sku_check: check },
  product: { title: "Tee" },
  ...over,
})

describe("SKU health", () => {
  it("lists SKU problems and only counts unchecked variants", () => {
    const out = skuProblems([
      variant("a", { sku: "SKU-a", status: "matched", checked_at: "t" }),
      variant("b", { sku: "SKU-b", status: "not-found", checked_at: "t1" }),
      variant("c", { sku: "SKU-c", status: "inactive", checked_at: "t2" }),
      variant("d", undefined),
      variant("e", { sku: null, status: "no-sku", checked_at: "t3" }, { sku: null }),
      variant("f", { sku: "SKU-f", status: "error", checked_at: "t4" }, { metadata: { print_trail_sku: "PT-F", print_trail_sku_check: { sku: "PT-F", status: "error", checked_at: "t4" } } }),
      variant("g", { sku: "SKU-g", status: "pre-order", checked_at: "t5" }),
      variant("h", "junk"),
    ])
    expect(out.problems.map((p) => [p.variant_id, p.status, p.sku])).toEqual([
      ["b", "not-found", "SKU-b"],
      ["c", "inactive", "SKU-c"],
      ["e", "no-sku", null],
      ["f", "error", "PT-F"],
    ])
    expect(out.problems[0]).toEqual({
      variant_id: "b",
      product_id: "prod_1",
      product_title: "Tee",
      variant_title: "V b",
      sku: "SKU-b",
      status: "not-found",
      checked_at: "t1",
    })
    expect(out.unchecked).toBe(2)
  })

  it("maps the last stock run with its warnings", () => {
    expect(lastRunView(null)).toBeNull()
    expect(
      lastRunView({
        trigger: "schedule",
        startedAt: "s",
        completedAt: "c",
        levelsUpdated: 4,
        backorderOn: 1,
        backorderOff: 0,
        matched: 3,
        unmatched: 1,
        skipped: [{ variantId: "v1", reason: "duplicate-sku" }],
        warnings: [{ type: "multi-location", skus: ["A"] }],
      })
    ).toEqual({
      trigger: "schedule",
      completedAt: "c",
      levelsUpdated: 4,
      skipped: [{ variantId: "v1", reason: "duplicate-sku" }],
      warnings: [{ type: "multi-location", skus: ["A"] }],
      error: null,
    })
    expect(lastRunView({ trigger: "webhook", startedAt: "s", completedAt: "c", levelsUpdated: 0, backorderOn: 0, backorderOff: 0, matched: 0, unmatched: 0, skipped: [], error: "no rows" })?.error).toBe("no rows")
  })
})
