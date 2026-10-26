import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils"
import { normaliseSku } from "../lib/sku"
import { forgetUnmatchedSkus } from "../lib/stock-flow"
import { PRINT_TRAIL_MODULE } from "../modules/printTrail"
import type PrintTrailModuleService from "../modules/printTrail/service"

// Forgets a deleted variant's SKU check (print_trail_variant), so its SKU
// leaves the unmatched notice at once. A product deletion sends no
// per-variant events, so its variants' rows go by product. The SKUs those
// rows were checked with also leave the last stock sync's unmatched_skus,
// unless another row still has one; while a stock sync holds the lock, they
// wait for the next full one. Runs whether or not the plugin is connected. A
// variant deleted with no event (a product update that replaces its
// variants) is pruned by the next full stock sync, and so is the SKU of a
// variant that never had a check.
export default async function printTrailVariantDeletedHandler({ event, container }: SubscriberArgs<{ id: string }>) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const id = event.data?.id
  if (!id) return
  const filter = event.name === "product.deleted" ? { productIds: [id] } : { variantIds: [id] }
  let service: PrintTrailModuleService
  let skus: string[]
  try {
    service = container.resolve<PrintTrailModuleService>(PRINT_TRAIL_MODULE)
    skus = await service.checkSkusOf(filter)
    await service.forgetVariants(filter)
  } catch (e) {
    logger.error(`Print Trail: couldn't forget the SKU checks for ${event.name} ${id}: ${(e as Error)?.message ?? e}`)
    return
  }
  if (!skus.length) return
  try {
    const kept = new Set((await service.checkedSkus(skus)).map(normaliseSku))
    const gone = skus.filter((s) => !kept.has(normaliseSku(s)))
    if (!gone.length) return
    const run = await forgetUnmatchedSkus(container.resolve(Modules.LOCKING), service, gone)
    if (!run.ran) {
      logger.debug(`Print Trail: the stock lock is held, so ${gone.join(", ")} stays in the unmatched SKUs until the next full stock sync`)
    }
  } catch (e) {
    logger.error(
      `Print Trail: couldn't remove the SKUs of ${event.name} ${id} from the unmatched SKUs: ${(e as Error)?.message ?? e}; the next full stock sync does`
    )
  }
}

export const config: SubscriberConfig = {
  event: ["product-variant.deleted", "product.deleted"],
}
