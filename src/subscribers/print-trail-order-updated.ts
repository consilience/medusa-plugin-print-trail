import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { PRINT_TRAIL_MODULE } from "../modules/printTrail"
import type PrintTrailModuleService from "../modules/printTrail/service"
import { recordPrintTrailOrderChangeWorkflow } from "../workflows/record-print-trail-order-change"
import { runPrintTrailFollowUps } from "../workflows/run-follow-ups"

// updateOrderWorkflow emits { id } with no diff (address, email, metadata,
// locale): the address fingerprint decides whether anything changed.
export default async function printTrailOrderUpdatedHandler({ event: { data }, container }: SubscriberArgs<{ id: string }>) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const service = container.resolve<PrintTrailModuleService>(PRINT_TRAIL_MODULE)
  if (!(await service.isConnected())) return
  if (!(await service.listPrintTrailOrders({ order_id: data.id }, { select: ["id"] })).length) return
  try {
    const { result } = await recordPrintTrailOrderChangeWorkflow(container).run({
      input: { order_id: data.id, change: { kind: "address" } },
    })
    await runPrintTrailFollowUps(container, data.id, result.resend)
  } catch (e) {
    logger.error(`Print Trail: recording the update of order ${data.id} failed: ${(e as Error).message}`)
  }
}

export const config: SubscriberConfig = {
  event: "order.updated",
}
