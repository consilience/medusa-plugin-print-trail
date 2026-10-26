import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import type { PtOrder } from "../../modules/printTrail/client/types"
import { refetch, type SyncSource } from "../../lib/sync-flow"
import { buildSyncContext } from "./sync-context"

// Re-fetches GET /orders/{uuid} (or takes reconcile's listed resource) and
// records it. No compensation: nothing here can be undone.
export const refetchPrintTrailOrderStep = createStep(
  "refetch-print-trail-order",
  async (input: { rowId: string; source: SyncSource; ptUuidHint?: string; pt?: PtOrder; listedAt?: string }, { container }) => {
    const ctx = await buildSyncContext(container)
    const outcome = await refetch(ctx, input)
    if (outcome.outcome === "auth-failed" || outcome.outcome === "channel-inactive" || outcome.outcome === "hint-mismatch") {
      const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
      logger.warn(`Print Trail: re-fetch for order ${outcome.orderId} (${outcome.rowId}): ${outcome.outcome}: ${outcome.detail ?? ""}`)
    }
    return new StepResponse(outcome)
  }
)
