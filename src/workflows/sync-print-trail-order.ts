import { orderLock } from "../lib/order-lock"
import { acquireLockStep, releaseLockStep } from "@medusajs/medusa/core-flows"
import { createWorkflow, transform, WorkflowResponse } from "@medusajs/framework/workflows-sdk"
import type { PtOrder } from "../modules/printTrail/client/types"
import { SEND_LOCK_TTL_SECONDS, type PrintTrailEvent } from "../lib/send-flow"
import type { CompletionOutcome, DispatchOutcome, RefetchOutcome, SyncSource } from "../lib/sync-flow"
import { completePrintTrailOrderStep } from "./steps/complete-print-trail-order"
import { dispatchPrintTrailFulfilmentsStep } from "./steps/dispatch-print-trail-fulfilments"
import { emitPrintTrailEventsStep } from "./steps/emit-print-trail-events"
import { refetchPrintTrailOrderStep } from "./steps/refetch-print-trail-order"

export type SyncPrintTrailOrderInput = {
  print_trail_order_id: string
  order_id: string
  source: SyncSource
  // Our own order whose uuid was never stored (webhook or reconcile adopt).
  pt_uuid_hint?: string
  // The order resource reconcile already listed; skips the GET.
  pt?: PtOrder
  // When reconcile read that page (ISO); a newer local snapshot wins.
  listed_at?: string
  // Seconds to wait for the per-order lock (admin actions: 0).
  lock_timeout?: number
}

export const syncPrintTrailOrderWorkflowId = "sync-print-trail-order"

// Brings Print Trail's side of one order into Medusa: re-fetch, record,
// create and ship fulfilments for what has dispatched, complete. Run from the
// webhook subscriber, the sweep (refetch retries) and reconcile. Takes the
// same per-order lock as sending.
export const syncPrintTrailOrderWorkflow = createWorkflow(
  syncPrintTrailOrderWorkflowId,
  function (input: SyncPrintTrailOrderInput) {
    const lockKey = transform({ input }, ({ input }) => `print-trail:order:${input.order_id}`)
    acquireLockStep(transform({ input }, ({ input }) => orderLock(input.order_id, input.lock_timeout, SEND_LOCK_TTL_SECONDS)))

    const refetchInput = transform({ input }, ({ input }) => ({
      rowId: input.print_trail_order_id,
      source: input.source,
      ptUuidHint: input.pt_uuid_hint,
      pt: input.pt,
      listedAt: input.listed_at,
    }))
    const refetched = refetchPrintTrailOrderStep(refetchInput)
    const dispatched = dispatchPrintTrailFulfilmentsStep(refetched)
    const completion = completePrintTrailOrderStep({ refetch: refetched, dispatch: dispatched })

    const events = transform(
      { refetched, dispatched, completion },
      ({ refetched, dispatched, completion }): PrintTrailEvent[] => [
        ...refetched.events,
        ...dispatched.events,
        ...completion.events,
      ]
    )
    emitPrintTrailEventsStep(events)

    releaseLockStep({ key: lockKey })

    const result = transform(
      { refetched, dispatched, completion },
      ({ refetched, dispatched, completion }): {
        refetch: RefetchOutcome
        dispatch: DispatchOutcome
        completion: CompletionOutcome
      } => ({ refetch: refetched, dispatch: dispatched, completion })
    )
    return new WorkflowResponse(result)
  }
)
