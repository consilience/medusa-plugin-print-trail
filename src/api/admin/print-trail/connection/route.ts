import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { buildConnectionDeps, connectionStatus } from "../../../../lib/admin/connection"
import { testPrintTrailConnectionWorkflow } from "../../../../workflows/test-print-trail-connection"

// The settings page's check on load. Read-only: never registers a webhook.
export async function GET(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  res.json(await connectionStatus(await buildConnectionDeps(req.scope)))
}

// "Test connection".
export async function POST(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  const { result } = await testPrintTrailConnectionWorkflow(req.scope).run()
  res.json(result)
}
