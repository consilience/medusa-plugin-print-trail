import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import {
  recordOutcome,
  type ConfirmOutcome,
  type CreateOutcome,
  type GateOutcome,
} from "../../lib/send-flow"
import { buildSendContext } from "./send-context"

export const recordPrintTrailSendOutcomeStep = createStep(
  "record-print-trail-send-outcome",
  async (
    input: { orderId: string; create: CreateOutcome; gate: GateOutcome; confirm?: ConfirmOutcome | null },
    { container }
  ) => {
    const ctx = await buildSendContext(container)
    return new StepResponse(await recordOutcome(ctx, input))
  }
)
