import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { isLockTimeout, recordCopySeen, scheduleRefetch } from "../lib/sync-flow"
import { TEAM_CODE_STATE_KEY, type TeamCodeState } from "../lib/team-code"
import {
  PRINT_TRAIL_COPY_SEEN_EVENT,
  PRINT_TRAIL_WEBHOOK_EVENT,
  type CopySeenEventData,
  type WebhookEventData,
} from "../lib/webhook"
import { PRINT_TRAIL_MODULE } from "../modules/printTrail"
import type PrintTrailModuleService from "../modules/printTrail/service"
import { buildSyncStore } from "../workflows/steps/sync-context"
import { syncPrintTrailOrderWorkflow } from "../workflows/sync-print-trail-order"

// Runs the sync for a verified webhook, or records a Print Trail copy.
export default async function printTrailWebhookHandler({
  event,
  container,
}: SubscriberArgs<WebhookEventData | CopySeenEventData>) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const service = container.resolve<PrintTrailModuleService>(PRINT_TRAIL_MODULE)
  const store = buildSyncStore(service)

  if (event.name === PRINT_TRAIL_COPY_SEEN_EVENT) {
    const data = event.data as CopySeenEventData
    const team = await service.getState<TeamCodeState>(TEAM_CODE_STATE_KEY)
    await recordCopySeen(
      { store, options: await service.getOptions(), teamCode: team?.teamCode ?? null },
      { rowId: data.print_trail_order_id, orderId: data.order_id, copyUuid: data.copy_uuid, copyOrderNumber: data.copy_order_number }
    )
    return
  }

  if (!(await service.isConnected())) {
    return
  }
  const data = event.data as WebhookEventData
  try {
    await syncPrintTrailOrderWorkflow(container).run({
      input: {
        print_trail_order_id: data.print_trail_order_id,
        order_id: data.order_id,
        source: "webhook",
        pt_uuid_hint: data.pt_uuid_hint,
      },
    })
  } catch (e) {
    // Usually a lock timeout while a send holds the order: retry by refetch,
    // unless another action is already pending.
    logger.warn(`Print Trail: sync for order ${data.order_id} failed (${(e as Error).message}); scheduling a refetch`)
    // A lock timeout means another run is syncing it: not counted.
    await scheduleRefetch(store, data.print_trail_order_id, new Date(), (e as Error).message, {
      counted: !isLockTimeout(e),
    })
  }
}

export const config: SubscriberConfig = {
  event: [PRINT_TRAIL_WEBHOOK_EVENT, PRINT_TRAIL_COPY_SEEN_EVENT],
}
