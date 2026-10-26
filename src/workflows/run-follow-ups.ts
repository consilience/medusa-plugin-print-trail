import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { sendOrderToPrintTrailWorkflow } from "./send-order-to-print-trail"

// Runs the sends a workflow handed back (`resend`), one after another, once
// its lock is released. Each failure is logged; the sweep retries what's due.
// remainder: also send whatever no row carries (re-added lines) as a new
// "-n" order, through the send workflow's auto target.
export async function runPrintTrailFollowUps(
  container: MedusaContainer,
  orderId: string,
  resend: number[],
  opts: { remainder?: boolean } = {}
): Promise<void> {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  for (const sequence of [...new Set(resend)]) {
    try {
      await sendOrderToPrintTrailWorkflow(container).run({ input: { order_id: orderId, sequence } })
    } catch (e) {
      logger.error(`Print Trail: re-sending ${orderId} (sequence ${sequence}) failed: ${(e as Error).message}`)
    }
  }
  if (opts.remainder) {
    try {
      await sendOrderToPrintTrailWorkflow(container).run({ input: { order_id: orderId } })
    } catch (e) {
      logger.error(`Print Trail: sending the re-added items of ${orderId} failed: ${(e as Error).message}`)
    }
  }
}
