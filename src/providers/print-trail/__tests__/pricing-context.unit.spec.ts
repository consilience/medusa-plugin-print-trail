import { isCartOptionListing } from "../pricing-context"

// What 2.17.2 passes: /store/shipping-options/:id/calculate spreads the cart
// read with cartFieldsForCalculateShippingOptionsPrices; the cart's option
// listing (adding a method, the cart refresh) adds sales_channel_id,
// currency_code, region_id, item_total and total.
const calculateRoute = {
  id: "cart_1",
  locale: null,
  items: [],
  shipping_address: { country_code: "fr" },
  from_location: { id: "sloc_1" },
}
const listing = { ...calculateRoute, sales_channel_id: "sc_1", currency_code: "gbp", region_id: "reg_1", item_total: 40, total: 40 }

describe("isCartOptionListing", () => {
  it("recognises the cart's option listing", () => {
    expect(isCartOptionListing(listing)).toBe(true)
    // Totals arrive as BigNumber-like objects as well as numbers, and 0 counts.
    expect(isCartOptionListing({ ...listing, item_total: { numeric: 0 }, total: 0 })).toBe(true)
  })

  it("never mistakes the calculate route for it", () => {
    expect(isCartOptionListing(calculateRoute)).toBe(false)
  })

  it("stays conservative when only some of the listing's fields are there", () => {
    // A store adding pricing context to /calculate (a later Medusa's
    // setCalculatedShippingPricingContext hook, say) adds a currency or a
    // region, not the cart's totals.
    expect(isCartOptionListing({ ...calculateRoute, currency_code: "gbp", region_id: "reg_1" })).toBe(false)
    expect(isCartOptionListing({ ...calculateRoute, currency_code: "gbp", region_id: "reg_1", sales_channel_id: "sc_1" })).toBe(false)
    for (const key of ["sales_channel_id", "currency_code", "region_id", "item_total", "total"]) {
      expect(isCartOptionListing({ ...listing, [key]: undefined })).toBe(false)
      expect(isCartOptionListing({ ...listing, [key]: null })).toBe(false)
    }
    // An order's own options (fetchShippingOptionForOrderWorkflow) throw as before.
    expect(isCartOptionListing({ id: "order_1", shipping_address: {}, items: [] })).toBe(false)
    expect(isCartOptionListing(undefined)).toBe(false)
  })
})
