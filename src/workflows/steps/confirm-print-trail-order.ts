import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import type { PtConfirmRequest, PtOrder } from "../../modules/printTrail/client/types"
import { confirm } from "../../lib/send-flow"
import { buildSendContext } from "./send-context"

// Writes confirmed_at in the same step as Print Trail's 202. No compensation.
export const confirmPrintTrailOrderStep = createStep(
  "confirm-print-trail-order",
  async (
    input: { rowId: string; pt: PtOrder; body: PtConfirmRequest; methodByLine: Record<string, string> },
    { container }
  ) => {
    const ctx = await buildSendContext(container)
    return new StepResponse(await confirm(ctx, input))
  }
)
