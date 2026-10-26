// medusa-plugin-print-trail/shipping-options: a store's own code creating
// Print Trail shipping options. validateRateCard checks a rate card against
// the shipping methods printTrailShippingMethods lists;
// printTrailShippingOptionInput turns a valid one into
// createShippingOptionsWorkflow's input.
export { createInput as printTrailShippingOptionInput, validateRateCard } from "./lib/admin/shipping-options"
export { methodsFor as printTrailShippingMethods } from "./lib/admin/shipping-options-routes"
export type { ValidationIssue } from "./lib/admin-types"
export type { RateCard } from "./lib/rate-card"
