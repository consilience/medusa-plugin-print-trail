import type { VariantView } from "../admin-types"
import { isCheckCurrent } from "../sku-check"
import { isNumericOverride, overrideOf, resolveSku } from "../sku"
import type { PreOrderSku } from "../pre-order"
import { reasonFor, type Backordered } from "../stock"
import { storedCheck, type VariantCheckRow } from "../variant-checks"

type ViewVariant = {
  id?: string | null
  sku?: string | null
  metadata?: Record<string, unknown> | null
  manage_inventory?: boolean
  allow_backorder?: boolean
}

// ctx.preOrder: the stock sync's pre_order_skus entry for the resolved SKU;
// null when the record exists and doesn't list it; undefined when there's no
// record (an older Print Trail API sends no status), so the SKU check's
// status is the only source. ctx.row: the variant's print_trail_variant row;
// without one, the legacy check in its metadata is shown. ctx.backordered:
// stock_backordered, which says why the plugin's backorder is on.
export function toVariantView(
  variant: ViewVariant,
  ctx: {
    inPtProfile: boolean
    available: number | null
    preOrder?: Omit<PreOrderSku, "sku"> | null
    row?: VariantCheckRow | null
    backordered?: Backordered | null
  }
): VariantView {
  const metadata = variant.metadata ?? null
  const resolved = resolveSku(variant)
  const check = storedCheck(ctx.row, metadata)
  // Null unless the plugin turned this variant's backorder on: a store's own
  // backorder, or a stale marker, shows neither.
  const reason = reasonFor(ctx.backordered, variant.id, metadata)
  return {
    in_print_trail_profile: ctx.inPtProfile,
    sku: variant.sku ?? null,
    override: overrideOf(metadata),
    resolved_sku: resolved,
    check,
    check_current: isCheckCurrent(resolved, check, { numericOverride: isNumericOverride(metadata) }),
    stock: {
      manage_inventory: variant.manage_inventory ?? false,
      allow_backorder: variant.allow_backorder ?? false,
      available: ctx.available,
      print_on_demand: reason === "print-on-demand",
      pre_order: ctx.preOrder === undefined ? check?.status === "pre-order" : ctx.preOrder !== null,
      pre_order_backorder: reason === "pre-order",
      pre_order_limit: ctx.preOrder?.limit ?? null,
      pre_order_remaining: ctx.preOrder?.remaining ?? null,
      publication_date: ctx.preOrder?.publicationDate ?? null,
    },
  }
}
