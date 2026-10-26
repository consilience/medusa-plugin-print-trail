import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import {
  RECONCILE_LOCK_KEY,
  RECONCILE_LOCK_TTL_SECONDS,
  runReconcile,
  withHeldLock,
} from "../lib/reconcile"
import { ACCESS_SKIPPED, accessRefusedNow, refusalWatch } from "../lib/auth-state"
import { flagReconcileFailure, recordCopySeen } from "../lib/sync-flow"
import { ensureTeamCode } from "../lib/team-code"
import { PRINT_TRAIL_MODULE } from "../modules/printTrail"
import type PrintTrailModuleService from "../modules/printTrail/service"
import { buildSyncStore } from "../workflows/steps/sync-context"
import { syncPrintTrailOrderWorkflow } from "../workflows/sync-print-trail-order"
import { scheduleFor } from "../lib/schedules"

// Polls GET /orders?updated-since=<cursor> and syncs each known order from the
// listed resource. Catches what webhooks miss, including a full edit in the
// Print Trail app, which sends none.
export default async function printTrailReconcileJob(container: MedusaContainer) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const service = container.resolve<PrintTrailModuleService>(PRINT_TRAIL_MODULE)
  if (!(await service.isConnected())) {
    return
  }
  const options = await service.getOptions()
  if (!options.reconcile.enabled) {
    return
  }
  const refused = await accessRefusedNow(service, async () => (await service.getStatusClient()).getToken())
  if (refused) {
    logger.warn(`Print Trail reconcile: skipped: ${ACCESS_SKIPPED[refused]}`)
    return
  }
  const locking = container.resolve(Modules.LOCKING)
  const run = await withHeldLock(locking, RECONCILE_LOCK_KEY, RECONCILE_LOCK_TTL_SECONDS, async () => {
    const client = await service.getClient()
    const teamCode = await ensureTeamCode(service, client)
    const store = buildSyncStore(service)
    return runReconcile({
      client,
      state: service,
      find: {
        byUuid: async (uuid) => ((await service.listPrintTrailOrders({ pt_uuid: uuid }))[0] as never) ?? null,
        byNumber: async (n) => (await service.listPrintTrailOrders({ pt_order_number: n })) as never,
      },
      async sync(row, pt, hint, listedAt) {
        await syncPrintTrailOrderWorkflow(container).run({
          input: {
            print_trail_order_id: row.id,
            order_id: row.order_id,
            source: "reconcile",
            pt,
            pt_uuid_hint: hint,
            listed_at: listedAt.toISOString(),
          },
        })
      },
      async copySeen(row, pt) {
        await recordCopySeen(
          { store, options, teamCode },
          { rowId: row.id, orderId: row.order_id, copyUuid: pt.uuid, copyOrderNumber: pt.orderNumber ?? "" }
        )
      },
      async flag(row, pt, detail) {
        await flagReconcileFailure({ store, options, teamCode }, { rowId: row.id, ptUuid: pt.uuid, detail })
      },
      logger,
      lookbackDays: options.reconcile.lookbackDays,
      halt: await refusalWatch(service),
    })
  })
  if (!run.ran) {
    logger.info("Print Trail reconcile: another run holds the lock; skipping")
    return
  }
  const r = run.result
  logger.info(
    `Print Trail reconcile: ${r.pages} page(s), ${r.synced} synced, ${r.ignored} ignored, ${r.failed} failed, ${r.skipped} skipped, ` +
      `${r.completed ? "complete" : "stopped early"}; cursor ${r.cursor}`
  )
}

export const config = {
  name: "print-trail-reconcile",
  // Read when the job file loads; plugin options aren't available yet.
  schedule: scheduleFor("reconcile"),
}
