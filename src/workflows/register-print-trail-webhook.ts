import { createStep, createWorkflow, StepResponse, WorkflowResponse } from "@medusajs/framework/workflows-sdk"
import type { ConnectionTestResult } from "../lib/admin-types"
import { buildConnectionDeps, registerWebhook } from "../lib/admin/connection"

export type RegisterPrintTrailWebhookInput = { force?: boolean }

export const registerPrintTrailWebhookWorkflowId = "register-print-trail-webhook"

const registerPrintTrailWebhookStep = createStep(
  "register-print-trail-webhook",
  async (input: RegisterPrintTrailWebhookInput, { container }) =>
    new StepResponse(await registerWebhook(await buildConnectionDeps(container), { force: input.force === true }))
)

// Re-register, or register an unsafe URL the admin confirmed (force). Reads
// the channel first: it never overwrites a URL it hasn't seen. No
// compensation: Print Trail calls can't be undone.
export const registerPrintTrailWebhookWorkflow = createWorkflow(
  registerPrintTrailWebhookWorkflowId,
  function (input: RegisterPrintTrailWebhookInput) {
    const result: ConnectionTestResult["webhook"] = registerPrintTrailWebhookStep(input)
    return new WorkflowResponse(result)
  }
)
