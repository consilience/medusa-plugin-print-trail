import { acquireLockStep, releaseLockStep } from "@medusajs/medusa/core-flows"
import { createWorkflow, WorkflowResponse } from "@medusajs/framework/workflows-sdk"
import { STOCK_LOCK_KEY, STOCK_LOCK_TTL_SECONDS } from "../lib/stock"
import type { StockSyncInput } from "../lib/stock-flow"
import { syncPrintTrailStockStep } from "./steps/sync-print-trail-stock"

export type { StockSyncInput }

export const syncPrintTrailStockWorkflowId = "sync-print-trail-stock"

// Mirrors Print Trail stock onto the inventory of Print Trail products. Run
// through requestStockSync (src/lib/stock-request.ts) by the stock job, the
// stock-level-updated webhook, a confirm shortfall and the sweep.
//
// timeout 0 tries the lock once and throws if it's held; the ttl is the
// lock's expiry. Never locking.execute: its timeout is also the expiry.
export const syncPrintTrailStockWorkflow = createWorkflow(
  syncPrintTrailStockWorkflowId,
  function (input: StockSyncInput) {
    acquireLockStep({ key: STOCK_LOCK_KEY, timeout: 0, ttl: STOCK_LOCK_TTL_SECONDS })
    const result = syncPrintTrailStockStep(input)
    releaseLockStep({ key: STOCK_LOCK_KEY })
    return new WorkflowResponse(result)
  }
)
