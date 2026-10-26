import type { VariantCheckRow } from "../../variant-checks"
import { lastRunView, skuProblems } from "../sku-health"

const row = (variantId: string, over: Partial<VariantCheckRow>): VariantCheckRow => ({
  id: `ptvar_${variantId}`,
  variant_id: variantId,
  product_id: "prod_1",
  check_sku: null,
  check_status: null,
  check_matched_sku: null,
  check_note: null,
  checked_at: null,
  check_source: null,
  ...over,
})

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
    ], new Map())
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

  it("reads each variant's row first, and its legacy check until it has one", () => {
    const at = "2026-10-19T12:00:00.000Z"
    const out = skuProblems(
      [
        variant("a", { sku: "SKU-a", status: "matched", checked_at: "t" }),
        variant("b", { sku: "SKU-b", status: "not-found", checked_at: "t" }),
        variant("c", undefined),
        variant("d", { sku: "SKU-d", status: "not-found", checked_at: "t" }),
        variant("e", undefined),
      ],
      new Map([
        ["a", row("a", { check_sku: "SKU-a", check_status: "not-found", checked_at: at })],
        // Cleared for a re-check: unchecked, whatever the legacy check says.
        ["d", row("d", {})],
        ["e", row("e", { check_sku: "SKU-e", check_status: "inactive", checked_at: at })],
      ])
    )
    expect(out.problems.map((p) => [p.variant_id, p.status, p.sku, p.checked_at])).toEqual([
      ["a", "not-found", "SKU-a", at],
      ["b", "not-found", "SKU-b", "t"],
      ["e", "inactive", "SKU-e", at],
    ])
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
