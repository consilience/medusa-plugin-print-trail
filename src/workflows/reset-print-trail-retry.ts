import { orderLock } from "../lib/order-lock"
import { acquireLockStep, releaseLockStep } from "@medusajs/medusa/core-flows"
import { createStep, createWorkflow, StepResponse, transform, WorkflowResponse } from "@medusajs/framework/workflows-sdk"
import { resetColumns, type RetryReset } from "../lib/admin/order-view"
import type { PrintTrailOrderRow } from "../lib/send-flow"
import { PRINT_TRAIL_MODULE } from "../modules/printTrail"
import type PrintTrailModuleService from "../modules/printTrail/service"

export type ResetPrintTrailRetryInput = { order_id: string; print_trail_order_id: string; reset: RetryReset; lock_timeout?: number }

export const resetPrintTrailRetryWorkflowId = "reset-print-trail-retry"

// One write; the lock only has to outlast it.
export const RESET_LOCK_TTL_SECONDS = 60

const resetPrintTrailRetryStep = createStep(
  "reset-print-trail-retry",
  async (input: ResetPrintTrailRetryInput, { container }) => {
    const service = container.resolve<PrintTrailModuleService>(PRINT_TRAIL_MODULE)
    const [row] = (await service.listPrintTrailOrders({ id: input.print_trail_order_id, order_id: input.order_id })) as unknown as PrintTrailOrderRow[]
    const columns = row ? resetColumns(row, input.reset, new Date()) : null
    if (!row || !columns) return new StepResponse({ id: input.print_trail_order_id, reset: false })
    if (Object.keys(columns).length) {
      await service.updatePrintTrailOrders({ id: row.id, ...columns } as never)
      await service.createPrintTrailOrderEvents([
        {
          order_id: row.order_id,
          print_trail_order_id: row.id,
          kind: "retry-reset",
          message:
            input.reset.kind === "capped"
              ? `Retries reset from the admin (${input.reset.action}).`
              : "Retries reset from the admin.",
          data: { reset: input.reset, pt_uuid: row.pt_uuid ?? null },
        },
      ] as never)
    }
    return new StepResponse({ id: row.id, reset: true })
  }
)

// Resend's reset of a capped (or used-up) retry, under the order's lock so
// it never lands in the middle of a send, sync, cancel or amend run. It
// re-reads the row and writes only if the row still matches the plan, then
// releases: the follow-up workflow takes the lock itself (not re-entrant).
export const resetPrintTrailRetryWorkflow = createWorkflow(
  resetPrintTrailRetryWorkflowId,
  function (input: ResetPrintTrailRetryInput) {
    const lockKey = transform({ input }, ({ input }) => `print-trail:order:${input.order_id}`)
    acquireLockStep(transform({ input }, ({ input }) => orderLock(input.order_id, input.lock_timeout, RESET_LOCK_TTL_SECONDS)))
    const result = resetPrintTrailRetryStep(input)
    releaseLockStep({ key: lockKey })
    return new WorkflowResponse(result)
  }
)
