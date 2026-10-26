import { toCheckVariants } from "../steps/sku-check-context"

describe("toCheckVariants", () => {
  it("resolves the override, keeps metadata and leaves unlinked products without a profile", () => {
    const metadata = { print_trail_sku: "PT-1", print_trail_sku_check: { sku: "PT-1", status: "matched", checked_at: "x" }, other: 1 }
    const out = toCheckVariants(
      [
        { id: "variant_1", sku: "plain", metadata, product_id: "prod_1" },
        { id: "variant_2", sku: " raw ", metadata: null, product_id: "prod_2" },
        null,
      ],
      new Map([["prod_1", "sp_pt"]])
    )
    expect(out).toEqual([
      { id: "variant_1", sku: "PT-1", metadata, profileId: "sp_pt" },
      { id: "variant_2", sku: "raw", metadata: null, profileId: null },
    ])
    expect(out[0].metadata).toBe(metadata)
  })
})
