import { acquireLockStep, releaseLockStep } from "@medusajs/medusa/core-flows"
import { createWorkflow, transform, WorkflowResponse } from "@medusajs/framework/workflows-sdk"
import type { ChangeOutcome } from "../lib/order-change-flow"
import { SEND_LOCK_TIMEOUT_SECONDS, SEND_LOCK_TTL_SECONDS } from "../lib/send-flow"
import { emitPrintTrailEventsStep } from "./steps/emit-print-trail-events"
import { recordOrderChangeStep, type OrderChange } from "./steps/record-order-change"

export type RecordPrintTrailOrderChangeInput = { order_id: string; change: OrderChange }

export const recordPrintTrailOrderChangeWorkflowId = "record-print-trail-order-change"

// Address changes, refunds and returns: timeline entries and row state
// under the order's lock. The caller re-sends `resend` once it's released.
export const recordPrintTrailOrderChangeWorkflow = createWorkflow(
  recordPrintTrailOrderChangeWorkflowId,
  function (input: RecordPrintTrailOrderChangeInput) {
    const lockKey = transform({ input }, ({ input }) => `print-trail:order:${input.order_id}`)
    acquireLockStep({ key: lockKey, timeout: SEND_LOCK_TIMEOUT_SECONDS, ttl: SEND_LOCK_TTL_SECONDS })
    const outcome = recordOrderChangeStep({ order_id: input.order_id, change: input.change })
    const events = transform({ outcome }, ({ outcome }) => outcome.events)
    emitPrintTrailEventsStep(events)
    releaseLockStep({ key: lockKey })
    const result = transform({ outcome }, ({ outcome }): ChangeOutcome => outcome)
    return new WorkflowResponse(result)
  }
)
