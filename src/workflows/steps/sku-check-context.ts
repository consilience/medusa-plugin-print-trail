import type { MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import {
  unmatchedSkusFromEvents,
  type CheckVariant,
  type SkuCheckContext,
  type SkuCheckPort,
} from "../../lib/sku-check"
import { resolveSku } from "../../lib/sku"
import { storedCheck, type VariantCheckRow } from "../../lib/variant-checks"
import { PRINT_TRAIL_MODULE } from "../../modules/printTrail"
import type PrintTrailModuleService from "../../modules/printTrail/service"
import { sendOrderToPrintTrailWorkflow } from "../send-order-to-print-trail"
import { SKU_CHECK_QUEUE_PREFIX, type SkuCheckQueueContext } from "../../lib/sku-check-queue"
import { requestStockSync } from "../../lib/stock-request"
import { loadProfileByProduct, loadPtProfileIds } from "./stock-context"

export const CHECK_VARIANT_FIELDS = ["id", "sku", "metadata", "product_id"]

type GraphCheckVariant = { id: string; sku?: string | null; metadata?: Record<string, unknown> | null; product_id?: string | null }

// rows: the variants' print_trail_variant rows, by variant id.
export function toCheckVariants(
  graphVariants: unknown[],
  profileByProduct: Map<string, string>,
  rows: Map<string, VariantCheckRow>
): CheckVariant[] {
  return (graphVariants as (GraphCheckVariant | null)[]).flatMap((v) =>
    v
      ? [
          {
            id: v.id,
            sku: resolveSku(v),
            metadata: v.metadata ?? null,
            profileId: (v.product_id && profileByProduct.get(v.product_id)) || null,
            productId: v.product_id ?? "",
            check: storedCheck(rows.get(v.id), v.metadata),
            hasRow: rows.has(v.id),
          },
        ]
      : []
  )
}

export function buildSkuCheckPort(container: MedusaContainer): SkuCheckPort {
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const service = container.resolve<PrintTrailModuleService>(PRINT_TRAIL_MODULE)
  return {
    ptProfileIds: () => loadPtProfileIds(query),
    async loadVariants(input) {
      const filters = input.variantIds ? { id: input.variantIds } : input.productId ? { product_id: input.productId } : null
      if (!filters) return []
      const { data } = await query.graph({ entity: "product_variant", fields: CHECK_VARIANT_FIELDS, filters })
      const productIds = [...new Set(data.map((v) => v.product_id as string).filter(Boolean))]
      const [profiles, rows] = await Promise.all([
        loadProfileByProduct(query, { productIds }),
        service.variantRows(data.map((v) => v.id)),
      ])
      return toCheckVariants(data, profiles, rows)
    },
    // The plugin's own table: no metadata write, so no product-variant.updated.
    async writeCheck(variant, check) {
      await service.writeVariantCheck({ variantId: variant.id, productId: variant.productId, check, source: "sku-check" })
    },
    async blockedRows() {
      const rows = await service.listPrintTrailOrders({ block_reason: "unmatched-skus", confirmed_at: null })
      if (!rows.length) return []
      const events = await service.listPrintTrailOrderEvents(
        { print_trail_order_id: rows.map((r) => r.id), kind: "blocked" },
        { select: ["print_trail_order_id", "kind", "created_at", "data"] }
      )
      const skus = unmatchedSkusFromEvents(events)
      return rows.map((r) => ({ id: r.id, order_id: r.order_id, sequence: r.sequence, unmatchedSkus: skus.get(r.id) ?? null }))
    },
    async orderVariants(orderIds) {
      const { data } = await query.graph({
        entity: "order",
        fields: ["id", "canceled_at", "items.variant_id"],
        filters: { id: orderIds },
      })
      return data.map((o) => ({
        orderId: o.id,
        canceled: !!o.canceled_at,
        variantIds: (o.items ?? []).flatMap((i) => (i?.variant_id ? [i.variant_id] : [])),
      }))
    },
    async resend(orderId, sequence) {
      try {
        await sendOrderToPrintTrailWorkflow(container).run({ input: { order_id: orderId, sequence } })
        logger.info(`Print Trail: re-sent order ${orderId} after its SKUs matched`)
      } catch (e) {
        logger.error(`Print Trail: re-send of order ${orderId} failed: ${(e as Error)?.message ?? e}`)
      }
    },
  }
}

export async function buildSkuCheckContext(container: MedusaContainer): Promise<SkuCheckContext> {
  const service = container.resolve<PrintTrailModuleService>(PRINT_TRAIL_MODULE)
  return {
    client: await service.getClient(),
    state: service,
    port: buildSkuCheckPort(container),
    logger: container.resolve(ContainerRegistrationKeys.LOGGER),
  }
}

export async function buildSkuCheckQueueContext(container: MedusaContainer): Promise<SkuCheckQueueContext> {
  const service = container.resolve<PrintTrailModuleService>(PRINT_TRAIL_MODULE)
  return {
    ...(await buildSkuCheckContext(container)),
    queue: {
      add: (ids) => service.queueStateKeys(SKU_CHECK_QUEUE_PREFIX, ids),
      take: (limit) => service.takeStateKeys(SKU_CHECK_QUEUE_PREFIX, limit),
    },
    logger: container.resolve(ContainerRegistrationKeys.LOGGER),
    refreshStock: async (skus) => {
      await requestStockSync(container, { trigger: "sku-check", skus })
    },
  }
}
