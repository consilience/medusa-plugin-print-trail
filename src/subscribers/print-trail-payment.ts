import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { orderIdForPayment } from "../lib/payment-order"
import { AWAITING_PAYMENT, withinLookback } from "../lib/sweep"
import type { PrintTrailOrderRow } from "../lib/send-flow"
import { PRINT_TRAIL_MODULE } from "../modules/printTrail"
import type PrintTrailModuleService from "../modules/printTrail/service"
import { recordPrintTrailOrderChangeWorkflow } from "../workflows/record-print-trail-order-change"
import { runPrintTrailFollowUps } from "../workflows/run-follow-ups"
import { sendOrderToPrintTrailWorkflow } from "../workflows/send-order-to-print-trail"

async function confirmsWhenPlaced(service: PrintTrailModuleService): Promise<boolean> {
  try {
    return (await service.getFreshOptions()).confirmOn === "order.placed"
  } catch {
    return false
  }
}

// payment.captured and payment.refunded carry the payment id, not the order.
// A capture re-runs the send of the orders not yet confirmed, deciding by
// confirmOn as saved now (never this process's cached copy): the confirm
// gate refuses an unpaid order and leaves a confirmed one alone, so a
// capture just after a switch to confirming on payment isn't lost. A refund
// is recorded on the timeline.
export default async function printTrailPaymentHandler({
  event: { data, name },
  container,
}: SubscriberArgs<{ id: string }>) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const service = container.resolve<PrintTrailModuleService>(PRINT_TRAIL_MODULE)
  if (!(await service.isConnected())) return
  const options = await service.getOptions()
  try {
    const orderId = await orderIdForPayment(container.resolve(ContainerRegistrationKeys.QUERY), data.id)
    if (!orderId) return
    const rows = (await service.listPrintTrailOrders({ order_id: orderId })) as unknown as PrintTrailOrderRow[]
    if (name === "payment.refunded") {
      if (!rows.length) return
      await recordPrintTrailOrderChangeWorkflow(container).run({
        input: { order_id: orderId, change: { kind: "refund", payment_id: data.id } },
      })
      return
    }
    // Under confirming when placed (read now, past the cache) a capture
    // changes nothing the gate decides, but for a row the gate held for
    // payment before a switch: only those are sent again. A row confirmed,
    // or with a send in flight (its lease), or none yet, is the order.placed
    // send's and the sweep's, so a capture at checkout doesn't wait for the
    // order's lock behind that send. If the settings can't be read, the
    // capture takes the path below, which the gate decides.
    if (await confirmsWhenPlaced(service)) {
      const held = rows.filter(
        (r) => r.block_reason === AWAITING_PAYMENT && !r.confirmed_at && !r.pending_action && !r.cancel_status && r.status !== "cancelled"
      )
      if (held.length) await runPrintTrailFollowUps(container, orderId, held.map((r) => r.sequence))
      return
    }
    // Capture: re-run the send for every row still waiting to confirm. No
    // lock here: the send workflow takes it.
    if (!rows.length) {
      // Bounded like the sweep: an old order captured late isn't sent.
      const query = container.resolve(ContainerRegistrationKeys.QUERY)
      const { data: orders } = await query.graph({ entity: "order", fields: ["id", "created_at"], filters: { id: orderId } })
      if (!withinLookback(orders[0]?.created_at as Date | undefined, new Date(), options.reconcile.lookbackDays)) {
        logger.info(
          `Print Trail: payment captured for order ${orderId}, which has no Print Trail order and is older than ${options.reconcile.lookbackDays} days; not sending it`
        )
        return
      }
      await sendOrderToPrintTrailWorkflow(container).run({ input: { order_id: orderId } })
      return
    }
    const waiting = rows
      .filter((r) => !r.confirmed_at && !r.cancel_status && r.status !== "cancelled")
      .map((r) => r.sequence)
    await runPrintTrailFollowUps(container, orderId, waiting)
  } catch (e) {
    logger.error(`Print Trail: handling ${name} for payment ${data.id} failed: ${(e as Error).message}`)
  }
}

export const config: SubscriberConfig = {
  event: ["payment.captured", "payment.refunded"],
}
