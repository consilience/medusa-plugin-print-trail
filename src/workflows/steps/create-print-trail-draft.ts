import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { mergePayloadOverride, type PreparedPayload } from "../../lib/hooks"
import type { GraphOrder, SelectedLine } from "../../lib/lines"
import type { SendTarget } from "../../lib/order-scope"
import { createDraft, type CreateOutcome } from "../../lib/send-flow"
import { buildSendContext } from "./send-context"

export type CreatePrintTrailDraftInput = {
  order: GraphOrder
  lines: SelectedLine[]
  selected: SelectedLine[]
  target: SendTarget
  orderNumber: string | null
  prepared: PreparedPayload | null
  // The payload hook's result.
  payloadOverride?: unknown
}

// Persists the Print Trail uuid inside the step, before returning. No
// compensation: a Print Trail call can't be undone, and the uuid must survive
// a later failure or a retry would create a second draft.
export const createPrintTrailDraftStep = createStep(
  "create-print-trail-draft",
  async (input: CreatePrintTrailDraftInput, { container }) => {
    const { target } = input
    if (!target.ok || !input.orderNumber) {
      const refused: CreateOutcome = {
        rowId: null,
        outcome: "target-refused",
        pt: null,
        confirmedAt: null,
        blockReason: null,
        detail: target.ok ? undefined : target.detail,
        posted: false,
        sentLineNumbers: [],
        methodByLine: {},
      }
      return new StepResponse(refused)
    }
    let prepared = input.prepared ?? undefined
    if (prepared?.ok) {
      const merged = mergePayloadOverride(prepared.payload, input.payloadOverride)
      if (merged.warning) {
        container.resolve(ContainerRegistrationKeys.LOGGER).warn(`Print Trail: order ${input.order.id}: ${merged.warning}`)
      }
      prepared = { ...prepared, payload: merged.payload }
    }
    const ctx = await buildSendContext(container)
    return new StepResponse(
      await createDraft(ctx, {
        order: input.order,
        lines: input.lines,
        selected: input.selected,
        sequence: target.sequence,
        sourceRef: target.sourceRef,
        orderNumber: input.orderNumber,
        prepared,
      })
    )
  }
)
