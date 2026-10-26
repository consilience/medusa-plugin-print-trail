import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { dispatch, type RefetchOutcome } from "../../lib/sync-flow"
import { buildSyncContext } from "./sync-context"

// One Medusa fulfilment and shipment per dispatched Print Trail fulfilment.
// Medusa's refusals are recorded, not thrown.
export const dispatchPrintTrailFulfilmentsStep = createStep(
  "dispatch-print-trail-fulfilments",
  async (refetched: RefetchOutcome, { container }) => {
    const ctx = await buildSyncContext(container)
    return new StepResponse(await dispatch(ctx, refetched))
  }
)
