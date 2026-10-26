import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { rotatePrintTrailWebhookSecretWorkflow } from "../../../../../workflows/rotate-print-trail-webhook-secret"

// "Rotate webhook secret". No body; the result never carries the secret.
export async function POST(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  const { result } = await rotatePrintTrailWebhookSecretWorkflow(req.scope).run()
  res.json(result)
}
