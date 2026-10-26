import { resolveSku } from "./sku"

// provider_id of shipping options served by this plugin's provider
// (identifier "print-trail", registered with id "print-trail").
export const PRINT_TRAIL_PROVIDER_ID = "print-trail_print-trail"

// The fields sendOrderToPrintTrail reads with query.graph. Medusa has no link
// from an order's shipping methods to their shipping options (only carts have
// one), so the options are fetched separately and joined with
// attachShippingOptions.
export const ORDER_FIELDS = [
  "id",
  "display_id",
  "email",
  "status",
  "canceled_at",
  "metadata",
  "shipping_address.*",
  "billing_address.*",
  "items.id",
  "items.detail.quantity",
  "items.variant.sku",
  "items.variant.metadata",
  "items.variant.product.shipping_profile.id",
  "shipping_methods.shipping_option_id",
  "payment_collections.captured_amount",
  "payment_collections.refunded_amount",
]

// What the confirm gate re-reads just before it decides.
export const GATE_ORDER_FIELDS = [
  "id",
  "status",
  "canceled_at",
  "payment_collections.captured_amount",
  "payment_collections.refunded_amount",
]

export const SHIPPING_OPTION_FIELDS = ["id", "provider_id", "shipping_profile_id", "data"]

// Claims and exchanges add their replacement items to order.items (Medusa
// 2.17.2 creates them as ITEM_ADD order-change actions). The order has no
// claims/exchanges relation in query.graph, so they are read from the
// order_claim and order_exchange entities by order_id, as the admin routes do,
// and attached to the order. An added item is an OrderExchangeItem, or an
// OrderClaimItem with is_additional_item true; a claim's additional_items and
// claim_items both map every OrderClaimItem (models/claim.js), so the flag is
// checked here too (core-flows create-claim-items-from-actions.js sets it).
export const CLAIM_FIELDS = ["id", "additional_items.item_id", "additional_items.is_additional_item"]
export const EXCHANGE_FIELDS = ["id", "additional_items.item_id"]

export type ShippingOptionInfo = {
  id: string
  provider_id?: string | null
  shipping_profile_id?: string | null
  data?: Record<string, unknown> | null
}

// Attaches each shipping method's option, as a cart's link would.
export function attachShippingOptions<
  T extends { shipping_methods?: ({ shipping_option_id?: string | null } | null)[] | null },
>(order: T, options: ShippingOptionInfo[]): T {
  const byId = new Map(options.map((o) => [o.id, o]))
  return {
    ...order,
    shipping_methods: (order.shipping_methods ?? []).map((sm) =>
      sm ? { ...sm, shipping_option: byId.get(sm.shipping_option_id ?? "") ?? null } : sm
    ),
  }
}

export function shippingOptionIds(
  orders: { shipping_methods?: ({ shipping_option_id?: string | null } | null)[] | null }[]
): string[] {
  const ids = new Set<string>()
  for (const o of orders) {
    for (const sm of o.shipping_methods ?? []) {
      if (sm?.shipping_option_id) ids.add(sm.shipping_option_id)
    }
  }
  return [...ids]
}

export type GraphOrder = {
  id: string
  display_id?: number | string | null
  email?: string | null
  status?: string | null
  canceled_at?: string | Date | null
  metadata?: Record<string, unknown> | null
  shipping_address?: Record<string, any> | null
  billing_address?: Record<string, any> | null
  items?: ({
    id: string
    // Present only when items.detail.quantity is selected; plain
    // items.quantity is absent without items.*.
    detail?: { quantity?: number | string | null } | null
    variant?: {
      sku?: string | null
      metadata?: Record<string, unknown> | null
      product?: { shipping_profile?: { id?: string | null } | null } | null
    } | null
  } | null)[] | null
  shipping_methods?: ({
    shipping_option_id?: string | null
    shipping_option?: {
      provider_id?: string | null
      shipping_profile_id?: string | null
      data?: Record<string, unknown> | null
    } | null
  } | null)[] | null
  payment_collections?: ({
    captured_amount?: number | string | null
    refunded_amount?: number | string | null
  } | null)[] | null
  claims?: ({
    id?: string | null
    additional_items?: ({ item_id?: string | null; is_additional_item?: boolean | null } | null)[] | null
  } | null)[] | null
  exchanges?: ({ id?: string | null; additional_items?: ({ item_id?: string | null } | null)[] | null } | null)[] | null
}

export type SelectedLine = {
  lineItemId: string
  sku: string | null
  quantity: number
  method: string
}

// A Print Trail line and where it came from: "claim:{id}" or
// "exchange:{id}" for an item a claim or exchange added, else null.
export type ScopedLine = SelectedLine & { replacementOf: string | null }

// Items added to the order by claims and exchanges, by item id → source
// ("claim:{id}" | "exchange:{id}"). They go to Print Trail as orders of their
// own (sequence 2, 3…), never in the order's first one.
// A direct order-module createClaim/createExchange call given an existing
// line item id would mark an original item as added (the workflows never do).
export function replacementSources(order: Pick<GraphOrder, "claims" | "exchanges">): Map<string, string> {
  const sources = new Map<string, string>()
  for (const claim of order.claims ?? []) {
    for (const ci of claim?.additional_items ?? []) {
      if (ci?.item_id && ci.is_additional_item) sources.set(ci.item_id, `claim:${claim?.id ?? ""}`)
    }
  }
  for (const exchange of order.exchanges ?? []) {
    for (const ei of exchange?.additional_items ?? []) {
      if (ei?.item_id) sources.set(ei.item_id, `exchange:${exchange?.id ?? ""}`)
    }
  }
  return sources
}

export function replacementItemIds(order: Pick<GraphOrder, "claims" | "exchanges">): Set<string> {
  return new Set(replacementSources(order).keys())
}

// Print Trail lines are the items whose product sits in a shipping profile
// served by a Print Trail shipping method on this order, including claim and
// exchange replacements (marked). Medusa fulfilments aren't used: they exist
// only from dispatch.
export function allPrintTrailLines(order: GraphOrder, defaultMethod: string): ScopedLine[] {
  const methodByProfile = new Map<string, string>()
  for (const sm of order.shipping_methods ?? []) {
    const option = sm?.shipping_option
    if (option?.provider_id !== PRINT_TRAIL_PROVIDER_ID || !option.shipping_profile_id) {
      continue
    }
    const method = typeof option.data?.method === "string" ? option.data.method : defaultMethod
    methodByProfile.set(option.shipping_profile_id, method)
  }

  const replacements = replacementSources(order)
  const lines: ScopedLine[] = []
  for (const item of order.items ?? []) {
    const profile = item?.variant?.product?.shipping_profile?.id
    const method = profile ? methodByProfile.get(profile) : undefined
    // A number, a decimal string or a BigNumber. A fractional quantity is
    // kept, so the send blocks on it (input-limits.ts) instead of dropping
    // the line.
    const quantity = Number(item?.detail?.quantity ?? 0)
    if (!item || !method || !(quantity > 0)) {
      continue
    }
    lines.push({
      lineItemId: item.id,
      sku: item.variant ? resolveSku(item.variant) : null,
      quantity,
      method,
      replacementOf: replacements.get(item.id) ?? null,
    })
  }
  return lines
}

// The order's own Print Trail lines (sequence 1): without claim and
// exchange replacements.
export function selectPrintTrailLines(order: GraphOrder, defaultMethod: string): SelectedLine[] {
  return allPrintTrailLines(order, defaultMethod)
    .filter((l) => !l.replacementOf)
    .map(({ replacementOf: _r, ...line }) => line)
}

export function hasPrintTrailMethod(order: Pick<GraphOrder, "shipping_methods">): boolean {
  return (order.shipping_methods ?? []).some(
    (sm) => sm?.shipping_option?.provider_id === PRINT_TRAIL_PROVIDER_ID
  )
}

export function paymentTotals(order: Pick<GraphOrder, "payment_collections">) {
  let captured = 0
  let refunded = 0
  for (const pc of order.payment_collections ?? []) {
    captured += Number(pc?.captured_amount ?? 0)
    refunded += Number(pc?.refunded_amount ?? 0)
  }
  return { captured, refunded }
}
