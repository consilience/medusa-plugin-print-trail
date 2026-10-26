import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { PRINT_TRAIL_MODULE } from "../modules/printTrail"
import type PrintTrailModuleService from "../modules/printTrail/service"
import { recordPrintTrailOrderChangeWorkflow } from "../workflows/record-print-trail-order-change"

// Returns are timeline entries only: they never change items.detail.quantity.
export default async function printTrailReturnRequestedHandler({
  event: { data },
  container,
}: SubscriberArgs<{ order_id: string; return_id: string }>) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const service = container.resolve<PrintTrailModuleService>(PRINT_TRAIL_MODULE)
  if (!(await service.isConnected())) return
  if (!(await service.listPrintTrailOrders({ order_id: data.order_id }, { select: ["id"] })).length) return
  try {
    await recordPrintTrailOrderChangeWorkflow(container).run({
      input: { order_id: data.order_id, change: { kind: "return", return_id: data.return_id } },
    })
  } catch (e) {
    logger.error(`Print Trail: recording return ${data.return_id} of order ${data.order_id} failed: ${(e as Error).message}`)
  }
}

export const config: SubscriberConfig = {
  event: "order.return_requested",
}
