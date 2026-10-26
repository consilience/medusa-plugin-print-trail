import type { MedusaContainer } from "@medusajs/framework/types"
import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { requestCancel } from "../../lib/cancel-flow"
import type { PrintTrailOrderRow } from "../../lib/send-flow"
import { PRINT_TRAIL_MODULE } from "../../modules/printTrail"
import type PrintTrailModuleService from "../../modules/printTrail/service"
import { isOrderCanceled } from "./cancel-context"
import { buildSyncStore } from "./sync-context"

export async function recordCancelIntent(
  input: { order_id: string; cause: "order-canceled" | "no-pt-lines" },
  container: MedusaContainer
): Promise<string[]> {
  if (!(await isOrderCanceled(container, input.order_id))) return []
  const service = container.resolve<PrintTrailModuleService>(PRINT_TRAIL_MODULE)
  const rows = (await service.listPrintTrailOrders({ order_id: input.order_id })) as unknown as PrintTrailOrderRow[]
  return requestCancel(buildSyncStore(service), rows, input.cause, new Date())
}

// Runs before the lock: the intent (cancel_status "requested") survives a
// lock timeout, and the sweep runs it. No compensation: the intent must stay.
export const recordCancelIntentStep = createStep(
  "record-cancel-intent",
  async (input: { order_id: string; cause: "order-canceled" | "no-pt-lines" }, { container }) =>
    new StepResponse(await recordCancelIntent(input, container))
)
