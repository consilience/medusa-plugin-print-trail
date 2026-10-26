import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { recordAmendIntent } from "../../lib/amend-flow"
import type { PrintTrailOrderRow } from "../../lib/send-flow"
import { PRINT_TRAIL_MODULE } from "../../modules/printTrail"
import type PrintTrailModuleService from "../../modules/printTrail/service"
import { buildSyncStore } from "./sync-context"

// Before the lock (amend-flow.ts recordAmendIntent). No compensation: the
// intent must survive a lock timeout.
export const recordAmendIntentStep = createStep(
  "record-amend-intent",
  async (input: { order_id: string; retry?: boolean }, { container }) => {
    const service = container.resolve<PrintTrailModuleService>(PRINT_TRAIL_MODULE)
    const rows = (await service.listPrintTrailOrders({ order_id: input.order_id })) as unknown as PrintTrailOrderRow[]
    return new StepResponse(await recordAmendIntent(buildSyncStore(service), rows, { retry: !!input.retry }, new Date()))
  }
)
