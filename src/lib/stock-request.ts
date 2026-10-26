import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { PRINT_TRAIL_MODULE } from "../modules/printTrail"
import type PrintTrailModuleService from "../modules/printTrail/service"
import { syncPrintTrailStockWorkflow } from "../workflows/sync-print-trail-stock"
import { admitStockRequest, deferOnLockBusy, type StockSyncInput, type StockSyncResult } from "./stock-flow"

// "Failed to acquire lock" from the in-memory, Redis and Postgres providers;
// "is already locked." from Postgres's insert race. Matched on the message:
// the workflow may hand the error back serialised.
export function isLockBusy(e: unknown): boolean {
  const message = (e as { message?: unknown } | null | undefined)?.message
  return typeof message === "string" && /failed to acquire lock|is already locked/i.test(message)
}

export type StockRequestResult = StockSyncResult | { status: "deferred" }

// The one entry point every stock trigger uses.
export async function requestStockSync(container: MedusaContainer, input: StockSyncInput): Promise<StockRequestResult> {
  const service = container.resolve<PrintTrailModuleService>(PRINT_TRAIL_MODULE)
  if (!(await service.isConnected())) {
    return { status: "disabled" }
  }
  const options = await service.getOptions()
  const admitted = await admitStockRequest({ state: service, options }, input)
  if (admitted !== "run") {
    return { status: admitted }
  }
  try {
    const { result } = await syncPrintTrailStockWorkflow(container).run({ input })
    return result
  } catch (e) {
    if (isLockBusy(e)) {
      await deferOnLockBusy(service, input, new Date())
      return { status: "deferred" }
    }
    const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
    logger.error(`Print Trail stock sync (${input.trigger}) failed: ${(e as Error)?.message ?? e}`)
    throw e
  }
}

export function describeStockResult(result: StockRequestResult): string {
  if (result.status === "completed") {
    const p = result.plan
    const preOrder = Object.values(p.backorderReason ?? {}).filter((r) => r === "pre-order").length
    const on = `${p.backorderOn.length} on${preOrder ? ` (${preOrder} pre-order)` : ""}`
    return `${p.levelUpdates.length} levels updated, backorders ${on} / ${p.backorderOff.length} off, ${p.unmatched.length} unmatched SKUs, ${p.skipped.length} skipped`
  }
  if (result.status === "failed") {
    return `failed: ${result.error}`
  }
  return result.status
}
