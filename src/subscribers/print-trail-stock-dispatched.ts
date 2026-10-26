import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { dispatchedSkus } from "../lib/stock"
import { describeStockResult, requestStockSync } from "../lib/stock-request"
import { PRINT_TRAIL_MODULE } from "../modules/printTrail"
import type PrintTrailModuleService from "../modules/printTrail/service"

type DispatchedEventData = { order_id: string; print_trail_order_id: string; pt_fulfilment_uuid: string; fulfillment_id: string }

// A Medusa fulfilment was just created for a dispatched Print Trail parcel,
// which took its units off Medusa's stock. Re-read Print Trail's on-hand
// figure for those SKUs, so a stock sync that read Print Trail before the
// dispatch can't leave Medusa overstated.
export default async function printTrailStockDispatchedHandler({ event, container }: SubscriberArgs<DispatchedEventData>) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  try {
    const service = container.resolve<PrintTrailModuleService>(PRINT_TRAIL_MODULE)
    const [row] = await service.listPrintTrailOrders({ id: event.data.print_trail_order_id })
    const skus = row ? dispatchedSkus(row, event.data.pt_fulfilment_uuid) : []
    if (!skus.length) return
    const result = await requestStockSync(container, { trigger: "dispatch", skus })
    logger.debug(`Print Trail stock refresh after dispatch on order ${event.data.order_id}: ${describeStockResult(result)}`)
  } catch (e) {
    logger.error(`Print Trail stock refresh after dispatch on order ${event.data?.order_id} failed: ${(e as Error)?.message ?? e}`)
  }
}

export const config: SubscriberConfig = {
  event: "print_trail.order.dispatched",
}
