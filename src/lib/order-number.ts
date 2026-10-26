import { MedusaError } from "@medusajs/framework/utils"

// Print Trail upserts drafts by (channel, orderNumber), so the number must be
// stable per Print Trail order. Claims, exchanges and released pre-orders on
// the same Medusa order get "-n".
export function printTrailOrderNumber(
  prefix: string,
  displayId: number | string | null | undefined,
  sequence = 1
): string {
  if (displayId === null || displayId === undefined || String(displayId) === "") {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      "Order has no display_id; cannot build a Print Trail order number"
    )
  }
  const base = `${prefix}${displayId}`
  return sequence > 1 ? `${base}-${sequence}` : base
}
