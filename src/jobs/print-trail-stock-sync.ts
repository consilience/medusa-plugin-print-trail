import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { describeStockResult, requestStockSync } from "../lib/stock-request"
import { scheduleFor } from "../lib/schedules"

// The daily full stock sync. stockSync.enabled is checked at run time.
export default async function printTrailStockSyncJob(container: MedusaContainer) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  try {
    const result = await requestStockSync(container, { trigger: "schedule" })
    if (result.status !== "disabled") {
      logger.info(`Print Trail stock sync: ${describeStockResult(result)}`)
    }
  } catch (e) {
    logger.error(`Print Trail stock sync job failed: ${(e as Error)?.message ?? e}`)
  }
}

export const config = {
  name: "print-trail-stock-sync",
  // Read when the job file loads; plugin options aren't available yet.
  schedule: scheduleFor("stock"),
}
