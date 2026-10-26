import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { ACCESS_SKIPPED, accessRefusedNow, refusalWatch } from "../lib/auth-state"
import { PRINT_TRAIL_PROVIDER_ID, shippingOptionIds } from "../lib/lines"
import { runSkuCheckQueue } from "../lib/sku-check-queue"
import { STATE_KEYS } from "../lib/stock"
import { runLegacyMetadataScan } from "../lib/stock-flow"
import { describeStockResult, requestStockSync } from "../lib/stock-request"
import { dueCancels, dueRows, findOrdersMissingRows, ordersMissingCancel, sweepWindow } from "../lib/sweep"
import { runSweepSteps } from "../lib/sweep-steps"
import { PRINT_TRAIL_MODULE } from "../modules/printTrail"
import type PrintTrailModuleService from "../modules/printTrail/service"
import { amendPrintTrailOrderWorkflow } from "../workflows/amend-print-trail-order"
import { cancelPrintTrailOrderWorkflow } from "../workflows/cancel-print-trail-order"
import { runPrintTrailFollowUps } from "../workflows/run-follow-ups"
import { sendOrderToPrintTrailWorkflow } from "../workflows/send-order-to-print-trail"
import { buildSkuCheckQueueContext } from "../workflows/steps/sku-check-context"
import { buildStockContext } from "../workflows/steps/stock-context"
import { refreshPrintTrailWebhookSecretWorkflow } from "../workflows/refresh-print-trail-webhook-secret"
import { syncPrintTrailOrderWorkflow } from "../workflows/sync-print-trail-order"
import { scheduleFor } from "../lib/schedules"

// Runs due retries (stored on print_trail_order rows) and sends orders whose
// order.placed never reached the plugin.
export default async function printTrailSweepJob(container: MedusaContainer) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const service = container.resolve<PrintTrailModuleService>(PRINT_TRAIL_MODULE)
  if (!(await service.isConnected())) {
    return
  }
  const options = await service.getOptions()
  const now = new Date()
  // For the settings page: the locking provider found at startup.
  await service
    .recordLockingCheck()
    .catch((e) => logger.warn(`Print Trail sweep: couldn't record the locking check: ${(e as Error).message}`))
  // While Print Trail refuses the token or channel ID, or the channel is
  // inactive, one probe instead of a refused request per due row.
  const refused = await accessRefusedNow(service, async () => (await service.getStatusClient()).getToken())
  if (refused) {
    logger.warn(`Print Trail sweep: skipped: ${ACCESS_SKIPPED[refused]}`)
    return
  }
  // Once any request of this run is refused (a 401, an inactive channel),
  // the rest of the run is skipped: every further request would be refused
  // too, and Print Trail limits failed requests per IP address.
  const refusedSince = await refusalWatch(service)
  let halted = false
  const stop = async () => {
    if (!halted && (await refusedSince())) {
      halted = true
      logger.warn("Print Trail sweep: stopped: Print Trail refused access during the run")
    }
    return halted
  }
  const unlessStopped = (fn: () => Promise<void>) => async () => {
    if (!(await stop())) await fn()
  }

  // With no readable webhook secret (a new API token, say) every webhook is
  // refused: fetch it again while the channel sends here (rate-limited).
  try {
    const { result } = await refreshPrintTrailWebhookSecretWorkflow(container).run()
    if (result === "stored") logger.info("Print Trail sweep: fetched the webhook secret from the Print Trail API again")
  } catch (e) {
    logger.warn(`Print Trail sweep: couldn't check the webhook secret: ${(e as Error).message}`)
  }

  const send = async (orderId: string, sequence: number) => {
    try {
      await sendOrderToPrintTrailWorkflow(container).run({
        input: { order_id: orderId, sequence },
      })
    } catch (e) {
      logger.error(`Print Trail sweep: order ${orderId} failed: ${(e as Error).message}`)
    }
  }

  const cancel = async (orderId: string) => {
    try {
      await cancelPrintTrailOrderWorkflow(container).run({ input: { order_id: orderId, cause: "order-canceled" } })
    } catch (e) {
      // A lock timeout leaves cancel_status "requested" for the next sweep.
      logger.error(`Print Trail sweep: cancel for order ${orderId} failed: ${(e as Error).message}`)
    }
  }

  await runSweepSteps(
    {
      dueRetries: unlessStopped(runDueRetries),
      missedOrders: unlessStopped(sendMissedOrders),
      pendingStock: unlessStopped(runPendingStockSync),
      skuChecks: unlessStopped(runQueuedSkuChecks),
      // Sends nothing to Print Trail.
      legacyMetadata: runLegacyMetadata,
    },
    logger,
  )

  // 1. Due retries.
  async function runDueRetries() {
    const scheduled = await service.listPrintTrailOrders({ next_attempt_at: { $lte: now } })
    // Cancels are found by cancel_status, which a send never rewrites.
    const cancelOrders = dueCancels(await service.listPrintTrailOrders({ cancel_status: "requested" }), now)
    for (const orderId of cancelOrders) {
      await cancel(orderId)
      if (await stop()) return
    }
    const amended = new Set<string>()
    for (const row of dueRows(scheduled, now)) {
      if (row.pending_action === "cancel") {
        continue
      }
      if (await stop()) return
      if (row.pending_action === "send" || row.pending_action === "confirm") {
        await send(row.order_id, row.sequence)
      } else if (row.pending_action === "refetch") {
        try {
          await syncPrintTrailOrderWorkflow(container).run({
            input: { print_trail_order_id: row.id, order_id: row.order_id, source: "retry" },
          })
        } catch (e) {
          // A lock timeout (a send holds the order) leaves the row due.
          logger.error(`Print Trail sweep: refetch for order ${row.order_id} failed: ${(e as Error).message}`)
        }
      } else if (row.pending_action === "amend") {
        if (amended.has(row.order_id)) continue
        amended.add(row.order_id)
        try {
          const { result } = await amendPrintTrailOrderWorkflow(container).run({ input: { order_id: row.order_id, retry: true } })
          await runPrintTrailFollowUps(container, row.order_id, result.resend, { remainder: result.remainder })
        } catch (e) {
          logger.error(`Print Trail sweep: amend for order ${row.order_id} failed: ${(e as Error).message}`)
        }
      }
    }
  }

  // 4. SKU checks left queued (a busy lock or a 429).
  async function runQueuedSkuChecks() {
    try {
      await runSkuCheckQueue(container.resolve(Modules.LOCKING), await buildSkuCheckQueueContext(container), {
        settleMs: 0,
      })
    } catch (e) {
      logger.error(`Print Trail sweep: queued SKU checks failed: ${(e as Error)?.message ?? e}`)
    }
  }

  // 5. With the stock sync off, no full stock run moves the keys 0.2.0 kept
  // in variant metadata, so the sweep does, once, under the stock lock.
  async function runLegacyMetadata() {
    if (options.stockSync.enabled) return
    try {
      await runLegacyMetadataScan(container.resolve(Modules.LOCKING), await buildStockContext(container))
    } catch (e) {
      logger.error(`Print Trail sweep: the variant metadata scan failed: ${(e as Error)?.message ?? e}`)
    }
  }

  // 3. A stock sync that found the lock held. A deferred result stays for the
  // next sweep.
  async function runPendingStockSync() {
    if (options.stockSync.enabled && (await service.getState(STATE_KEYS.pending))) {
      try {
        const result = await requestStockSync(container, { trigger: "pending" })
        if (result.status !== "dropped") {
          logger.info(`Print Trail sweep: pending stock sync: ${describeStockResult(result)}`)
        }
      } catch (e) {
        logger.error(`Print Trail sweep: pending stock sync failed: ${(e as Error)?.message ?? e}`)
      }
    }
  }

  async function sendMissedOrders() {
    // 2. Orders with Print Trail lines and no row. query.graph can't filter
    // orders by the plugin's rows, so both sides are listed for the window and
    // compared in memory; the window bounds the cost.
    const { from, to } = sweepWindow(now, options.reconcile.lookbackDays)
    const { data: orders } = await query.graph({
      entity: "order",
      fields: ["id", "created_at", "canceled_at", "shipping_methods.shipping_option_id"],
      filters: { created_at: { $gte: from, $lte: to } },
    })
    // Orders have no link to shipping options, so look the options up by id.
    const optionIds = shippingOptionIds(orders as Parameters<typeof shippingOptionIds>[0])
    if (!optionIds.length) {
      return
    }
    const { data: ptOptions } = await query.graph({
      entity: "shipping_option",
      fields: ["id"],
      filters: { id: optionIds, provider_id: PRINT_TRAIL_PROVIDER_ID },
      withDeleted: true,
    })
    const ptOptionIds = new Set(ptOptions.map((o) => o.id))
    const candidates = orders.filter((o) =>
      (o.shipping_methods ?? []).some((sm) => !!sm && ptOptionIds.has(sm.shipping_option_id ?? "")),
    )
    if (!candidates.length) {
      return
    }
    const rows = await service.listPrintTrailOrders(
      { order_id: candidates.map((o) => o.id) },
      { select: ["order_id", "cancel_requested", "pt_uuid"] },
    )
    // Cancelled orders whose order.canceled was lost.
    for (const orderId of ordersMissingCancel(
      candidates.map((o) => ({ id: o.id, canceled_at: o.canceled_at as Date | null })),
      rows,
    )) {
      if (await stop()) return
      logger.info(`Print Trail sweep: cancelling order ${orderId}, whose order.canceled was missed`)
      await cancel(orderId)
    }
    const missing = findOrdersMissingRows(
      candidates.map((o) => ({
        id: o.id,
        created_at: o.created_at as Date,
        canceled_at: o.canceled_at as Date | null,
        hasPrintTrailMethod: true,
      })),
      new Set(rows.map((r) => r.order_id)),
      now,
      options.reconcile.lookbackDays,
    )
    for (const orderId of missing) {
      if (await stop()) return
      logger.info(`Print Trail sweep: sending order ${orderId}, whose order.placed was missed`)
      await send(orderId, 1)
    }
  }
}

export const config = {
  name: "print-trail-sweep",
  // Read when the job file loads; plugin options aren't available yet.
  schedule: scheduleFor("sweep"),
}
