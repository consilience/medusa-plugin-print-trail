import { toCheckVariants } from "../steps/sku-check-context"
import type { VariantCheckRow } from "../../lib/variant-checks"

describe("toCheckVariants", () => {
  it("resolves the override, keeps metadata and leaves unlinked products without a profile", () => {
    const metadata = { print_trail_sku: "PT-1", print_trail_sku_check: { sku: "PT-1", status: "matched", checked_at: "x" }, other: 1 }
    const out = toCheckVariants(
      [
        { id: "variant_1", sku: "plain", metadata, product_id: "prod_1" },
        { id: "variant_2", sku: " raw ", metadata: null, product_id: "prod_2" },
        null,
      ],
      new Map([["prod_1", "sp_pt"]]),
      new Map()
    )
    expect(out).toEqual([
      {
        id: "variant_1",
        sku: "PT-1",
        metadata,
        profileId: "sp_pt",
        productId: "prod_1",
        // No row yet: the legacy check in metadata.
        check: { sku: "PT-1", status: "matched", checked_at: "x" },
        hasRow: false,
      },
      { id: "variant_2", sku: "raw", metadata: null, profileId: null, productId: "prod_2", check: null, hasRow: false },
    ])
    expect(out[0].metadata).toBe(metadata)
  })

  it("reads the variant's row before its legacy check", () => {
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
    const metadata = { print_trail_sku_check: { sku: "OLD", status: "not-found", checked_at: "x" } }
    const graph = [{ id: "variant_1", sku: "NEW", metadata, product_id: "prod_1" }]
    const profiles = new Map([["prod_1", "sp_pt"]])
    const at = "2026-10-19T12:00:00.000Z"
    expect(
      toCheckVariants(graph, profiles, new Map([["variant_1", row({ check_sku: "NEW", check_status: "matched", checked_at: at })]]))[0]
    ).toMatchObject({ check: { sku: "NEW", status: "matched", checked_at: at }, hasRow: true })
    // A cleared row: no check, even with a legacy one.
    expect(toCheckVariants(graph, profiles, new Map([["variant_1", row({})]]))[0]).toMatchObject({ check: null, hasRow: true })
  })
})
