import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import type { ResendResult } from "../../../../../../lib/admin-types"
import { loadAdminOrder, loadRows, rowOfOrder } from "../../../../../../lib/admin/order-routes"
import { planResend, sendOutcome, type SendOutcome } from "../../../../../../lib/admin/order-view"
import { ADMIN_LOCK_TIMEOUT_SECONDS } from "../../../../../../lib/order-lock"
import { isLockBusy } from "../../../../../../lib/stock-request"
import { amendPrintTrailOrderWorkflow } from "../../../../../../workflows/amend-print-trail-order"
import { cancelPrintTrailOrderWorkflow } from "../../../../../../workflows/cancel-print-trail-order"
import { resetPrintTrailRetryWorkflow } from "../../../../../../workflows/reset-print-trail-retry"
import { runPrintTrailFollowUps } from "../../../../../../workflows/run-follow-ups"
import { sendOrderToPrintTrailWorkflow } from "../../../../../../workflows/send-order-to-print-trail"
import { syncPrintTrailOrderWorkflow } from "../../../../../../workflows/sync-print-trail-order"
import type { PostPrintTrailResendType } from "../../../validators"

// "Send now", "Resend / retry confirm" and "Resend as a new Print Trail
// order". A capped retry is reset first (its own locked workflow), then the
// existing workflow runs; a busy lock leaves the reset for the sweep.
export async function POST(req: AuthenticatedMedusaRequest<PostPrintTrailResendType>, res: MedusaResponse) {
  const orderId = req.params.id
  const order = await loadAdminOrder(req.scope, orderId)
  const rows = await loadRows(req.scope, orderId)
  const row =
    rowOfOrder(rows, req.validatedBody.print_trail_order_id) ?? [...rows].sort((a, b) => a.sequence - b.sequence)[0] ?? null
  const reissued = !!row && rows.some((r) => r.source_ref === `reissue:${row.sequence}`)
  const plan = planResend(orderId, row, { asNew: req.validatedBody.as_new, orderCanceled: order.canceled, now: new Date(), reissued })
  if (plan.kind === "refused") {
    // The JS SDK keeps only `message` from an error body: it carries the code.
    const body: ResendResult = { plan: "refused", status: "refused", reason: plan.reason }
    return res.status(409).json({ message: plan.reason, ...body })
  }

  let sent: SendOutcome | null = null
  try {
    if ("reset" in plan && plan.reset && row) {
      const { result } = await resetPrintTrailRetryWorkflow(req.scope).run({
        input: { order_id: orderId, print_trail_order_id: row.id, reset: plan.reset, lock_timeout: ADMIN_LOCK_TIMEOUT_SECONDS },
      })
      if (!result.reset) {
        // Another run changed the row since the page loaded.
        return res.status(409).json({ message: "changed", ...({ plan: plan.kind, status: "refused", reason: "changed" } satisfies ResendResult) })
      }
    }
    switch (plan.kind) {
      case "send":
      case "reissue": {
        const { result } = await sendOrderToPrintTrailWorkflow(req.scope).run({ input: { ...plan.input, lock_timeout: ADMIN_LOCK_TIMEOUT_SECONDS } })
        sent = sendOutcome(result)
        break
      }
      case "cancel":
        await cancelPrintTrailOrderWorkflow(req.scope).run({ input: { order_id: orderId, cause: "order-canceled", lock_timeout: ADMIN_LOCK_TIMEOUT_SECONDS } })
        break
      case "amend": {
        const { result } = await amendPrintTrailOrderWorkflow(req.scope).run({ input: { order_id: orderId, lock_timeout: ADMIN_LOCK_TIMEOUT_SECONDS } })
        await runPrintTrailFollowUps(req.scope, orderId, result.resend, { remainder: result.remainder })
        break
      }
      case "refetch":
        await syncPrintTrailOrderWorkflow(req.scope).run({
          input: { print_trail_order_id: row!.id, order_id: orderId, source: "admin", lock_timeout: ADMIN_LOCK_TIMEOUT_SECONDS },
        })
        break
    }
  } catch (e) {
    if (isLockBusy(e)) return res.status(409).json({ message: "busy", ...({ plan: plan.kind, status: "busy" } satisfies ResendResult) })
    throw e
  }
  const body: ResendResult = { plan: plan.kind, status: "done", ...(sent ? { outcome: sent.outcome, reason: sent.reason } : {}) }
  return res.json(body)
}
