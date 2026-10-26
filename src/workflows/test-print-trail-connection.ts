import { createStep, createWorkflow, StepResponse, WorkflowResponse } from "@medusajs/framework/workflows-sdk"
import type { ConnectionTestResult } from "../lib/admin-types"
import { buildConnectionDeps, testConnection } from "../lib/admin/connection"

export const testPrintTrailConnectionWorkflowId = "test-print-trail-connection"

// One step, no compensation: Print Trail calls can't be undone.
const testPrintTrailConnectionStep = createStep(
  "test-print-trail-connection",
  async (_input: undefined, { container }) => new StepResponse(await testConnection(await buildConnectionDeps(container)))
)

// "Test connection": diagnoses, stores the team code and registers the
// webhook when Print Trail has none or another URL (never an unsafe one
// without confirmation).
export const testPrintTrailConnectionWorkflow = createWorkflow(testPrintTrailConnectionWorkflowId, function () {
  const result: ConnectionTestResult = testPrintTrailConnectionStep()
  return new WorkflowResponse(result)
})
