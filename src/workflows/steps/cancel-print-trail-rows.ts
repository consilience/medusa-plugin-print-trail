import type { MedusaContainer } from "@medusajs/framework/types"
import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { cancelRow, requestCancel, type CancelOutcome } from "../../lib/cancel-flow"
import { CANCEL_CALLS_PER_ROW, rowsPerRun, SEND_LOCK_TTL_SECONDS, type PrintTrailOrderRow } from "../../lib/send-flow"
import { dueCancels } from "../../lib/sweep"
import { buildCancelContext, isOrderCanceled } from "./cancel-context"

export async function cancelPrintTrailRows(
  input: { order_id: string; cause?: "order-canceled" | "no-pt-lines" },
  container: MedusaContainer
): Promise<CancelOutcome[]> {
  const ctx = await buildCancelContext(container, input.order_id)
  const now = new Date()
  // Again under the lock: a send may have created a row after the intent step
  // ran. Only for a Medusa-cancelled order: an emptied draft's retried cancel
  // runs just its row.
  if (await isOrderCanceled(container, input.order_id)) await requestCancel(ctx.store, (await ctx.store.listPrintTrailOrders({ order_id: input.order_id })) as PrintTrailOrderRow[], input.cause ?? "order-canceled", now)
  const rows = (await ctx.store.listPrintTrailOrders({ order_id: input.order_id, cancel_status: "requested" })) as PrintTrailOrderRow[]
  const outcomes: CancelOutcome[] = []
  // The rest stay requested and due: the sweep runs them next.
  const budget = rowsPerRun(SEND_LOCK_TTL_SECONDS, CANCEL_CALLS_PER_ROW)
  for (const row of rows.sort((a, b) => a.sequence - b.sequence)) {
    if (outcomes.length >= budget) break
    if (dueCancels([row], now).length) {
      outcomes.push(await cancelRow(ctx, row))
    }
  }
  return outcomes
}

// Under the lock: cancels each row whose cancel is requested and due. Print
// Trail calls can't be undone, so there is no compensation.
export const cancelPrintTrailRowsStep = createStep(
  "cancel-print-trail-rows",
  async (input: { order_id: string; cause?: "order-canceled" | "no-pt-lines" }, { container }) =>
    new StepResponse(await cancelPrintTrailRows(input, container))
)
