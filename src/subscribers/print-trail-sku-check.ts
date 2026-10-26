import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { runSkuCheckQueue } from "../lib/sku-check-queue"
import { PRINT_TRAIL_MODULE } from "../modules/printTrail"
import type PrintTrailModuleService from "../modules/printTrail/service"
import { buildSkuCheckQueueContext } from "../workflows/steps/sku-check-context"

const VARIANT_EVENTS = ["product-variant.updated", "product-variant.created"]

// Queues the saved variant (or every variant of a saved product) for a Print
// Trail SKU check, then drains the queue under the print-trail:sku-check lock.
// A bulk import's events coalesce into batches of 250; when another run holds
// the lock, it (or the sweep) picks the variants up. The check is stored in
// the plugin's own table, so writing it fires no event. The plugin's
// metadata writes (the stock sync's pre-order flag, the upgrade scan's
// deletion of the old keys) do: a variant whose check is current calls
// nothing, but one whose check is "error" (couldn't check), or whose SKU no
// longer matches the one it was checked with, is checked with Print Trail
// again.
export default async function printTrailSkuCheckHandler({ event, container }: SubscriberArgs<{ id: string }>) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const id = event.data?.id
  if (!id) return
  try {
    const service = container.resolve<PrintTrailModuleService>(PRINT_TRAIL_MODULE)
    if (!(await service.isConnected())) return
    const ctx = await buildSkuCheckQueueContext(container)
    let variantIds = [id]
    if (!VARIANT_EVENTS.includes(event.name)) {
      const query = container.resolve(ContainerRegistrationKeys.QUERY)
      const { data } = await query.graph({ entity: "product_variant", fields: ["id"], filters: { product_id: id } })
      variantIds = data.map((v) => v.id)
    }
    await ctx.queue.add(variantIds)
    const run = await runSkuCheckQueue(container.resolve(Modules.LOCKING), ctx)
    if (run.ran && run.result.checked) {
      logger.debug(`Print Trail SKU check: ${run.result.checked} variants in ${run.result.batches} calls`)
    }
  } catch (e) {
    logger.error(`Print Trail SKU check for ${event.name} ${id} failed: ${(e as Error)?.message ?? e}`)
  }
}

export const config: SubscriberConfig = {
  event: ["product-variant.updated", "product-variant.created", "product.updated", "product.created"],
}
