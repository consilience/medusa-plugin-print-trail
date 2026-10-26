import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { PRINT_TRAIL_MODULE } from "../modules/printTrail"
import type PrintTrailModuleService from "../modules/printTrail/service"

// Forgets a deleted variant's SKU check (print_trail_variant), so its SKU
// leaves the unmatched notice. A product deletion sends no per-variant
// events, so its variants' rows go by product. Runs whether or not the plugin
// is connected. A variant deleted with no event (a product update that
// replaces its variants) is pruned by the next full stock sync.
export default async function printTrailVariantDeletedHandler({ event, container }: SubscriberArgs<{ id: string }>) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const id = event.data?.id
  if (!id) return
  try {
    const service = container.resolve<PrintTrailModuleService>(PRINT_TRAIL_MODULE)
    await service.forgetVariants(event.name === "product.deleted" ? { productIds: [id] } : { variantIds: [id] })
  } catch (e) {
    logger.error(`Print Trail: couldn't forget the SKU checks for ${event.name} ${id}: ${(e as Error)?.message ?? e}`)
  }
}

export const config: SubscriberConfig = {
  event: ["product-variant.deleted", "product.deleted"],
}
