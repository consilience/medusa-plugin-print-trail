import type { Logger } from "@medusajs/framework/types"
import { z } from "@medusajs/framework/zod"
import { verifySignature } from "./signature"
import { matchPrintTrailOrder } from "./sync-decisions"

// The POST /hooks/print-trail handler, free of Express so it can be driven by
// the mock's signed deliveries. It verifies, validates, looks the order up
// locally and emits; the subscriber does the work. Never patches from the
// payload: the sync re-fetches the order.

export const PRINT_TRAIL_WEBHOOK_EVENT = "print_trail.webhook.received"
export const PRINT_TRAIL_COPY_SEEN_EVENT = "print_trail.order.copy_seen"
// The stock sync subscribes; the receiver never touches stock.
export const PRINT_TRAIL_STOCK_CHANGED_EVENT = "print_trail.stock.changed"

// activated_skus (API 1.3.0): the SKU of each item whose status is active. Only
// a product becoming active releases its pre-orders; an inactive one keeps them
// held as pre-order. Print Trail doesn't say what it was before, so every
// active item is listed. Only a hint which waiting orders to re-read; nothing
// is patched.
// held_skus: each item on pre-order or inactive, with that status. Print
// Trail holds its back-orders as pre-order, and an out-of-stock one switches
// to pre-order with no order webhook.
export type HeldSku = { sku: string; status: "pre-order" | "inactive" }
export type StockChangedEventData = { changed_at: string | null; activated_skus: string[]; held_skus?: HeldSku[] }

function stockItems(products: unknown): { sku: string; status: unknown }[] {
  if (!Array.isArray(products)) return []
  return products.flatMap((p) => {
    if (!p || typeof p !== "object") return []
    const { sku, status } = p as { sku?: unknown; status?: unknown }
    return typeof sku === "string" && sku ? [{ sku, status }] : []
  })
}

export function activatedSkus(products: unknown): string[] {
  return [...new Set(stockItems(products).filter((p) => p.status === "active").map((p) => p.sku))]
}

export function heldSkus(products: unknown): HeldSku[] {
  const out = new Map<string, HeldSku>()
  for (const { sku, status } of stockItems(products)) {
    if (status === "pre-order" || status === "inactive") out.set(sku, { sku, status })
  }
  return [...out.values()]
}
export type WebhookEventData = {
  print_trail_order_id: string
  order_id: string
  notification_type: string
  pt_uuid_hint?: string
}
export type CopySeenEventData = {
  print_trail_order_id: string
  order_id: string
  copy_uuid: string
  copy_order_number: string
}

export const ORDER_NOTIFICATION_TYPES: readonly string[] = [
  "order-created",
  "order-status-updated",
  "order-fulfillable-status-updated",
  "fulfilment-status-updated",
  "fulfilment-tracking-created",
]

// Under Print Trail's 5-second delivery timeout. With Redis down, emit hangs
// rather than throws.
export const EMIT_TIMEOUT_MS = 3000

export const webhookPayloadSchema = z.looseObject({
  notificationType: z.string().min(1),
  orderUuid: z.string().optional(),
  orderNumber: z.string().nullable().optional(),
  changedAt: z.string().optional(),
})

export type WebhookDeps = {
  // The stored secret (and the previous one during a rotation), or the
  // configured fallback: readWebhookSecrets.
  secrets: string[]
  emit(msg: { name: string; data: unknown }): Promise<void>
  find: Parameters<typeof matchPrintTrailOrder>[1]
  logger: Pick<Logger, "info" | "warn" | "error" | "debug">
  emitTimeoutMs?: number
}

export type WebhookReply = { status: 200 | 202 | 400 | 401 | 503; body: Record<string, unknown> }

const ACCEPTED: WebhookReply = { status: 202, body: { status: "accepted" } }
const IGNORED: WebhookReply = { status: 200, body: { status: "ignored" } }
const UNSIGNED: WebhookReply = { status: 401, body: { message: "Invalid signature" } }

async function emitWithin(deps: WebhookDeps, msg: { name: string; data: unknown }): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), deps.emitTimeoutMs ?? EMIT_TIMEOUT_MS)
  })
  try {
    return await Promise.race([deps.emit(msg).then(() => true as const), timeout])
  } catch (e) {
    deps.logger.error(`Print Trail webhook: couldn't queue ${msg.name}: ${(e as Error).message}`)
    return false
  } finally {
    clearTimeout(timer)
  }
}

export async function handlePrintTrailWebhook(
  req: { rawBody: Buffer | string | undefined; signature: string | undefined },
  deps: WebhookDeps
): Promise<WebhookReply> {
  // 1. Fail closed: the HMAC is the only authentication.
  if (!deps.secrets.some(Boolean)) {
    deps.logger.warn(
      "Print Trail webhook rejected: no webhook secret yet. Press Test connection on Settings → Print Trail to fetch it, or set PRINT_TRAIL_WEBHOOK_SECRET."
    )
    return UNSIGNED
  }
  if (req.rawBody === undefined || req.rawBody === null || !verifySignature(req.rawBody, req.signature, deps.secrets)) {
    return UNSIGNED
  }

  // 2. Shape, checked only after the signature.
  let json: unknown
  try {
    json = JSON.parse(req.rawBody.toString())
  } catch {
    return { status: 400, body: { message: "Body is not JSON" } }
  }
  const parsed = webhookPayloadSchema.safeParse(json)
  if (!parsed.success) {
    return { status: 400, body: { message: "notificationType is required" } }
  }
  const payload = parsed.data
  const type = payload.notificationType
  const queue = async (name: string, data: unknown) =>
    (await emitWithin(deps, { name, data }))
      ? ACCEPTED
      : ({ status: 503, body: { message: "Couldn't queue the webhook" } } as WebhookReply)

  // 3. Stock: a full sync, never a patch from the payload.
  if (type === "stock-level-updated") {
    return queue(PRINT_TRAIL_STOCK_CHANGED_EVENT, {
      changed_at: payload.changedAt ?? null,
      activated_skus: activatedSkus(payload.products),
      held_skus: heldSkus(payload.products),
    } satisfies StockChangedEventData)
  }
  if (!ORDER_NOTIFICATION_TYPES.includes(type)) {
    deps.logger.info(`Print Trail webhook: ignoring notification type ${type}`)
    return IGNORED
  }
  if (!payload.orderUuid) {
    return { status: 400, body: { message: "orderUuid is required" } }
  }

  // 4. Only orders this store knows; the row lookup is a local indexed read.
  const match = await matchPrintTrailOrder({ uuid: payload.orderUuid, orderNumber: payload.orderNumber }, deps.find)
  switch (match.kind) {
    case "row":
    case "adopt":
      return queue(PRINT_TRAIL_WEBHOOK_EVENT, {
        print_trail_order_id: match.row.id,
        order_id: match.row.order_id,
        notification_type: type,
        ...(match.kind === "adopt" ? { pt_uuid_hint: payload.orderUuid } : {}),
      } satisfies WebhookEventData)
    case "copy":
      return queue(PRINT_TRAIL_COPY_SEEN_EVENT, {
        print_trail_order_id: match.row.id,
        order_id: match.row.order_id,
        copy_uuid: payload.orderUuid,
        copy_order_number: match.copyNumber,
      } satisfies CopySeenEventData)
    default:
      deps.logger.info(
        `Print Trail webhook: ignoring ${type} for unknown order ${payload.orderUuid} (${payload.orderNumber ?? "no number"}): ${match.why}`
      )
      return IGNORED
  }
}
