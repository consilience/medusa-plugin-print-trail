import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { complete, type DispatchOutcome, type RefetchOutcome } from "../../lib/sync-flow"
import { buildSyncContext } from "./sync-context"

export const completePrintTrailOrderStep = createStep(
  "complete-print-trail-order",
  async (input: { refetch: RefetchOutcome; dispatch: DispatchOutcome }, { container }) => {
    const ctx = await buildSyncContext(container)
    return new StepResponse(await complete(ctx, input.refetch, input.dispatch))
  }
)
