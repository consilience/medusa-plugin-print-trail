import { variantOverridePayload } from "../variant-form"

describe("variant SKU override payload", () => {
  // Medusa before 2.19 replaces a variant's metadata on update, so the whole
  // object is sent: the SKU check and the backorder marker must survive.
  const current = {
    print_trail_sku: "OLD",
    print_trail_sku_check: { sku: "OLD", status: "matched", checked_at: "t" },
    print_trail_backorder: true,
    merchant_note: "keep me",
  }

  it("keeps every other metadata key", () => {
    expect(variantOverridePayload(current, " PT-1 ")).toEqual({
      metadata: { ...current, print_trail_sku: "PT-1" },
    })
  })

  // From 2.19 Medusa merges the update, so a key left out would be kept: ""
  // deletes it (before 2.19 it stays as "", which reads as no override).
  it("removes the override for an empty value by sending it as an empty string", () => {
    expect(variantOverridePayload(current, "  ")).toEqual({ metadata: { ...current, print_trail_sku: "" } })
    expect(variantOverridePayload(null, "")).toEqual({ metadata: {} })
    expect(variantOverridePayload({ merchant_note: "keep me" }, "")).toEqual({ metadata: { merchant_note: "keep me" } })
  })

  it("never changes the metadata it was given", () => {
    const copy = JSON.parse(JSON.stringify(current))
    variantOverridePayload(current, "NEW")
    expect(current).toEqual(copy)
  })
})
