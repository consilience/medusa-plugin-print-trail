import fs from "node:fs"
import path from "node:path"
import {
  attentionKey,
  blockReasonKey,
  checkBadge,
  diagnosisKey,
  dismissBodyKey,
  refusalKey,
  sendOutcomeKey,
  statusColor,
  onlyWaitingForRelease,
  secretSourceKey,
  stockSyncToast,
  stockSyncUnavailableKey,
  warningKey,
  webhookActionKey,
  webhookStateKey,
} from "../labels"

const en = JSON.parse(fs.readFileSync(path.join(__dirname, "../../i18n/json/en.json"), "utf8"))
const has = (key: string) => key.split(".").reduce<unknown>((node, k) => (node as Record<string, unknown> | undefined)?.[k], en) !== undefined

// Every code the plugin sends to the admin.
const ATTENTION = [
  "retry-cap:send", "retry-cap:confirm", "retry-cap:cancel", "retry-cap:amend", "retry-cap:refetch",
  "pt-cancelled", "pt-draft-after-confirm", "pt-fulfilment-cancelled", "pt-order-missing",
  "pt-holding", "pt-back-order", "pt-partial", "pt-error", "pt-invalid", "pt-returned",
  "pt-fulfilment-holding", "pt-fulfilment-back-order", "pt-fulfilment-error", "pt-fulfilment-invalid", "pt-fulfilment-failed", "pt-fulfilment-returned",
  "pt-not-fulfillable", "pt-partially-fulfillable",
  "dispatch-mismatch", "medusa-fulfilment-failed", "medusa-complete-failed", "complete-manually", "dispatched-after-cancel",
  "reconcile-failed", "stock-shortfall", "cancel-failed", "cancel-too-late",
  "amend-refused", "amend-diverged", "amend-unsent-items", "refunded-not-cancelled", "return-before-dispatch",
  "no-pt-shipping-method", "pt-pre-order-inactive",
  // A blocked send sets the block reason as its attention too.
  "unmatched-skus", "order-number-taken", "conflict", "auth-failed", "channel-inactive", "rejected-422", "address-incomplete",
  "shipping-method-unavailable", "invalid", "not-confirmable", "not-fulfillable", "pt-errors", "missing-lines",
]
const BLOCK = [
  "held", "no-pt-lines", "order-number-taken", "unmatched-skus", "conflict", "auth-failed", "channel-inactive", "over-limits", "rejected-403", "rejected-409",
  "address-incomplete", "shipping-method-unavailable", "invalid", "not-confirmable", "not-fulfillable", "pt-errors",
  "missing-lines", "order-canceled", "fully-refunded", "awaiting-payment", "no-pt-shipping-method", "target-refused",
  "blocked:unmatched-skus",
]
const DIAGNOSIS = ["not-configured", "token-invalid", "channel-inactive", "channel-not-found", "not-print-trail", "token-other-channel", "unreachable", "error"] as const
const WEBHOOK_STATES = ["registered", "not-registered", "elsewhere", "unknown", "no-backend-url"] as const
const WEBHOOK_ACTIONS = ["registered", "already-registered", "needs-confirmation", "cannot-register", "invalid-url", "failed", "busy"] as const
const WARNINGS = [
  "not-configured", "no-webhook-secret", "webhook-secret-mismatch", "no-backend-url", "no-admin-url", "no-admin-email", "in-memory-locking",
  "postgres-locking", "postgres-locking-configured", "no-print-trail-shipping-options", "not-https", "local-address",
  "too-long", "credentials", "fragment", "undeliverable",
] as const
const REFUSALS = ["already-confirmed", "cancelled-in-medusa", "print-trail-cancelled", "not-cancelled-at-print-trail", "already-reissued", "order-canceled", "changed", "busy", "not-dismissable"]
const OUTCOMES = ["confirmed", "not-confirmed", "blocked", "retrying", "held", "not-sent", "done"]
const CHECKS = ["matched", "inactive", "pre-order", "not-found", "no-sku", "error"]

const SECRET_SOURCES = ["print-trail", "configured", null] as const

describe("labels", () => {
  it("has an English string for every code the server sends", () => {
    const missing = [
      ...ATTENTION.map((c) => attentionKey(c).key),
      ...BLOCK.map((c) => blockReasonKey(c).key),
      ...DIAGNOSIS.map(diagnosisKey),
      ...WEBHOOK_STATES.map(webhookStateKey),
      ...WEBHOOK_ACTIONS.map(webhookActionKey),
      ...WARNINGS.map(warningKey),
      ...REFUSALS.map(refusalKey),
      ...CHECKS.map((s) => checkBadge({ status: s }, true).key),
      ...OUTCOMES.map(sendOutcomeKey),
      ...SECRET_SOURCES.map(secretSourceKey),
      "order.dismissUnchanged",
      checkBadge(null, false).key,
      checkBadge({ status: "matched" }, false).key,
      attentionKey("something-new").key,
      blockReasonKey("something-new").key,
    ].filter((k) => !has(k))
    expect(missing).toEqual([])
    // Known codes never fall through to the unknown label.
    expect(ATTENTION.filter((c) => attentionKey(c).key === "attention.unknown")).toEqual([])
    expect(BLOCK.filter((c) => blockReasonKey(c).key === "block.unknown")).toEqual([])
  })

  it("says a dismissed Print Trail code stays cleared until Print Trail's order changes", () => {
    expect(dismissBodyKey("pt-returned")).toBe("order.dismissBodyPrintTrail")
    expect(dismissBodyKey("pt-fulfilment-failed")).toBe("order.dismissBodyPrintTrail")
    expect(dismissBodyKey("cancel-failed")).toBe("order.dismissBody")
    expect(dismissBodyKey("pt-pre-order-inactive")).toBe("order.dismissBodyPreOrderInactive")
    expect(has("order.dismissBodyPreOrderInactive")).toBe(true)
    expect(has("order.fulfilment.waitingInactive")).toBe(true)
    expect(has("order.dismissBodyPrintTrail")).toBe(true)
    expect(has("order.dismissBody")).toBe(true)
  })

  it("labels pattern codes with their values", () => {
    expect(attentionKey("retry-cap:amend")).toEqual({ key: "attention.retryCap", values: { action: "amend" } })
    expect(attentionKey("pt-fulfilment-holding")).toEqual({ key: "attention.ptFulfilment", values: { status: "holding" } })
    expect(attentionKey("pt-fulfilment-cancelled").key).toBe("attention.codes.pt-fulfilment-cancelled")
    expect(blockReasonKey("rejected-422")).toEqual({ key: "block.rejected", values: { status: "422" } })
    // A 403 (inactive team, Standard-channel token) is a manual block, and says so.
    expect(blockReasonKey("rejected-403")).toEqual({ key: "block.rejected403" })
    expect(blockReasonKey("blocked:held")).toEqual({ key: "block.blocked", values: { reason: "held" } })
    expect(attentionKey("rejected-422")).toEqual({ key: "block.rejected", values: { status: "422" } })
    expect(attentionKey("brand-new")).toEqual({ key: "attention.unknown", values: { code: "brand-new" } })
  })

  it("colours statuses", () => {
    expect(["complete", "dispatched", "fulfillable"].map(statusColor)).toEqual(["green", "green", "green"])
    expect(["draft", "queued", "scheduled", "processing"].map(statusColor)).toEqual(["blue", "blue", "blue", "blue"])
    expect(["holding", "back-order", "partial", "partially-fulfillable"].map(statusColor)).toEqual(["orange", "orange", "orange", "orange"])
    expect(["cancelled", "error", "invalid", "failed", "not-fulfillable"].map(statusColor)).toEqual(["red", "red", "red", "red", "red"])
    expect([null, "mystery"].map(statusColor)).toEqual(["grey", "grey"])
  })

  it("shows checking while the check isn't current", () => {
    expect(checkBadge({ status: "matched" }, false)).toEqual({ key: "variant.check.checking", color: "blue" })
    expect(checkBadge({ status: "matched" }, true)).toEqual({ key: "variant.check.matched", color: "green" })
    expect(checkBadge({ status: "not-found" }, true).color).toBe("red")
    expect(checkBadge(null, false)).toEqual({ key: "variant.check.checking", color: "blue" })
  })
})

// An order only waiting for its pre-order release isn't an
// orange back-order.
// "Sync stock now" on the settings page.
describe("stockSyncToast", () => {
  const STATUSES = ["completed", "deferred", "disabled", "dropped", "failed"] as const

  it("maps every status to a toast with an English string", () => {
    const toasts = STATUSES.map((status) => stockSyncToast({ status, summary: status === "failed" ? "failed: Print Trail said no" : "3 levels updated" }))
    expect(toasts.map((t) => t.variant)).toEqual(["success", "info", "info", "info", "error"])
    expect(toasts.map((t) => t.key).filter((k) => !has(k))).toEqual([])
    expect(new Set(toasts.map((t) => t.key)).size).toBe(STATUSES.length)
    expect(has(stockSyncUnavailableKey)).toBe(true)
    expect(has("settings.sku.syncNow.button")).toBe(true)
    expect(has("settings.sku.syncNow.requestFailed")).toBe(true)
  })

  it("carries the summary, and a failure's reason without its prefix", () => {
    expect(stockSyncToast({ status: "completed", summary: "3 levels updated" }).values).toEqual({ summary: "3 levels updated" })
    expect(stockSyncToast({ status: "failed", summary: "failed: Print Trail said no" }).values).toEqual({ reason: "Print Trail said no" })
    expect(en.settings.sku.syncNow.deferred).toBe("A stock sync is already running. This one runs after it, within one sweep.")
  })
})

describe("onlyWaitingForRelease", () => {
  const f = (back_order: string | null, status = back_order ? "back-order" : "dispatched") => ({ status, back_order }) as any
  it("is true for a back-order order whose every back-order waits", () => {
    expect(onlyWaitingForRelease({ status: "back-order", fulfilments: [f("pre-order"), f(null)] } as any)).toBe(true)
    expect(onlyWaitingForRelease({ status: "back-order", fulfilments: [f("pre-order"), f("out-of-stock")] } as any)).toBe(false)
    expect(onlyWaitingForRelease({ status: "back-order", fulfilments: [] } as any)).toBe(false)
    expect(onlyWaitingForRelease({ status: "queued", fulfilments: [f("pre-order")] } as any)).toBe(false)
  })
})
