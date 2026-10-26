import type { AuthenticatedMedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import type { SkuHealthView } from "../../../../lib/admin-types"
import { lastRunView, skuProblems } from "../../../../lib/admin/sku-health"
import { readUnmatchedSkus, STATE_KEYS } from "../../../../lib/stock"
import type { StockLastRun } from "../../../../lib/stock-flow"
import { PRINT_TRAIL_MODULE } from "../../../../modules/printTrail"
import type PrintTrailModuleService from "../../../../modules/printTrail/service"
import { loadProfileByProduct, loadPtProfileIds } from "../../../../workflows/steps/stock-context"

const PRODUCT_CHUNK = 200
const VARIANT_LIMIT = 2000

// SKU health across Print Trail's shipping profiles: unmatched SKUs, the
// variants whose check failed, and the last stock run.
export async function GET(req: AuthenticatedMedusaRequest, res: MedusaResponse) {
  const service = req.scope.resolve<PrintTrailModuleService>(PRINT_TRAIL_MODULE)
  const query = req.scope.resolve(ContainerRegistrationKeys.QUERY)
  const [unmatched, lastRun, options] = await Promise.all([
    readUnmatchedSkus(service),
    service.getState<StockLastRun>(STATE_KEYS.lastRun),
    service.getOptions(),
  ])
  const profileIds = await loadPtProfileIds(query)
  const productIds = [...(await loadProfileByProduct(query, { profileIds })).keys()]
  const variants: Parameters<typeof skuProblems>[0] = []
  let truncated = false
  for (let i = 0; i < productIds.length; i += PRODUCT_CHUNK) {
    const { data } = await query.graph({
      entity: "product_variant",
      fields: ["id", "title", "sku", "metadata", "product_id", "product.title"],
      filters: { product_id: productIds.slice(i, i + PRODUCT_CHUNK) },
    })
    variants.push(...(data as never[]))
    if (variants.length >= VARIANT_LIMIT) {
      truncated = variants.length > VARIANT_LIMIT || i + PRODUCT_CHUNK < productIds.length
      variants.length = Math.min(variants.length, VARIANT_LIMIT)
      break
    }
  }
  const rows = await service.variantRows(variants.map((v) => v.id))
  const { problems, unchecked } = skuProblems(variants, rows)
  const body: SkuHealthView = {
    unmatched,
    problems,
    unchecked,
    truncated,
    lastRun: lastRunView(lastRun),
    stockSyncEnabled: options.stockSync.enabled,
  }
  res.json(body)
}
