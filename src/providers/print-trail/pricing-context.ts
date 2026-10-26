// Which Medusa path is asking calculatePrice for a price, told from its
// context (@medusajs/core-flows, 2.17.2 to 2.22.1):
//
// - /store/shipping-options/:id/calculate runs
//   calculateShippingOptionsPricesWorkflow
//   (fulfillment/workflows/calculate-shipping-options-prices.js), whose
//   context is the cart read with cartFieldsForCalculateShippingOptionsPrices
//   (cart/utils/fields.js: id, locale, items, shipping_address; from 2.19.0
//   also currency_code and region_id) plus from_location.
// - From 2.20.0 a draft order's calculated option
//   (fetchShippingOptionForDraftOrderWorkflow) has id, shipping_address,
//   items and from_location, so it is priced like /calculate.
// - Adding a shipping method (add-shipping-method-to-cart.js) and the cart
//   refresh after a cart change (refresh-cart-shipping-methods.js, run by
//   updateCartWorkflow and addToCartWorkflow) both run
//   listShippingOptionsForCartWithPricingWorkflow
//   (cart/workflows/list-shipping-options-for-cart-with-pricing.js), whose
//   cartFields add sales_channel_id, currency_code, region_id, item_total
//   and total.
//
// The two outcomes it chooses between (service.ts, over the last band):
// /calculate throws, so a storefront never shows the option, while the
// listing gets no price, so Medusa refuses the add ("do not have a price")
// and the refresh drops a chosen method instead of failing the cart update.
// Mistaking /calculate for the listing would answer it with no amount, which
// a storefront might show as free; so every one of the listing's fields must
// be there. A store adding pricing context to /calculate (the
// setCalculatedShippingPricingContext hook from 2.20.0, say) adds a currency
// or a region, not the cart's totals. The HTTP harness (rates.spec.ts) pins
// both paths, so a Medusa upgrade that changes either context fails CI.
const LISTING_ONLY_FIELDS = ["sales_channel_id", "currency_code", "region_id", "item_total", "total"] as const

export function isCartOptionListing(context: Record<string, unknown> | null | undefined): boolean {
  return !!context && LISTING_ONLY_FIELDS.every((field) => context[field] !== undefined && context[field] !== null)
}
