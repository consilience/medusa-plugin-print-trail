import { resolvePluginOptions } from "../../../config"
import { readDismissed } from "../../sync-decisions"
import type { PrintTrailOrderRow } from "../../send-flow"
import {
  buildOrderView,
  canDismiss,
  dismissColumns,
  fulfilmentRows,
  planResend,
  resetColumns,
  sendOutcome,
  startedFulfilments,
} from "../order-view"

const options = resolvePluginOptions({ baseUrl: "https://api.printtrail.com", orderNumberPrefix: "ORD-" })
const now = new Date("2026-10-19T12:00:00Z")
const health = { reconnect: false, channelInactive: false, unmatchedSkus: 0 }

const row = (over: Partial<PrintTrailOrderRow> = {}): PrintTrailOrderRow => ({
  id: "ptord_1",
  order_id: "order_1",
  sequence: 1,
  pt_order_number: "ORD-7",
  pt_uuid: "uuid-1",
  status: "queued",
  confirmed_at: "2026-10-19T10:00:00Z",
  attempts: {},
  fulfilments: [],
  ...over,
})

const fulfilment = (status: string, over: Record<string, unknown> = {}) => ({
  uuid: `f-${status}`,
  fulfilmentNumber: `F-${status}`,
  status,
  productionMethod: "print",
  supplierLocation: { code: "UK1", name: "Leeds" },
  requestedShippingMethod: "tracked",
  trackingDetails: [],
  ...over,
})

const view = (rows: PrintTrailOrderRow[], over: Record<string, unknown> = {}) =>
  buildOrderView({
    order: { id: "order_1", display_id: 7, canceled: false, hasPtShippingMethod: true },
    rows,
    events: [],
    options,
    teamCode: "acme",
    health,
    now,
    ...over,
  } as never)

describe("order view", () => {
  it("builds one block per row, each with its own Print Trail link", () => {
    const v = view([
      row({ id: "ptord_2", sequence: 2, pt_order_number: "ORD-7-2", pt_uuid: "uuid-2", source_ref: "claim:c1" }),
      row(),
    ])
    expect(v.rows.map((r) => r.sequence)).toEqual([1, 2])
    expect(v.rows.map((r) => r.pt_url)).toEqual([
      "https://app.printtrail.com/acme/orders/uuid-1",
      "https://app.printtrail.com/acme/orders/uuid-2",
    ])
    expect(v.rows[1].source_ref).toBe("claim:c1")
    expect(v.expected).toBe(false)
    expect(v.next_pt_order_number).toBe("ORD-7-3")
  })

  it("shows the order number as plain text without a uuid or team code", () => {
    expect(view([row({ pt_uuid: null })]).rows[0].pt_url).toBeNull()
    expect(view([row()], { teamCode: null }).rows[0].pt_url).toBeNull()
  })

  it("lists started fulfilments in the cancel warning", () => {
    const r = row({ fulfilments: [fulfilment("processing"), fulfilment("draft"), fulfilment("cancelled")] })
    expect(startedFulfilments(r).map((f) => f.status)).toEqual(["processing"])
    expect(view([r]).rows[0].cancel_warning?.map((f) => f.uuid)).toEqual(["f-processing"])
    expect(view([r], { order: { id: "order_1", display_id: 7, canceled: true, hasPtShippingMethod: true } }).rows[0].cancel_warning).toBeNull()
    expect(view([{ ...r, cancel_status: "too-late" }]).rows[0].cancel_warning).toBeNull()
    expect(view([{ ...r, status: "cancelled" }]).rows[0].cancel_warning).toBeNull()
    expect(view([row({ fulfilments: [fulfilment("draft")] })]).rows[0].cancel_warning).toBeNull()
  })

  it("maps fulfilments with location, method and tracking links", () => {
    expect(
      fulfilmentRows([
        fulfilment("dispatched", {
          trackingDetails: [
            { trackingNumber: "JD1", trackingUrl: "https://track/JD1", carrier: "Royal Mail" },
            { number: "JD2", url: null, courier: "DPD" },
            { carrier: "nobody" },
          ],
        }),
        fulfilment("queued", { supplierLocation: { code: "US1", name: null }, fulfilmentNumber: null }),
      ])
    ).toEqual([
      {
        uuid: "f-dispatched",
        number: "F-dispatched",
        location: "Leeds",
        productionMethod: "print",
        status: "dispatched",
        shippingMethod: "tracked",
        tracking: [
          { number: "JD1", url: "https://track/JD1", carrier: "Royal Mail" },
          { number: "JD2", url: null, carrier: "DPD" },
        ],
        back_order: null,
        product_inactive: false,
        publication_date: null,
      },
      { uuid: "f-queued", number: null, location: "US1", productionMethod: "print", status: "queued", shippingMethod: "tracked", tracking: [], back_order: null, product_inactive: false, publication_date: null },
    ])
    expect(fulfilmentRows(null)).toEqual([])
    expect(fulfilmentRows({})).toEqual([])
  })

  it("orders the timeline newest first and links each entry", () => {
    const events = [
      { id: "e1", created_at: "2026-10-19T09:00:00Z", kind: "sent", message: "Sent", print_trail_order_id: "ptord_1", data: null },
      { id: "e2", created_at: new Date("2026-10-19T11:00:00Z"), kind: "cancel-too-late", message: "Too late", print_trail_order_id: "ptord_1", data: { pt_url: "https://elsewhere/x" } },
      { id: "e3", created_at: "2026-10-19T10:00:00Z", kind: "note", message: "No row", print_trail_order_id: null, data: null },
    ]
    const v = view([row()], { events })
    expect(v.timeline.map((e) => e.id)).toEqual(["e2", "e3", "e1"])
    expect(v.timeline[0]).toEqual({
      id: "e2",
      at: "2026-10-19T11:00:00.000Z",
      kind: "cancel-too-late",
      message: "Too late",
      pt_order_number: "ORD-7",
      pt_url: "https://elsewhere/x",
    })
    expect(v.timeline[1]).toMatchObject({ pt_order_number: null, pt_url: null })
    expect(v.timeline[2].pt_url).toBe("https://app.printtrail.com/acme/orders/uuid-1")
    const many = Array.from({ length: 120 }, (_, i) => ({ id: `m${i}`, created_at: new Date(i * 1000), kind: "k", message: "m" }))
    expect(view([row()], { events: many }).timeline).toHaveLength(100)
  })

  it("expects a row when the order has a Print Trail method but nothing was sent", () => {
    expect(view([]).expected).toBe(true)
    expect(view([]).next_pt_order_number).toBe("ORD-7")
    expect(view([], { order: { id: "order_1", display_id: 7, canceled: false, hasPtShippingMethod: false } }).expected).toBe(false)
  })
})

describe("planResend", () => {
  const ctx = { asNew: false, orderCanceled: false, now }

  it("plans a resend for each case", () => {
    expect(planResend("order_1", null, ctx)).toEqual({ kind: "send", input: { order_id: "order_1" }, reset: null })
    expect(planResend("order_1", null, { ...ctx, orderCanceled: true })).toEqual({ kind: "refused", reason: "order-canceled" })

    const capped = (a: string, over: Partial<PrintTrailOrderRow> = {}) =>
      planResend("order_1", row({ attention: `retry-cap:${a}`, confirmed_at: null, ...over }), ctx)
    expect(capped("send")).toEqual({ kind: "send", input: { order_id: "order_1", sequence: 1 }, reset: { kind: "capped", action: "send" } })
    expect(capped("confirm")).toEqual({ kind: "send", input: { order_id: "order_1", sequence: 1 }, reset: { kind: "capped", action: "confirm" } })
    expect(capped("cancel", { cancel_status: "failed" })).toEqual({ kind: "cancel", reset: { kind: "capped", action: "cancel" } })
    expect(capped("amend")).toEqual({ kind: "amend", reset: { kind: "capped", action: "amend" } })
    expect(capped("refetch", { cancel_status: "cancelled" })).toEqual({ kind: "refetch", reset: { kind: "capped", action: "refetch" } })
    expect(capped("send", { cancel_status: "requested" })).toEqual({ kind: "refused", reason: "cancelled-in-medusa" })
    expect(planResend("order_1", row({ attention: "retry-cap:send", confirmed_at: null }), { ...ctx, orderCanceled: true })).toEqual({
      kind: "refused",
      reason: "order-canceled",
    })

    expect(planResend("order_1", row({ cancel_status: "awaiting" }), ctx)).toEqual({ kind: "refused", reason: "cancelled-in-medusa" })
    expect(planResend("order_1", row({ confirmed_at: null }), { ...ctx, orderCanceled: true })).toEqual({ kind: "refused", reason: "order-canceled" })
    expect(planResend("order_1", row({ status: "cancelled", confirmed_at: null }), ctx)).toEqual({ kind: "refused", reason: "print-trail-cancelled" })
    expect(planResend("order_1", row(), ctx)).toEqual({ kind: "refused", reason: "already-confirmed" })
    expect(planResend("order_1", row({ confirmed_at: null, status: "draft", block_reason: "unmatched-skus" }), ctx)).toEqual({
      kind: "send",
      input: { order_id: "order_1", sequence: 1 },
      reset: { kind: "send-attempts" },
    })
  })

  it("offers Resend as a new order only after a Print Trail cancel", () => {
    const asNew = { ...ctx, asNew: true }
    expect(planResend("order_1", row({ sequence: 2, status: "cancelled" }), asNew)).toEqual({
      kind: "reissue",
      input: { order_id: "order_1", reissue_of: 2 },
    })
    expect(planResend("order_1", row({ status: "cancelled", cancel_status: "cancelled" }), asNew)).toEqual({
      kind: "refused",
      reason: "not-cancelled-at-print-trail",
    })
    expect(planResend("order_1", row(), asNew)).toEqual({ kind: "refused", reason: "not-cancelled-at-print-trail" })
    expect(planResend("order_1", row({ status: "cancelled" }), { ...asNew, reissued: true })).toEqual({ kind: "refused", reason: "already-reissued" })
    expect(planResend("order_1", row({ status: "cancelled" }), { ...asNew, orderCanceled: true })).toEqual({ kind: "refused", reason: "order-canceled" })

    const v = view([row({ status: "cancelled" }), row({ id: "ptord_2", sequence: 2, pt_uuid: null, confirmed_at: null, status: null })])
    expect(v.rows[0].actions).toEqual({ refresh: true, resend: false, resend_as_new: true, dismiss: false })
    expect(v.rows[1].actions).toEqual({ refresh: false, resend: true, resend_as_new: false, dismiss: false })
    const reissued = view([row({ status: "cancelled" }), row({ id: "ptord_3", sequence: 3, source_ref: "reissue:1" })])
    expect(reissued.rows[0].actions.resend_as_new).toBe(false)
  })
})

describe("retry resets", () => {
  it("resets a capped action only while the row is still capped on it", () => {
    const capped = row({ attention: "retry-cap:cancel", cancel_status: "failed", attempts: { cancel: 3, refetch: 1 }, confirmed_at: "x" })
    expect(resetColumns(capped, { kind: "capped", action: "cancel" }, now)).toEqual({
      attention: null,
      attempts: { cancel: 0, refetch: 1 },
      cancel_status: "requested",
      pending_action: "cancel",
      next_attempt_at: now,
    })
    expect(resetColumns({ ...capped, attention: null }, { kind: "capped", action: "cancel" }, now)).toBeNull()
    // Due now: if Resend's follow-up can't run (a busy lock, a throw), the
    // sweep still sends it.
    expect(resetColumns(row({ attention: "retry-cap:send", attempts: { send: 3 } }), { kind: "capped", action: "send" }, now)).toEqual({
      attention: null,
      attempts: { send: 0 },
      pending_action: "send",
      next_attempt_at: now,
    })
    expect(resetColumns(row({ attention: "retry-cap:confirm", attempts: { confirm: 4 } }), { kind: "capped", action: "confirm" }, now)).toMatchObject({
      pending_action: "confirm",
      next_attempt_at: now,
    })
    expect(resetColumns(row({ attention: "retry-cap:refetch", attempts: { refetch: 4 } }), { kind: "capped", action: "refetch" }, now)).toMatchObject({
      pending_action: "refetch",
      next_attempt_at: now,
    })
    expect(resetColumns(row({ attention: "retry-cap:amend", attempts: { amend: 3 } }), { kind: "capped", action: "amend" }, now)).toEqual({
      attention: null,
      attempts: { amend: 0 },
      pending_action: "amend",
      next_attempt_at: now,
    })
  })

  it("gives a plain resend fresh send and confirm attempts, leaving the rest", () => {
    const r = row({ confirmed_at: null, pending_action: "send", attempts: { send: 2, confirm: 1, refetch: 2 } })
    // Zeros, not deleted keys: the service update merges JSON objects.
    expect(resetColumns(r, { kind: "send-attempts" }, now)).toEqual({ attempts: { send: 0, confirm: 0, refetch: 2 } })
    expect(resetColumns({ ...r, confirmed_at: "x" }, { kind: "send-attempts" }, now)).toBeNull()
    expect(resetColumns({ ...r, attempts: { refetch: 2 } }, { kind: "send-attempts" }, now)).toEqual({})
    expect(resetColumns({ ...r, attempts: { send: 0, refetch: 2 } }, { kind: "send-attempts" }, now)).toEqual({})
  })
})

describe("dismissing attention", () => {
  it("dismisses only codes nothing clears on its own", () => {
    for (const code of ["dispatch-mismatch", "complete-manually", "cancel-too-late", "cancel-failed", "amend-refused", "amend-diverged", "amend-unsent-items", "refunded-not-cancelled", "return-before-dispatch", "no-pt-shipping-method", "dispatched-after-cancel", "reconcile-failed"]) {
      expect(canDismiss(code)).toBe(true)
    }
    for (const code of ["retry-cap:send", "pt-cancelled", "pt-draft-after-confirm", "pt-holding", "pt-back-order", "pt-fulfilment-cancelled", "pt-order-missing", "stock-shortfall", "medusa-fulfilment-failed", null]) {
      expect(canDismiss(code)).toBe(false)
    }
    expect(view([row({ attention: "dispatch-mismatch" })]).rows[0].actions.dismiss).toBe(true)
  })

  it("dismisses Print Trail's final codes", () => {
    for (const code of ["pt-returned", "pt-fulfilment-returned", "pt-partial", "pt-fulfilment-failed"]) {
      expect(canDismiss(code)).toBe(true)
      expect(view([row({ attention: code })]).rows[0].actions.dismiss).toBe(true)
    }
  })

  it("remembers every final Print Trail state on the order the admin resolved, added to what's remembered", () => {
    const fulfilments = [
      { uuid: "u1", fulfilmentNumber: "F1", status: "failed" },
      { uuid: "u2", fulfilmentNumber: "F2", status: "dispatched" },
      { uuid: "u3", fulfilmentNumber: "F3", status: "failed" },
      { uuid: "u4", fulfilmentNumber: "F4", status: "returned" },
      { uuid: "u5", fulfilmentNumber: "F5", status: "holding" },
    ]
    const r = row({ attention: "pt-fulfilment-failed", status: "processing", fulfilments })
    const columns = dismissColumns(r, "pt-fulfilment-failed")
    expect(columns?.attention).toBeNull()
    // A hold isn't final, so it isn't remembered.
    expect(readDismissed({ ...r, ...columns })).toEqual([
      "pt-fulfilment-failed:F1",
      "pt-fulfilment-failed:F3",
      "pt-fulfilment-returned:F4",
    ])
    // A returned order, as Print Trail has it: every parcel returned too.
    const returned = row({
      attention: "pt-returned",
      status: "returned",
      fulfilments: [
        { uuid: "u1", fulfilmentNumber: "F1", status: "returned" },
        { uuid: "u2", fulfilmentNumber: "F2", status: "returned" },
      ],
      dismissed_attention: columns!.dismissed_attention,
    })
    expect(readDismissed({ ...returned, ...dismissColumns(returned, "pt-returned") })).toEqual([
      "pt-fulfilment-failed:F1",
      "pt-fulfilment-failed:F3",
      "pt-fulfilment-returned:F4",
      "pt-returned",
      "pt-fulfilment-returned:F1",
      "pt-fulfilment-returned:F2",
    ])
    expect(dismissColumns(row({ attention: "pt-partial", status: "partial" }), "pt-fulfilment-failed")).toBeNull()
    // complete-manually is remembered by its code; other codes write no memory.
    const manual = row({ attention: "complete-manually" })
    expect(readDismissed({ ...manual, ...dismissColumns(manual, "complete-manually") })).toEqual(["complete-manually"])
    expect(dismissColumns(row({ attention: "cancel-failed" }), "cancel-failed")).toEqual({ attention: null })
  })

  it("clears the code only when the row still has it", () => {
    expect(dismissColumns(row({ attention: "complete-manually" }), "complete-manually")).toEqual({ attention: null, dismissed_attention: "uuid-1|complete-manually" })
    expect(dismissColumns(row({ attention: "pt-holding" }), "complete-manually")).toBeNull()
    expect(dismissColumns(row({ attention: "retry-cap:send" }), "retry-cap:send")).toBeNull()
  })
})

describe("send outcome for the admin", () => {
  const create = (outcome: string, over: Record<string, unknown> = {}) => ({ outcome, blockReason: null, ...over }) as never
  it("reports what the send really did", () => {
    expect(sendOutcome({ create: create("draft"), gate: { ok: true }, confirm: { outcome: "confirmed" } as never })).toEqual({ outcome: "confirmed" })
    expect(sendOutcome({ create: create("adopted-confirmed"), gate: { ok: false, reason: "already-confirmed" }, confirm: null })).toEqual({ outcome: "confirmed" })
    expect(sendOutcome({ create: create("draft"), gate: { ok: false, reason: "awaiting-payment" }, confirm: null })).toEqual({
      outcome: "not-confirmed",
      reason: "awaiting-payment",
    })
    expect(sendOutcome({ create: create("blocked", { blockReason: "unmatched-skus" }), gate: { ok: false, reason: "blocked:unmatched-skus" }, confirm: null })).toEqual({
      outcome: "blocked",
      reason: "unmatched-skus",
    })
    expect(sendOutcome({ create: create("draft"), gate: { ok: true }, confirm: { outcome: "shipping-unavailable" } as never })).toEqual({
      outcome: "blocked",
      reason: "shipping-method-unavailable",
    })
    expect(sendOutcome({ create: create("draft"), gate: { ok: true }, confirm: { outcome: "stock" } as never })).toEqual({ outcome: "retrying", reason: "stock-shortfall" })
    expect(sendOutcome({ create: create("transient"), gate: { ok: false, reason: "transient" }, confirm: null })).toEqual({ outcome: "retrying" })
    expect(sendOutcome({ create: create("held"), gate: { ok: false, reason: "held" }, confirm: null })).toEqual({ outcome: "held" })
    // The attention code, so the toast uses its "stopped retrying" label.
    expect(sendOutcome({ create: create("retry-capped", { cappedAction: "confirm" }), gate: { ok: false, reason: "retry-capped" }, confirm: null })).toEqual({
      outcome: "blocked",
      reason: "retry-cap:confirm",
    })
    expect(sendOutcome({ create: create("retry-capped"), gate: { ok: false, reason: "retry-capped" }, confirm: null })).toEqual({
      outcome: "blocked",
      reason: "retry-cap:send",
    })
    expect(sendOutcome({ create: create("remote-cancelled"), gate: { ok: false, reason: "pt-cancelled" }, confirm: null })).toEqual({ outcome: "not-sent", reason: "pt-cancelled" })
  })
})

// API 1.3.0: fulfilments waiting for a pre-order release.
describe("pre-order fulfilments", () => {
  const lines = (...dates: (string | null | undefined)[]) =>
    dates.map((d, i) => ({ lineNumber: `l${i}`, quantity: 1, product: { sku: `P${i}`, activeState: "pre-order", ...(d === undefined ? {} : { publicationDate: d }) } }))

  it("marks a waiting fulfilment with its publication date", () => {
    const [f] = fulfilmentRows([fulfilment("back-order", { backOrderReason: "pre-order", sentToWarehouseAt: null, orderLines: lines("2026-11-01", "2026-12-01", null) })])
    expect(f).toMatchObject({ status: "back-order", back_order: "pre-order", publication_date: "2026-12-01" })
  })

  it("a waiting fulfilment without a known date", () => {
    const [f] = fulfilmentRows([fulfilment("back-order", { backOrderReason: "pre-order", orderLines: lines(undefined, null) })])
    expect(f).toMatchObject({ back_order: "pre-order", publication_date: null })
    // The activeState fallback when Print Trail sends no reason.
    expect(fulfilmentRows([fulfilment("back-order", { orderLines: lines("2026-12-01") })])[0].back_order).toBe("pre-order")
  })

  it("an out-of-stock back-order isn't waiting", () => {
    const [f, g, h] = fulfilmentRows([
      fulfilment("back-order", { backOrderReason: "out-of-stock", orderLines: lines("2026-12-01") }),
      fulfilment("back-order", { backOrderReason: "warehouse" }),
      fulfilment("processing", { backOrderReason: null }),
    ])
    expect(f.back_order).toBe("out-of-stock")
    expect(g.back_order).toBe("warehouse")
    expect(h).toMatchObject({ back_order: null, publication_date: null })
  })

  // A product set inactive while orders wait.
  it("a waiting fulfilment whose product isn't active says so", () => {
    const inactive = [{ lineNumber: "l0", quantity: 1, product: { sku: "P0", activeState: "inactive" } }]
    const [f, g, h] = fulfilmentRows([
      fulfilment("back-order", { backOrderReason: "pre-order", orderLines: [...lines("2026-12-01"), ...inactive] }),
      fulfilment("back-order", { backOrderReason: "pre-order", orderLines: lines("2026-12-01") }),
      fulfilment("back-order", { backOrderReason: "out-of-stock", orderLines: inactive }),
    ])
    expect(f).toMatchObject({ back_order: "pre-order", product_inactive: true })
    expect(g.product_inactive).toBe(false)
    expect(h.product_inactive).toBe(false)
  })

  it("the inactive-product attention is dismissable and remembered apart from Print Trail's final states", () => {
    const held = (n: string) => ({
      uuid: `u-${n}`,
      fulfilmentNumber: n,
      status: "back-order",
      backOrderReason: "pre-order",
      orderLines: [{ lineNumber: "l", quantity: 1, product: { sku: "P", activeState: "inactive" } }],
    })
    expect(canDismiss("pt-pre-order-inactive")).toBe(true)
    const r = row({ attention: "pt-pre-order-inactive", status: "processing", fulfilments: [held("F1"), held("F2"), fulfilment("returned")] })
    expect(view([r]).rows[0].actions.dismiss).toBe(true)
    const columns = dismissColumns(r, "pt-pre-order-inactive")
    expect(columns?.attention).toBeNull()
    expect(readDismissed({ ...r, ...columns })).toEqual(["pt-pre-order-inactive:F1", "pt-pre-order-inactive:F2"])
    // Resolving a final state doesn't resolve the inactive product.
    const returned = { ...r, attention: "pt-fulfilment-returned" }
    expect(readDismissed({ ...returned, ...dismissColumns(returned, "pt-fulfilment-returned") })).toEqual(["pt-fulfilment-returned:F-returned"])
  })

  it("a waiting fulfilment isn't listed as started", () => {
    const r = row({ fulfilments: [fulfilment("back-order", { backOrderReason: "pre-order", sentToWarehouseAt: null }), fulfilment("processing")] })
    expect(startedFulfilments(r).map((f) => f.status)).toEqual(["processing"])
    // No key at all: the reason decides.
    expect(startedFulfilments(row({ fulfilments: [fulfilment("back-order", { backOrderReason: "pre-order" })] }))).toEqual([])
    expect(view([row({ status: "back-order", fulfilments: [fulfilment("back-order", { backOrderReason: "pre-order", sentToWarehouseAt: null })] })]).rows[0].cancel_warning).toBeNull()
  })

  it("a held out-of-stock back-order isn't listed as started", () => {
    const r = row({ fulfilments: [fulfilment("back-order", { backOrderReason: "out-of-stock", sentToWarehouseAt: null }), fulfilment("processing", { sentToWarehouseAt: null })] })
    // The processing one is started whatever sentToWarehouseAt says.
    expect(startedFulfilments(r).map((f) => f.status)).toEqual(["processing"])
  })

  it("a warehouse back-order is listed as started", () => {
    const r = row({ fulfilments: [fulfilment("back-order", { backOrderReason: "warehouse", sentToWarehouseAt: "2026-10-19T09:00:00Z" })] })
    expect(startedFulfilments(r).map((f) => f.back_order)).toEqual(["warehouse"])
    expect(view([r]).rows[0].cancel_warning).toHaveLength(1)
  })
})
