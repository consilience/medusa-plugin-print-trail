import { orderLock } from "../lib/order-lock"
import { acquireLockStep, releaseLockStep } from "@medusajs/medusa/core-flows"
import { createWorkflow, transform, WorkflowResponse } from "@medusajs/framework/workflows-sdk"
import type { CancelOutcome } from "../lib/cancel-flow"
import { SEND_LOCK_TTL_SECONDS, type PrintTrailEvent } from "../lib/send-flow"
import { cancelPrintTrailRowsStep } from "./steps/cancel-print-trail-rows"
import { emitPrintTrailEventsStep } from "./steps/emit-print-trail-events"
import { recordCancelIntentStep } from "./steps/record-cancel-intent"

export type CancelPrintTrailOrderInput = { order_id: string; cause?: "order-canceled" | "no-pt-lines"; lock_timeout?: number }

export const cancelPrintTrailOrderWorkflowId = "cancel-print-trail-order"

// Carries a Medusa cancel to Print Trail for every row of the order. The
// intent is stored before the lock, so a lock timeout fails the run without
// losing the cancel: the sweep runs it.
export const cancelPrintTrailOrderWorkflow = createWorkflow(
  cancelPrintTrailOrderWorkflowId,
  function (input: CancelPrintTrailOrderInput) {
    const intent = transform({ input }, ({ input }) => ({
      order_id: input.order_id,
      cause: input.cause ?? ("order-canceled" as const),
    }))
    recordCancelIntentStep(intent)

    const lockKey = transform({ input }, ({ input }) => `print-trail:order:${input.order_id}`)
    acquireLockStep(transform({ input }, ({ input }) => orderLock(input.order_id, input.lock_timeout, SEND_LOCK_TTL_SECONDS)))

    const outcomes = cancelPrintTrailRowsStep(intent)
    const events = transform({ outcomes }, ({ outcomes }): PrintTrailEvent[] => outcomes.flatMap((o) => o.events))
    emitPrintTrailEventsStep(events)

    releaseLockStep({ key: lockKey })

    const result = transform({ outcomes }, ({ outcomes }): { outcomes: CancelOutcome[] } => ({ outcomes }))
    return new WorkflowResponse(result)
  }
)
