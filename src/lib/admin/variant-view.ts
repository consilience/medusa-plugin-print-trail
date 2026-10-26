import type { VariantView } from "../admin-types"
import { isCheckCurrent } from "../sku-check"
import { isNumericOverride, overrideOf, resolveSku } from "../sku"
import type { PreOrderSku } from "../pre-order"
import { BACKORDER_MARKER_KEY } from "../stock"
import { storedCheck, type VariantCheckRow } from "../variant-checks"

type ViewVariant = {
  sku?: string | null
  metadata?: Record<string, unknown> | null
  manage_inventory?: boolean
  allow_backorder?: boolean
}

// ctx.preOrder: the stock sync's pre_order_skus entry for the resolved SKU;
// null when the record exists and doesn't list it; undefined when there's no
// record (an older Print Trail API sends no status), so the SKU check's
// status is the only source. ctx.row: the variant's print_trail_variant row;
// without one, the legacy check in its metadata is shown.
export function toVariantView(
  variant: ViewVariant,
  ctx: {
    inPtProfile: boolean
    available: number | null
    preOrder?: Omit<PreOrderSku, "sku"> | null
    row?: VariantCheckRow | null
  }
): VariantView {
  const metadata = variant.metadata ?? null
  const resolved = resolveSku(variant)
  const check = storedCheck(ctx.row, metadata)
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
      // Only the plugin's own marker (the boolean true) means print on demand.
      print_on_demand: metadata?.[BACKORDER_MARKER_KEY] === true,
      pre_order: ctx.preOrder === undefined ? check?.status === "pre-order" : ctx.preOrder !== null,
      pre_order_backorder: metadata?.[BACKORDER_MARKER_KEY] === "pre-order",
      pre_order_limit: ctx.preOrder?.limit ?? null,
      pre_order_remaining: ctx.preOrder?.remaining ?? null,
      publication_date: ctx.preOrder?.publicationDate ?? null,
    },
  }
}
