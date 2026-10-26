import type { PrintTrailPluginOptions } from "../config"
import type { PtCreateOrderRequest } from "../modules/printTrail/client/types"
import type { GraphOrder, SelectedLine } from "./lines"
import { addressFingerprint } from "./order-scope"
import { buildCreatePayload } from "./payload"

// The send workflow's orderNumber and payload hooks: what a store's handler
// may change, and the fallbacks when it returns something unusable.

export type PreparedPayload =
  | { ok: true; payload: PtCreateOrderRequest; addressHash: string }
  | { ok: false; reason: "address-incomplete" | "no-pt-lines"; detail: string }

export function preparePayload(input: {
  order: Pick<GraphOrder, "id" | "email" | "metadata" | "shipping_address" | "billing_address">
  lines: SelectedLine[]
  orderNumber: string
  options: Pick<PrintTrailPluginOptions, "strictSkus" | "adminUrl">
}): PreparedPayload {
  const { order, options } = input
  const built = buildCreatePayload({
    orderNumber: input.orderNumber,
    strictSkus: options.strictSkus,
    shippingAddress: order.shipping_address,
    billingAddress: order.billing_address,
    email: order.email,
    note: typeof order.metadata?.note === "string" ? order.metadata.note : null,
    orderUrl: options.adminUrl ? `${options.adminUrl}/orders/${order.id}` : undefined,
    lines: input.lines,
  })
  if (!built.ok) {
    return built
  }
  // Fingerprinted before the payload hook, so a hook that rewrites the
  // address doesn't look like an address change.
  return { ok: true, payload: built.payload, addressHash: addressFingerprint(built.payload.shippingDetails) }
}

const MAX_ORDER_NUMBER = 100

// The orderNumber hook's result: a string, or { orderNumber }. Used only for
// a new row; anything unusable falls back to the default with a warning.
export function acceptOrderNumber(
  hookValue: unknown,
  fallback: string,
  takenByOtherRows: string[]
): { orderNumber: string; warning?: string } {
  if (hookValue === undefined) {
    return { orderNumber: fallback }
  }
  const raw =
    hookValue && typeof hookValue === "object" && "orderNumber" in hookValue
      ? (hookValue as { orderNumber: unknown }).orderNumber
      : hookValue
  const value = typeof raw === "string" ? raw.trim() : ""
  if (!value || value.length > MAX_ORDER_NUMBER) {
    return {
      orderNumber: fallback,
      warning: `the orderNumber hook returned an unusable order number; using ${fallback}`,
    }
  }
  if (takenByOtherRows.includes(value)) {
    return {
      orderNumber: fallback,
      warning: `the orderNumber hook returned ${value}, which another Print Trail order of this order already has; using ${fallback}`,
    }
  }
  return { orderNumber: value }
}

const HOOK_FIELDS = ["shippingDetails", "purchaseOrder", "printTrailOrderNumber", "orderUrl"] as const

// The payload hook's result: { payload } or the fields themselves. It may
// change the address, the purchase order, the Print Trail number and the
// order URL; the plugin's number, lines, uuid and flags always win.
export function mergePayloadOverride(
  prepared: PtCreateOrderRequest,
  override: unknown
): { payload: PtCreateOrderRequest; warning?: string } {
  if (override === undefined || override === null) {
    return { payload: prepared }
  }
  if (typeof override !== "object" || Array.isArray(override)) {
    return { payload: prepared, warning: "the payload hook returned something other than an object; it was ignored" }
  }
  const source = ("payload" in override ? (override as { payload: unknown }).payload : override) as Record<string, unknown>
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    return { payload: prepared, warning: "the payload hook returned something other than an object; it was ignored" }
  }
  const payload: PtCreateOrderRequest = { ...prepared }
  for (const key of HOOK_FIELDS) {
    if (key in source && source[key] !== undefined) {
      ;(payload as Record<string, unknown>)[key] = source[key]
    }
  }
  delete payload.requestedShippingMethod
  return { payload }
}
