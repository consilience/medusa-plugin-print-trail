import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { PRINT_TRAIL_MODULE } from "../modules/printTrail"
import type PrintTrailModuleService from "../modules/printTrail/service"
import { sendOrderToPrintTrailWorkflow } from "../workflows/send-order-to-print-trail"

type ClaimOrExchange = { order_id: string; claim_id?: string; exchange_id?: string }

// A confirmed claim or exchange: its added Print Trail items go out as a
// "-n" Print Trail order of their own. A replay finds the same row.
export default async function printTrailClaimCreatedHandler({
  event: { data, name },
  container,
}: SubscriberArgs<ClaimOrExchange>) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const service = container.resolve<PrintTrailModuleService>(PRINT_TRAIL_MODULE)
  if (!(await service.isConnected())) {
    return
  }
  const sourceRef =
    name === "order.exchange_created" ? `exchange:${data.exchange_id}` : `claim:${data.claim_id}`
  try {
    await sendOrderToPrintTrailWorkflow(container).run({
      input: { order_id: data.order_id, source_ref: sourceRef },
    })
  } catch (e) {
    logger.error(`Print Trail: sending ${sourceRef} of order ${data.order_id} failed: ${(e as Error).message}`)
  }
}

export const config: SubscriberConfig = {
  event: ["order.claim_created", "order.exchange_created"],
}
