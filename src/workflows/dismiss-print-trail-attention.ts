import { orderLock } from "../lib/order-lock"
import { acquireLockStep, releaseLockStep } from "@medusajs/medusa/core-flows"
import { createStep, createWorkflow, StepResponse, transform, WorkflowResponse } from "@medusajs/framework/workflows-sdk"
import { dismissColumns } from "../lib/admin/order-view"
import { type PrintTrailOrderRow } from "../lib/send-flow"
import { PRINT_TRAIL_MODULE } from "../modules/printTrail"
import type PrintTrailModuleService from "../modules/printTrail/service"
import { RESET_LOCK_TTL_SECONDS } from "./reset-print-trail-retry"

export type DismissPrintTrailAttentionInput = { order_id: string; print_trail_order_id: string; attention: string; lock_timeout?: number }

export const dismissPrintTrailAttentionWorkflowId = "dismiss-print-trail-attention"

const dismissPrintTrailAttentionStep = createStep(
  "dismiss-print-trail-attention",
  async (input: DismissPrintTrailAttentionInput, { container }) => {
    const service = container.resolve<PrintTrailModuleService>(PRINT_TRAIL_MODULE)
    const [row] = (await service.listPrintTrailOrders({ id: input.print_trail_order_id, order_id: input.order_id })) as unknown as PrintTrailOrderRow[]
    const columns = row ? dismissColumns(row, input.attention) : null
    if (!row || !columns) return new StepResponse({ dismissed: false })
    await service.updatePrintTrailOrders({ id: row.id, ...columns })
    await service.createPrintTrailOrderEvents([
      {
        order_id: row.order_id,
        print_trail_order_id: row.id,
        kind: "attention-dismissed",
        message: `Marked as resolved from the admin (${input.attention}).`,
        data: { attention: input.attention, pt_uuid: row.pt_uuid ?? null },
      },
    ] as never)
    return new StepResponse({ dismissed: true })
  }
)

// Acknowledges an attention code nothing clears on its own (a dispatch
// mismatch, "complete manually", a late cancel...). Compare and clear under
// the order's lock: a code that changed meanwhile is left alone. Clearing
// dispatch-mismatch lets the next sync complete the order. A final Print
// Trail code (returned, partial, a returned or failed fulfilment) is also
// remembered in dismissed_attention, so the sync doesn't raise it again
// while Print Trail's order stays that way.
export const dismissPrintTrailAttentionWorkflow = createWorkflow(
  dismissPrintTrailAttentionWorkflowId,
  function (input: DismissPrintTrailAttentionInput) {
    const lockKey = transform({ input }, ({ input }) => `print-trail:order:${input.order_id}`)
    acquireLockStep(transform({ input }, ({ input }) => orderLock(input.order_id, input.lock_timeout, RESET_LOCK_TTL_SECONDS)))
    const result = dismissPrintTrailAttentionStep(input)
    releaseLockStep({ key: lockKey })
    return new WorkflowResponse(result)
  }
)
