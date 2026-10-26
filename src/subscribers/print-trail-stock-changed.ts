import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { describeStockResult, requestStockSync } from "../lib/stock-request"
import { scheduleWaitingRefetches, type SyncStore } from "../lib/sync-flow"
import { PRINT_TRAIL_STOCK_CHANGED_EVENT, type HeldSku, type StockChangedEventData } from "../lib/webhook"
import { PRINT_TRAIL_MODULE } from "../modules/printTrail"
import type PrintTrailModuleService from "../modules/printTrail/service"

// A verified stock-level-updated webhook: a full sync, never a patch from the
// payload. A replay (changedAt not after the watermark) is dropped. Then the
// rows whose Print Trail fulfilments changed with no order webhook (API
// 1.3.0) are queued for a refetch, for SKUs the store has seen held at Print
// Trail:
// - active: going live before the stock arrives switches a waiting
//   fulfilment to out-of-stock;
// - pre-order or inactive: an out-of-stock back-order switches to pre-order
//   with no order webhook, and a waiting one's product state changes.
export default async function printTrailStockChangedHandler({ event, container }: SubscriberArgs<StockChangedEventData>) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const listed = Array.isArray(event.data?.activated_skus) ? event.data.activated_skus : []
  const held: HeldSku[] = Array.isArray(event.data?.held_skus) ? event.data.held_skus : []
  // Only a SKU ever seen held at Print Trail can have orders waiting on it
  // (an add-only record: no stock run in between can hide it). A pre-order
  // item is its own evidence: recorded first, so a product set to pre-order
  // for the first time while orders wait out of stock is scanned.
  let seen = new Set<string>()
  try {
    const service = container.resolve<PrintTrailModuleService>(PRINT_TRAIL_MODULE)
    const preOrder = held.filter((h) => h.status === "pre-order").map((h) => h.sku)
    if (preOrder.length) await service.markPreOrderSeen(preOrder)
    const all = [...new Set([...listed, ...held.map((h) => h.sku)])]
    seen = new Set(all.length ? await service.preOrderSeen(all) : [])
  } catch (e) {
    logger.error(`Print Trail: couldn't read the pre-order SKUs: ${(e as Error)?.message ?? e}`)
  }
  try {
    const result = await requestStockSync(container, { trigger: "webhook", changedAt: event.data?.changed_at ?? null })
    const line = `Print Trail stock-level-updated (changedAt ${event.data?.changed_at ?? "none"}): ${describeStockResult(result)}`
    if (result.status === "dropped" || result.status === "disabled") {
      logger.debug(line)
    } else {
      logger.info(line)
    }
  } catch (e) {
    logger.error(`Print Trail stock-level-updated sync failed: ${(e as Error)?.message ?? e}`)
  }
  const active = listed.filter((s) => seen.has(s))
  const heldSeen = held.filter((h) => seen.has(h.sku))
  if (!active.length && !heldSeen.length) {
    return
  }
  try {
    const store = container.resolve<SyncStore>(PRINT_TRAIL_MODULE)
    const scheduled = await scheduleWaitingRefetches(store, { active, held: heldSeen }, new Date())
    if (scheduled.length) {
      const skus = [...active, ...heldSeen.map((h) => h.sku)]
      logger.info(`Print Trail stock-level-updated: re-reading ${scheduled.length} order(s) held on ${skus.join(", ")}`)
    }
  } catch (e) {
    logger.error(`Print Trail refetch of waiting orders failed: ${(e as Error)?.message ?? e}`)
  }
}

export const config: SubscriberConfig = {
  event: PRINT_TRAIL_STOCK_CHANGED_EVENT,
}
