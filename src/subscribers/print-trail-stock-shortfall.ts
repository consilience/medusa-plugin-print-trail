import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { STOCK_HELD_EVENT } from "../lib/amend-flow"
import { shortfallSkus } from "../lib/stock"
import { describeStockResult, requestStockSync } from "../lib/stock-request"
import { PRINT_TRAIL_MODULE } from "../modules/printTrail"
import type PrintTrailModuleService from "../modules/printTrail/service"

type OrderEventData = {
  order_id: string
  print_trail_order_id: string
  reason?: string
  // print_trail.order.attention after a confirm Print Trail accepted with an
  // out-of-stock back-order (API 1.3.0).
  back_order_skus?: string[]
  // print_trail.order.stock_held: an edit Print Trail refused for stock.
  skus?: string[]
}

// Confirm was refused for stock, or accepted with an out-of-stock back-order,
// or an edit was refused for stock (409 stock-held, as for a pre-order
// limit): refresh Medusa's stock for those SKUs, so the store stops selling
// what Print Trail hasn't got.
export default async function printTrailStockShortfallHandler({ event, container }: SubscriberArgs<OrderEventData>) {
  const heldSkus = event.name === STOCK_HELD_EVENT && Array.isArray(event.data?.skus) ? event.data.skus : []
  const backOrderSkus = heldSkus.length ? heldSkus : Array.isArray(event.data?.back_order_skus) ? event.data.back_order_skus : []
  if (event.data?.reason !== "stock-shortfall" && !backOrderSkus.length) {
    return
  }
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  try {
    let skus = backOrderSkus
    if (!skus.length) {
      const service = container.resolve<PrintTrailModuleService>(PRINT_TRAIL_MODULE)
      const [row] = await service.listPrintTrailOrders({ id: event.data.print_trail_order_id })
      skus = shortfallSkus(row?.shortfall)
    }
    if (!skus.length) {
      return
    }
    const result = await requestStockSync(container, { trigger: "shortfall", skus })
    const why = heldSkus.length ? "a refused edit" : backOrderSkus.length ? "a back-order" : "a shortfall"
    logger.info(`Print Trail stock refresh after ${why} on order ${event.data.order_id} (${skus.join(", ")}): ${describeStockResult(result)}`)
  } catch (e) {
    logger.error(`Print Trail stock refresh for order ${event.data.order_id} failed: ${(e as Error)?.message ?? e}`)
  }
}

export const config: SubscriberConfig = {
  event: ["print_trail.order.blocked", "print_trail.order.attention", STOCK_HELD_EVENT],
}
