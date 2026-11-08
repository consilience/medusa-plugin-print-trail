// A store's own code using each public entry point of the installed package.
// scripts/install-test.sh type-checks it under strict settings; it is never
// run. Each @ts-expect-error fails the check if the type it tests has become
// `any`.
import type { MedusaContainer } from "@medusajs/framework/types"
import { StepResponse } from "@medusajs/framework/workflows-sdk"
import { createShippingOptionsWorkflow } from "@medusajs/medusa/core-flows"
import { printTrailOptionsFromEnv, type PrintTrailCredentials } from "medusa-plugin-print-trail/config"
import printTrailModule, { PRINT_TRAIL_MODULE } from "medusa-plugin-print-trail/modules/printTrail"
import printTrailProvider from "medusa-plugin-print-trail/providers/print-trail"
import {
  printTrailCalculatedShippingContext,
  printTrailShippingMethods,
  printTrailShippingOptionInput,
  validateRateCard,
  type RateCard,
  type ValidationIssue,
} from "medusa-plugin-print-trail/shipping-options"
import {
  describeStockResult,
  requestStockSync,
  type StockRequestResult,
  type StockSyncInput,
  type StockSyncResult,
  type StockTrigger,
} from "medusa-plugin-print-trail/stock"
import { requestPrintTrailStockSyncWorkflow, sendOrderToPrintTrailWorkflow } from "medusa-plugin-print-trail/workflows"

// medusa-config.ts
const credentials: PrintTrailCredentials = printTrailOptionsFromEnv(process.env)
export const pluginOptions = { ...credentials, orderNumberPrefix: "SHOP-" }
export const providerServices: unknown[] = printTrailProvider.services

// A module link, through the module's linkable.
export const moduleName: "printTrail" = PRINT_TRAIL_MODULE
export const orderLink: "print_trail_order_id" = printTrailModule.linkable.printTrailOrder.id.linkable

// A store's own job running the stock sync.
export async function nightlyStock(container: MedusaContainer): Promise<string> {
  const trigger: StockTrigger = "schedule"
  const input: StockSyncInput = { trigger, skus: ["9780000000002"] }
  const result: StockRequestResult = await requestStockSync(container, input)
  if (result.status === "failed") return result.error
  if (result.status === "completed") {
    const completed: StockSyncResult = result
    return describeStockResult(completed)
  }
  return describeStockResult(result)
}

export async function unknownTrigger(container: MedusaContainer): Promise<void> {
  // @ts-expect-error a trigger the stock sync doesn't take
  await requestStockSync(container, { trigger: "nightly" })
}

// A store's own route creating a Print Trail shipping option.
export async function createOption(container: MedusaContainer, rateCard: unknown): Promise<ValidationIssue[]> {
  const { codes } = await printTrailShippingMethods(container)
  const checked = validateRateCard(rateCard, codes)
  // @ts-expect-error the card is there only once the result is ok
  void checked.card
  if (!checked.ok) return checked.issues
  const card: RateCard = checked.card
  const option = printTrailShippingOptionInput(
    { name: "Standard", service_zone_id: "serzo_1", shipping_profile_id: "sp_1" },
    card
  )
  await createShippingOptionsWorkflow(container).run({ input: [option] })
  return []
}

// The admin's Sync stock now, from a store's own code.
export async function syncNow(container: MedusaContainer): Promise<string> {
  const { result } = await requestPrintTrailStockSyncWorkflow(container).run({ input: {} })
  return result.status
}

// A workflow hook, registered as a store would.
sendOrderToPrintTrailWorkflow.hooks.payload(async ({ order, payload }) =>
  new StepResponse({ payload: { ...payload, purchaseOrder: String(order.metadata?.po_number ?? "") || undefined } })
)

// A store's own setCalculatedShippingPricingContext handler (Medusa 2.20.0+)
// composing the plugin's. Typed here rather than from the hook, which 2.17.2
// doesn't have.
type PricingContextHandler = (
  input: { input: { cart_id: string; shipping_options: { id: string }[] } },
  context: { container: MedusaContainer }
) => Promise<StepResponse<Record<string, unknown> | undefined>>
export const pricingContext: PricingContextHandler = async (args, context) => {
  const ours = await printTrailCalculatedShippingContext(args, context)
  const itemTotal: number | undefined = ours.output.item_total
  return new StepResponse({ item_total: itemTotal, customer_group: "trade" })
}
export const registered: PricingContextHandler = printTrailCalculatedShippingContext

export async function noCart(container: MedusaContainer): Promise<void> {
  // @ts-expect-error the hook's input carries the cart id
  await printTrailCalculatedShippingContext({ input: {} }, { container })
}
