import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import type { StockSyncNowView } from "../../../../lib/admin-types"
import { describeStockResult } from "../../../../lib/stock-request"
import { requestPrintTrailStockSyncWorkflow } from "../../../../workflows/request-print-trail-stock-sync"
import type { PostPrintTrailStockSyncType } from "../validators"

// "Sync stock now": a full stock sync, waited for. A failed run is a result
// (200, status "failed"); only a thrown error is a 500. Behind a proxy a
// long run can outlast the request while it finishes on the server.
export async function POST(req: AuthenticatedMedusaRequest<PostPrintTrailStockSyncType>, res: MedusaResponse<StockSyncNowView>) {
  const { result } = await requestPrintTrailStockSyncWorkflow(req.scope).run({ input: {} })
  res.json({ status: result.status, summary: describeStockResult(result) })
}
