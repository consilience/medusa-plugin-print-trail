import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys, getTotalVariantAvailability, MedusaError } from "@medusajs/framework/utils"
import { toVariantView } from "../../../../../lib/admin/variant-view"
import { preOrderFor } from "../../../../../lib/pre-order"
import { resolveSku } from "../../../../../lib/sku"
import { STATE_KEYS, type Backordered } from "../../../../../lib/stock"
import { PRINT_TRAIL_MODULE } from "../../../../../modules/printTrail"
import type PrintTrailModuleService from "../../../../../modules/printTrail/service"
import { loadProfileByProduct, loadPtProfileIds } from "../../../../../workflows/steps/stock-context"

// The variant widget's view: the SKU override and its check, whether the
// product is in a Print Trail profile, pre-order details, and Medusa's stock (admin
// retrieveVariant carries no inventory_quantity in 2.17.2).
export async function GET(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)
  const { data } = await query.graph({
    entity: "product_variant",
    fields: ["id", "sku", "metadata", "manage_inventory", "allow_backorder", "product_id"],
    filters: { id: req.params.id },
  })
  const variant = data[0] as
    | { id: string; sku?: string | null; metadata?: Record<string, unknown> | null; manage_inventory?: boolean; allow_backorder?: boolean; product_id: string }
    | undefined
  if (!variant) throw new MedusaError(MedusaError.Types.NOT_FOUND, `Variant ${req.params.id} was not found`)
  const [profileIds, profiles] = await Promise.all([
    loadPtProfileIds(query),
    loadProfileByProduct(query, { productIds: [variant.product_id] }),
  ])
  const profile = profiles.get(variant.product_id)
  let available: number | null = null
  if (variant.manage_inventory) {
    const totals = await getTotalVariantAvailability(query, { variant_ids: [variant.id] })
    available = totals[variant.id]?.availability ?? null
  }
  // The stock sync's pre-order record (API 1.3.0), for the date and limit,
  // the variant's stored SKU check, and the stock sync's backorder record,
  // which says why the plugin's backorder is on.
  const service = req.scope.resolve<PrintTrailModuleService>(PRINT_TRAIL_MODULE)
  const [preOrder, rows, backordered] = await Promise.all([
    preOrderFor(service, resolveSku(variant)),
    service.variantRows([variant.id]),
    service.getState<Backordered>(STATE_KEYS.backordered),
  ])
  res.json(
    toVariantView(variant, {
      inPtProfile: !!profile && profileIds.includes(profile),
      available,
      preOrder,
      row: rows.get(variant.id) ?? null,
      backordered,
    })
  )
}
