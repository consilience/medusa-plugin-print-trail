import { createStep, StepResponse } from "@medusajs/framework/workflows-sdk"
import { runLockedStockSync, type StockSyncInput, type StockSyncResult } from "../../lib/stock-flow"
import { buildStockContext } from "./stock-context"

// Under the print-trail:stock lock (see runLockedStockSync). No compensation:
// stock writes are not undone, and the next run corrects them.
export const syncPrintTrailStockStep = createStep(
  "sync-print-trail-stock",
  async (input: StockSyncInput, { container }) => {
    const ctx = await buildStockContext(container)
    return new StepResponse<StockSyncResult>(await runLockedStockSync(ctx, input))
  }
)
