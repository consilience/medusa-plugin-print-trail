import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { StepResponse, type StepExecutionContext } from "@medusajs/framework/workflows-sdk"
import { readTotal } from "./rate-card"

// A handler for calculateShippingOptionsPricesWorkflow's
// setCalculatedShippingPricingContext hook (Medusa 2.20.0 and later), which a
// store registers itself in src/workflows/hooks:
//
//   calculateShippingOptionsPricesWorkflow.hooks.setCalculatedShippingPricingContext(
//     printTrailCalculatedShippingContext
//   )
//
// /store/shipping-options/:id/calculate's context carries no item_total, so a
// rate card's free_over threshold can't apply there and the option shows its
// band price. This adds the cart's item_total (items after discounts, tax
// included), so /calculate compares the same total the cart's option listing
// does. It adds nothing else: the
// provider tells /calculate from the cart's option listing by fields only the
// listing carries. A hook takes one handler, so the plugin never registers
// this one; a store with its own handler can call this and spread the result.
export async function printTrailCalculatedShippingContext(
  { input }: { input: { cart_id: string } },
  { container }: Pick<StepExecutionContext, "container">
): Promise<StepResponse<{ item_total?: number }>> {
  // No cart to read: nothing to add, and no query.
  const cartId = (input as { cart_id?: unknown } | undefined)?.cart_id
  if (typeof cartId !== "string" || !cartId) return new StepResponse({})
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  // item_total in the fields makes the cart module compute the cart's totals.
  const { data } = await query.graph({ entity: "cart", fields: ["id", "item_total"], filters: { id: cartId } })
  const itemTotal = readTotal((data[0] as { item_total?: unknown } | undefined)?.item_total)
  return new StepResponse(itemTotal === null ? {} : { item_total: itemTotal })
}
