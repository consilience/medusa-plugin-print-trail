import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { registerPrintTrailWebhookWorkflow } from "../../../../workflows/register-print-trail-webhook"
import type { PostPrintTrailWebhookType } from "../validators"

// Re-register, or register an unsafe URL after the admin confirmed it.
export async function POST(req: AuthenticatedMedusaRequest<PostPrintTrailWebhookType>, res: MedusaResponse) {
  const { result } = await registerPrintTrailWebhookWorkflow(req.scope).run({ input: req.validatedBody })
  res.json(result)
}
