import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { leaseAmends } from "../../lib/amend-flow"
import { PRINT_TRAIL_MODULE } from "../../modules/printTrail"
import type PrintTrailModuleService from "../../modules/printTrail/service"
import { buildSyncStore } from "./sync-context"

// Right after the lock (so a lock timeout counts nothing), before anything
// that can throw: counts this run's amend attempt (amend-flow.ts).
export const leaseAmendRowsStep = createStep(
  "lease-amend-rows",
  async (input: { order_id: string }, { container }) => {
    const service = container.resolve<PrintTrailModuleService>(PRINT_TRAIL_MODULE)
    return new StepResponse(await leaseAmends(buildSyncStore(service), input.order_id, new Date()))
  }
)
