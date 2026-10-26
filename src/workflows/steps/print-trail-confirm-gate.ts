import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import type { GraphOrder } from "../../lib/lines"
import { checkGate, type CreateOutcome } from "../../lib/send-flow"
import { buildSendContext } from "./send-context"

// Its own step, so a refusal shows in the workflow's execution record and the
// confirm step never runs unless the gate said yes. It re-reads the order's
// cancellation and payments rather than trusting the snapshot loaded before
// the create.
export const printTrailConfirmGateStep = createStep(
  "print-trail-confirm-gate",
  async (input: { order: GraphOrder; create: CreateOutcome }, { container }) => {
    const ctx = await buildSendContext(container)
    return new StepResponse(await checkGate(ctx, input.order, input.create))
  }
)
