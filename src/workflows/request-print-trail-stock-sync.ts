import { createStep, createWorkflow, StepResponse, WorkflowResponse } from "@medusajs/framework/workflows-sdk"
import { requestStockSync, type StockRequestResult } from "../lib/stock-request"

export const requestPrintTrailStockSyncWorkflowId = "request-print-trail-stock-sync"

export type RequestPrintTrailStockSyncInput = {
  // Only these SKUs; absent means a full sync.
  skus?: string[]
}

const requestPrintTrailStockSyncStep = createStep(
  "request-print-trail-stock-sync",
  async (input: RequestPrintTrailStockSyncInput, { container }) =>
    new StepResponse<StockRequestResult>(await requestStockSync(container, { trigger: "admin", skus: input.skus }))
)

// "Sync stock now" on the settings page: a stock sync with the admin
// trigger, through the same entry point as every other trigger. A held lock
// gives "deferred" and leaves the request for the sweep. No compensation:
// stock writes are not undone, and the next run corrects them.
export const requestPrintTrailStockSyncWorkflow = createWorkflow(
  requestPrintTrailStockSyncWorkflowId,
  function (input: RequestPrintTrailStockSyncInput) {
    const result = requestPrintTrailStockSyncStep(input)
    return new WorkflowResponse(result)
  }
)
