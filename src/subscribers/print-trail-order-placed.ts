import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { PRINT_TRAIL_MODULE } from "../modules/printTrail"
import type PrintTrailModuleService from "../modules/printTrail/service"
import { sendOrderToPrintTrailWorkflow } from "../workflows/send-order-to-print-trail"

// A lost event is recovered by the print-trail-sweep job, so failures here
// are logged, not rethrown.
export default async function printTrailOrderPlacedHandler({
  event: { data },
  container,
}: SubscriberArgs<{ id: string }>) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const service = container.resolve<PrintTrailModuleService>(PRINT_TRAIL_MODULE)
  if (!(await service.isConnected())) {
    return
  }
  try {
    await sendOrderToPrintTrailWorkflow(container).run({ input: { order_id: data.id } })
  } catch (e) {
    logger.error(`Print Trail: sending order ${data.id} failed: ${(e as Error).message}`)
  }
}

export const config: SubscriberConfig = {
  event: "order.placed",
}
