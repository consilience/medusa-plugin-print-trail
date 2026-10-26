import { createStep, createWorkflow, StepResponse, WorkflowResponse } from "@medusajs/framework/workflows-sdk"
import type { RotateResult } from "../lib/admin-types"
import { buildConnectionDeps, rotateSecret } from "../lib/admin/connection"

export const rotatePrintTrailWebhookSecretWorkflowId = "rotate-print-trail-webhook-secret"

const rotatePrintTrailWebhookSecretStep = createStep(
  "rotate-print-trail-webhook-secret",
  async (_input: undefined, { container }) => new StepResponse(await rotateSecret(await buildConnectionDeps(container)))
)

// "Rotate webhook secret" on the settings page. Refuses unless the channel
// sends to this store. No compensation: Print Trail calls can't be undone.
export const rotatePrintTrailWebhookSecretWorkflow = createWorkflow(rotatePrintTrailWebhookSecretWorkflowId, function () {
  const result: RotateResult = rotatePrintTrailWebhookSecretStep()
  return new WorkflowResponse(result)
})
