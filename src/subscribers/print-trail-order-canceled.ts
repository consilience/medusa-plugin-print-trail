import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { PRINT_TRAIL_MODULE } from "../modules/printTrail"
import type PrintTrailModuleService from "../modules/printTrail/service"
import { cancelPrintTrailOrderWorkflow } from "../workflows/cancel-print-trail-order"

// A subscriber, not cancelOrderWorkflow's orderCanceled hook: a hook handler
// runs inside Medusa's cancel, and a throw there would roll it back. A lock
// timeout keeps the stored intent for the sweep.
export default async function printTrailOrderCanceledHandler({
  event: { data },
  container,
}: SubscriberArgs<{ id: string }>) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const service = container.resolve<PrintTrailModuleService>(PRINT_TRAIL_MODULE)
  if (!(await service.isConnected())) {
    return
  }
  try {
    await cancelPrintTrailOrderWorkflow(container).run({ input: { order_id: data.id, cause: "order-canceled" } })
  } catch (e) {
    logger.error(`Print Trail: cancelling order ${data.id} failed: ${(e as Error).message}`)
  }
}

export const config: SubscriberConfig = {
  event: "order.canceled",
}
