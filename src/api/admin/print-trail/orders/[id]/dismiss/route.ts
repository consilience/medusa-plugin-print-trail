import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import type { DismissResult } from "../../../../../../lib/admin-types"
import { loadRows, rowOfOrder } from "../../../../../../lib/admin/order-routes"
import { canDismiss } from "../../../../../../lib/admin/order-view"
import { ADMIN_LOCK_TIMEOUT_SECONDS } from "../../../../../../lib/order-lock"
import { isLockBusy } from "../../../../../../lib/stock-request"
import { dismissPrintTrailAttentionWorkflow } from "../../../../../../workflows/dismiss-print-trail-attention"
import type { PostPrintTrailDismissType } from "../../../validators"

// "Mark as resolved" for an attention code nothing clears on its own,
// including Print Trail's final codes (canDismiss).
export async function POST(req: AuthenticatedMedusaRequest<PostPrintTrailDismissType>, res: MedusaResponse) {
  const orderId = req.params.id
  // No order load: an attention row whose order was deleted must still be
  // dismissable. rowOfOrder keeps the body to this order's rows.
  const row = rowOfOrder(await loadRows(req.scope, orderId), req.validatedBody.print_trail_order_id)!
  if (!canDismiss(req.validatedBody.attention)) {
    return res.status(400).json({ type: "invalid_data", message: "not-dismissable" })
  }
  try {
    const { result } = await dismissPrintTrailAttentionWorkflow(req.scope).run({
      input: { order_id: orderId, print_trail_order_id: row.id, attention: req.validatedBody.attention, lock_timeout: ADMIN_LOCK_TIMEOUT_SECONDS },
    })
    res.json({ status: result.dismissed ? "dismissed" : "unchanged" } satisfies DismissResult)
  } catch (e) {
    if (isLockBusy(e)) return res.status(409).json({ message: "busy", ...({ status: "busy" } satisfies DismissResult) })
    throw e
  }
}
