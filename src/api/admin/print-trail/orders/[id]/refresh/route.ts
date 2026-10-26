import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import type { RefreshResult } from "../../../../../../lib/admin-types"
import { loadAdminOrder, loadRows } from "../../../../../../lib/admin/order-routes"
import { ADMIN_LOCK_TIMEOUT_SECONDS } from "../../../../../../lib/order-lock"
import { isLockBusy } from "../../../../../../lib/stock-request"
import { syncPrintTrailOrderWorkflow } from "../../../../../../workflows/sync-print-trail-order"

// "Refresh from Print Trail": re-fetches each Print Trail order and applies
// it, as a webhook would. Reports whether anything changed.
export async function POST(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  const orderId = req.params.id
  await loadAdminOrder(req.scope, orderId)
  const rows = (await loadRows(req.scope, orderId)).filter((r) => !!r.pt_uuid).sort((a, b) => a.sequence - b.sequence)
  const result: RefreshResult = { changed: false, rows: [] }
  for (const row of rows) {
    try {
      const { result: sync } = await syncPrintTrailOrderWorkflow(req.scope).run({
        input: { print_trail_order_id: row.id, order_id: orderId, source: "admin", lock_timeout: ADMIN_LOCK_TIMEOUT_SECONDS },
      })
      const changes = sync.refetch.changes.length + sync.dispatch.created.length
      result.rows.push({ id: row.id, outcome: sync.refetch.outcome, changes })
      if (changes > 0) result.changed = true
    } catch (e) {
      if (!isLockBusy(e)) throw e
      result.rows.push({ id: row.id, outcome: "busy", changes: 0 })
    }
  }
  res.json(result)
}
