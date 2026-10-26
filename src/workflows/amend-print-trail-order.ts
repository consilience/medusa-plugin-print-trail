import { orderLock } from "../lib/order-lock"
import { acquireLockStep, releaseLockStep } from "@medusajs/medusa/core-flows"
import { createHook, createWorkflow, transform, WorkflowResponse } from "@medusajs/framework/workflows-sdk"
import type { AmendOutcome } from "../lib/amend-flow"
import type { SelectedLine } from "../lib/lines"
import { SEND_LOCK_TTL_SECONDS, type PrintTrailEvent } from "../lib/send-flow"
import type { FilterLinesHookInput } from "./send-order-to-print-trail"
import { amendPrintTrailRowsStep, reattachSources } from "./steps/amend-print-trail-rows"
import { emitPrintTrailEventsStep } from "./steps/emit-print-trail-events"
import { leaseAmendRowsStep } from "./steps/lease-amend-rows"
import { loadOrderForPrintTrailStep } from "./steps/load-order-for-print-trail"
import { recordAmendIntentStep } from "./steps/record-amend-intent"

// retry: a sweep run of an amend already asked for (keeps its count).
export type AmendPrintTrailOrderInput = { order_id: string; retry?: boolean; lock_timeout?: number }

// Same shape as the send workflow's: register the same handler on both, or
// an edit would send lines the send workflow holds back.
export type AmendFilterLinesHookInput = FilterLinesHookInput

export const amendPrintTrailOrderWorkflowId = "amend-print-trail-order"

// Carries a confirmed Medusa order edit to Print Trail. Drafts are handed
// back in `resend` for the caller to run sendOrderToPrintTrail after the lock
// is released (the lock isn't re-entrant).
export const amendPrintTrailOrderWorkflow = createWorkflow(
  amendPrintTrailOrderWorkflowId,
  function (input: AmendPrintTrailOrderInput) {
    recordAmendIntentStep({ order_id: input.order_id, retry: input.retry })

    const lockKey = transform({ input }, ({ input }) => `print-trail:order:${input.order_id}`)
    acquireLockStep(transform({ input }, ({ input }) => orderLock(input.order_id, input.lock_timeout, SEND_LOCK_TTL_SECONDS)))

    const leased = leaseAmendRowsStep({ order_id: input.order_id })
    const loaded = loadOrderForPrintTrailStep({ order_id: input.order_id })
    // Every row's lines at once: sequence 1, no source_ref.
    const filterLines = createHook("filterLines", {
      order: loaded.order,
      lines: loaded.allLines,
      sequence: 1,
      source_ref: null,
    })
    const lines = transform({ loaded, hookResult: filterLines.getResult() }, ({ loaded, hookResult }) =>
      reattachSources((hookResult as { lines?: SelectedLine[] } | undefined)?.lines, loaded.allLines)
    )
    const leasedIds = transform({ leased }, ({ leased }) => leased.leased)
    const amended = amendPrintTrailRowsStep({ order: loaded.order, lines, leased: leasedIds })
    const events = transform({ amended, leased }, ({ amended, leased }): PrintTrailEvent[] => [
      ...leased.events,
      ...amended.outcomes.flatMap((o) => o.events),
      ...amended.events,
    ])
    emitPrintTrailEventsStep(events)

    releaseLockStep({ key: lockKey })

    const result = transform({ amended }, ({ amended }): { outcomes: AmendOutcome[]; resend: number[]; remainder: boolean } => ({
      outcomes: amended.outcomes,
      resend: amended.resend,
      remainder: amended.remainder,
    }))
    return new WorkflowResponse(result, { hooks: [filterLines] })
  }
)
