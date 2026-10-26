import { createStep, createWorkflow, StepResponse, WorkflowResponse } from "@medusajs/framework/workflows-sdk"
import type { MedusaContainer } from "@medusajs/framework/types"
import { buildConnectionDeps, refreshWebhookSecret, secretRefreshDue, type SecretRefresh } from "../lib/admin/connection"
import { PRINT_TRAIL_MODULE } from "../modules/printTrail"
import type PrintTrailModuleService from "../modules/printTrail/service"

export const refreshPrintTrailWebhookSecretWorkflowId = "refresh-print-trail-webhook-secret"

// The cheap checks first, so a normal sweep (secret readable) builds no
// connection deps: no shipping-option query, no lock, no Print Trail call.
export async function refreshSecretFor(container: MedusaContainer): Promise<SecretRefresh> {
  const service = container.resolve<PrintTrailModuleService>(PRINT_TRAIL_MODULE)
  if (!(await service.isConnected())) return "not-configured"
  const skip = await secretRefreshDue(service, await service.getOptions(), new Date())
  if (skip) return skip
  return refreshWebhookSecret(await buildConnectionDeps(container))
}

const refreshPrintTrailWebhookSecretStep = createStep(
  "refresh-print-trail-webhook-secret",
  async (_input: undefined, { container }) => new StepResponse(await refreshSecretFor(container))
)

// Run by the sweep: fetches the webhook secret again when none is readable
// and the channel sends to this store. No compensation: Print Trail calls
// can't be undone.
export const refreshPrintTrailWebhookSecretWorkflow = createWorkflow(refreshPrintTrailWebhookSecretWorkflowId, function () {
  const result: SecretRefresh = refreshPrintTrailWebhookSecretStep()
  return new WorkflowResponse(result)
})
