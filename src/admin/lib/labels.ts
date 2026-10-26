import type {
  DiagnosisCode,
  SettingsWarning,
  StockSyncNowView,
  WebhookAction,
  WebhookState,
  WebhookWarning,
} from "../../lib/admin-types"

// i18n keys (namespace printTrail) and badge colours for the codes the
// server sends. Server codes are never shown raw.

export type Label = { key: string; values?: Record<string, string> }
export type BadgeColor = "green" | "orange" | "red" | "blue" | "grey"

const ATTENTION_CODES = new Set([
  "pt-cancelled",
  "pt-draft-after-confirm",
  "pt-fulfilment-cancelled",
  "pt-order-missing",
  "pt-holding",
  "pt-back-order",
  "pt-partial",
  "pt-returned",
  "pt-fulfilment-returned",
  "pt-error",
  "pt-invalid",
  "pt-not-fulfillable",
  "pt-partially-fulfillable",
  "dispatch-mismatch",
  "medusa-fulfilment-failed",
  "medusa-complete-failed",
  "complete-manually",
  "dispatched-after-cancel",
  "reconcile-failed",
  "stock-shortfall",
  "cancel-failed",
  "cancel-too-late",
  "amend-refused",
  "amend-diverged",
  "amend-unsent-items",
  "refunded-not-cancelled",
  "return-before-dispatch",
  "no-pt-shipping-method",
  "pt-pre-order-inactive",
])

const BLOCK_CODES = new Set([
  "held",
  "no-pt-lines",
  "order-number-taken",
  "unmatched-skus",
  "conflict",
  "auth-failed",
  "channel-inactive",
  "over-limits",
  "address-incomplete",
  "shipping-method-unavailable",
  "invalid",
  "not-confirmable",
  "not-fulfillable",
  "pt-errors",
  "missing-lines",
  "order-canceled",
  "fully-refunded",
  "awaiting-payment",
  "no-pt-shipping-method",
  "target-refused",
  "stock-shortfall",
])

export function blockReasonKey(code: string): Label {
  const blocked = code.match(/^blocked:(.+)$/)
  if (blocked) return { key: "block.blocked", values: { reason: blocked[1] } }
  const rejected = code.match(/^rejected-(\d+)$/)
  if (rejected?.[1] === "403") return { key: "block.rejected403" }
  if (rejected) return { key: "block.rejected", values: { status: rejected[1] } }
  if (BLOCK_CODES.has(code)) return { key: `block.codes.${code}` }
  return { key: "block.unknown", values: { code } }
}

export function attentionKey(code: string): Label {
  const capped = code.match(/^retry-cap:(.+)$/)
  if (capped) return { key: "attention.retryCap", values: { action: capped[1] } }
  if (ATTENTION_CODES.has(code)) return { key: `attention.codes.${code}` }
  const fulfilment = code.match(/^pt-fulfilment-(.+)$/)
  if (fulfilment) return { key: "attention.ptFulfilment", values: { status: fulfilment[1] } }
  // A blocked send records its reason as the attention too.
  const block = blockReasonKey(code)
  if (block.key !== "block.unknown") return block
  return { key: "attention.unknown", values: { code } }
}

export const diagnosisKey = (code: DiagnosisCode) => `diagnosis.${code}`
export const webhookStateKey = (s: WebhookState) => `webhook.states.${s}`
export const webhookActionKey = (a: WebhookAction) => `webhook.actions.${a}`
export const secretSourceKey = (source: "print-trail" | "configured" | null) =>
  `settings.webhook.secretSource.${source ?? "none"}`
export const warningKey = (w: SettingsWarning | WebhookWarning) => `warnings.${w}`
export const refusalKey = (reason: string) => `order.refused.${reason}`
export const sendOutcomeKey = (outcome: string) => `order.outcome.${outcome}`
// The only Print Trail codes the server lets an admin dismiss are its final
// ones and a pre-order held on an inactive product, which stay dismissed
// until Print Trail's order changes.
export const dismissBodyKey = (code: string) =>
  code === "pt-pre-order-inactive"
    ? "order.dismissBodyPreOrderInactive"
    : code.startsWith("pt-")
      ? "order.dismissBodyPrintTrail"
      : "order.dismissBody"

const GREEN = new Set(["complete", "dispatched", "fulfillable"])
const BLUE = new Set(["draft", "queued", "scheduled", "processing"])
const ORANGE = new Set(["holding", "back-order", "partial", "partially-fulfillable"])
const RED = new Set(["cancelled", "error", "invalid", "failed", "not-fulfillable"])

export function statusColor(status: string | null): BadgeColor {
  if (!status) return "grey"
  if (GREEN.has(status)) return "green"
  if (BLUE.has(status)) return "blue"
  if (ORANGE.has(status)) return "orange"
  if (RED.has(status)) return "red"
  return "grey"
}

const CHECK_COLORS: Record<string, BadgeColor> = {
  matched: "green",
  "pre-order": "blue",
  inactive: "orange",
  "not-found": "red",
  "no-sku": "orange",
  error: "grey",
}

export function checkBadge(check: { status: string } | null, current: boolean): { key: string; color: BadgeColor } {
  if (!check || !current) return { key: "variant.check.checking", color: "blue" }
  return { key: `variant.check.${check.status in CHECK_COLORS ? check.status : "error"}`, color: CHECK_COLORS[check.status] ?? "grey" }
}

// A back-order order whose every back-order fulfilment only waits for its pre-order
// release (Print Trail API 1.3.0): shown as waiting, not as an orange back-order.
export function onlyWaitingForRelease(row: { status: string | null; fulfilments: { status: string; back_order: string | null }[] }): boolean {
  const backOrders = row.fulfilments.filter((f) => f.status === "back-order")
  return row.status === "back-order" && backOrders.length > 0 && backOrders.every((f) => f.back_order === "pre-order")
}

// "Sync stock now": the toast for each result. A failure's reason is the
// summary without describeStockResult's "failed: ".
export function stockSyncToast(view: StockSyncNowView): Label & { variant: "success" | "info" | "error" } {
  if (view.status === "completed") return { variant: "success", key: "settings.sku.syncNow.completed", values: { summary: view.summary } }
  if (view.status === "failed") {
    return { variant: "error", key: "settings.sku.syncNow.failed", values: { reason: view.summary.replace(/^failed: /, "") } }
  }
  return { variant: "info", key: `settings.sku.syncNow.${view.status}` }
}

// The button's tooltip while the stock sync is turned off.
export const stockSyncUnavailableKey = "settings.sku.syncNow.unavailable"
