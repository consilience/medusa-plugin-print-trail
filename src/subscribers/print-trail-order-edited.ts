import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { PRINT_TRAIL_MODULE } from "../modules/printTrail"
import type PrintTrailModuleService from "../modules/printTrail/service"
import { amendPrintTrailOrderWorkflow } from "../workflows/amend-print-trail-order"
import { runPrintTrailFollowUps } from "../workflows/run-follow-ups"

// A confirmed order edit (confirmOrderEditRequestWorkflow emits
// { order_id, actions }). The actions are ignored: the lines are recomputed.
export default async function printTrailOrderEditedHandler({
  event: { data },
  container,
}: SubscriberArgs<{ order_id: string }>) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const service = container.resolve<PrintTrailModuleService>(PRINT_TRAIL_MODULE)
  if (!(await service.isConnected())) {
    return
  }
  try {
    const { result } = await amendPrintTrailOrderWorkflow(container).run({ input: { order_id: data.order_id } })
    await runPrintTrailFollowUps(container, data.order_id, result.resend, { remainder: result.remainder })
  } catch (e) {
    // A lock timeout leaves the amend intent for the sweep.
    logger.error(`Print Trail: amending order ${data.order_id} failed: ${(e as Error).message}`)
  }
}

export const config: SubscriberConfig = {
  event: "order-edit.confirmed",
}
