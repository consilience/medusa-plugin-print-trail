import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { orderView } from "../../../../../lib/admin/order-routes"

// Every Print Trail order of a Medusa order, with links, fulfilments and the
// timeline, for the order widgets.
export async function GET(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  res.json(await orderView(req.scope, req.params.id))
}
