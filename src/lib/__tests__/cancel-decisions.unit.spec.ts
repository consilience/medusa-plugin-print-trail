import { resolvePluginOptions } from "../../config"
import { PrintTrailApiError } from "../../modules/printTrail/client/errors"
import type { PtOrder } from "../../modules/printTrail/client/types"
import { buildCancelTooLateNotifications, interpretCancel, settlement } from "../cancel-decisions"

const err = (status: number, detail = "nope", body: unknown = { status, detail }) =>
  new PrintTrailApiError(detail, status, body, "PUT", "/orders/u/cancel", detail)

const tracking = [{ carrier: "Royal Mail", trackingNumber: "JD1", trackingUrl: "https://track/JD1" }]
const pt = (status: string, fulfilments: { status: string; tracking?: boolean }[]): PtOrder => ({
  uuid: "u1",
  status,
  fulfilments: fulfilments.map((f, i) => ({
    uuid: `f${i}`,
    fulfilmentNumber: `F-${i}`,
    status: f.status,
    trackingDetails: f.tracking ? tracking : [],
  })),
})

describe("interpretCancel", () => {
  it("reads 200, 202 and the plain errors", () => {
    expect(interpretCancel({ status: 200, order: pt("cancelled", []) }, null)).toEqual({ kind: "cancelled" })
    expect(interpretCancel({ status: 202, order: pt("processing", []) }, null)).toEqual({ kind: "awaiting" })
    expect(interpretCancel(err(503), null)).toMatchObject({ kind: "transient" })
    expect(interpretCancel(err(0), null)).toMatchObject({ kind: "transient" })
    expect(interpretCancel(err(401), null)).toEqual({ kind: "auth-failed" })
    expect(interpretCancel(err(404), null)).toMatchObject({ kind: "not-found" })
    expect(interpretCancel(err(400, "bad"), null)).toEqual({ kind: "refused", detail: "bad" })
  })

  it("API 1.2.0: an inactive channel is its own refusal; another 403 is refused with its detail", () => {
    expect(interpretCancel(err(403, "inactive", { type: "https://docs.printtrail.com/channel-api/problems/channel-inactive", title: "Channel inactive", status: 403, detail: "This channel is inactive in Print Trail." }), null)).toEqual({ kind: "channel-inactive" })
    expect(interpretCancel(err(403, "Standard channel"), null)).toEqual({ kind: "refused", detail: "Standard channel" })
  })

  it("a 428 with a dispatched fulfilment is too late and names it", () => {
    const d = interpretCancel(err(428), pt("partial", [{ status: "dispatched", tracking: true }, { status: "processing" }]))
    expect(d).toEqual({
      kind: "too-late",
      why: "dispatched",
      fulfilments: [
        { uuid: "f0", number: "F-0", status: "dispatched", tracking: [{ number: "JD1", url: "https://track/JD1", carrier: "Royal Mail" }] },
        { uuid: "f1", number: "F-1", status: "processing", tracking: [] },
      ],
    })
    const partial = interpretCancel(err(428), pt("cancelled", [{ status: "dispatched" }, { status: "cancelled" }]))
    expect(partial).toMatchObject({ kind: "too-late", why: "partial" })
    expect(interpretCancel(err(428), pt("complete", []))).toMatchObject({ kind: "too-late", why: "complete" })
  })

  it("a 428 on an order Print Trail already cancelled is not too late", () => {
    expect(interpretCancel(err(428), pt("cancelled", [{ status: "cancelled" }]))).toEqual({ kind: "already-cancelled" })
  })

  it("a 428 on a failed order is refused, not too late", () => {
    const d = interpretCancel(err(428), pt("failed", [{ status: "failed" }]))
    expect(d.kind).toBe("refused")
    expect((d as { detail: string }).detail).toContain("failed")
    expect(interpretCancel(err(428), null).kind).toBe("refused")
  })
})

describe("settlement", () => {
  const asked = { cancel_requested: true, cancel_status: "awaiting" }

  it("settlement waits while Print Trail is still cancelling", () => {
    expect(settlement(asked, pt("processing", [{ status: "processing" }]))).toEqual({ kind: "none" })
    expect(settlement(asked, pt("cancelled", [{ status: "cancelled" }]))).toEqual({ kind: "cancelled" })
    // Nothing asked of Print Trail, or already settled: nothing to do.
    expect(settlement({ cancel_requested: false }, pt("complete", [{ status: "dispatched" }]))).toEqual({ kind: "none" })
    expect(settlement({ cancel_requested: true, cancel_status: "too-late" }, pt("complete", [{ status: "dispatched" }]))).toEqual({ kind: "none" })
    expect(settlement({ cancel_requested: true, cancel_status: "cancelled" }, pt("cancelled", []))).toEqual({ kind: "none" })
  })

  it("settlement flags a partial cancel as too late", () => {
    expect(settlement(asked, pt("cancelled", [{ status: "dispatched" }, { status: "cancelled" }]))).toMatchObject({
      kind: "too-late",
      why: "partial",
    })
    expect(settlement(asked, pt("complete", [{ status: "dispatched" }]))).toMatchObject({ kind: "too-late", why: "dispatched" })
  })
})

describe("buildCancelTooLateNotifications", () => {
  const options = resolvePluginOptions({
    baseUrl: "https://api.example",
    appUrl: "https://app.example",
    adminUrl: "https://admin.example/app",
    notifications: { adminEmail: "a@shop.test, b@shop.test" },
  })
  const input = {
    options,
    orderId: "order_1",
    displayId: 1001,
    rowId: "ptord_1",
    ptOrderNumber: "ORD-1001",
    ptUrl: "https://app.example/acme/orders/u1",
    why: "dispatched",
    fulfilments: [{ uuid: "f0", number: "F-0", status: "dispatched", tracking: [] }],
  }

  it("builds one email per admin address with the order link", () => {
    const out = buildCancelTooLateNotifications(input)
    expect(out.map((n) => n.to)).toEqual(["a@shop.test", "b@shop.test"])
    expect(out[0]).toMatchObject({
      channel: "email",
      template: "print-trail-cancel-too-late",
      trigger_type: "print_trail.cancel_too_late",
      resource_type: "order",
      resource_id: "order_1",
      idempotency_key: "print-trail-cancel-too-late:ptord_1:a@shop.test",
      data: {
        order: { id: "order_1", display_id: 1001 },
        print_trail_order_number: "ORD-1001",
        pt_url: "https://app.example/acme/orders/u1",
        admin_order_url: "https://admin.example/app/orders/order_1",
        why: "dispatched",
        fulfilments: [{ number: "F-0", status: "dispatched", tracking: [] }],
      },
    })
  })

  it("carries the rendered email beside the template and data", () => {
    const [a, b] = buildCancelTooLateNotifications(input)
    expect(a.content).toEqual({
      subject: "Order #1001 was cancelled but has already shipped",
      html: expect.stringContaining('<a href="https://app.example/acme/orders/u1">ORD-1001</a>'),
      text: expect.stringContaining("Some or all of it has shipped."),
    })
    expect(a.content?.html).toContain('href="https://admin.example/app/orders/order_1"')
    expect(a.content?.html).toContain("F-0: dispatched (no tracking)")
    expect(b.content).toEqual(a.content)
    expect(a.template).toBe("print-trail-cancel-too-late")
    expect(a.data).toBeTruthy()
  })

  it("render: false sends template and data only", () => {
    const o = resolvePluginOptions({ ...options, notifications: { adminEmail: "a@shop.test", render: false } })
    const [n] = buildCancelTooLateNotifications({ ...input, options: o })
    expect("content" in n).toBe(false)
    expect(n).toMatchObject({ template: "print-trail-cancel-too-late", data: { why: "dispatched" } })
  })

  it("a comma-separated PRINT_TRAIL_ADMIN_EMAIL sends one email per address", () => {
    const o = resolvePluginOptions({ ...options, notifications: { adminEmail: " ops@shop.test,owner@shop.test , " } })
    expect(buildCancelTooLateNotifications({ ...input, options: o }).map((n) => n.to)).toEqual(["ops@shop.test", "owner@shop.test"])
  })

  it("sends nothing when the template is off, and no admin URL is null", () => {
    expect(buildCancelTooLateNotifications({ ...input, options: { ...options, notifications: { ...options.notifications, cancelTooLate: false } } })).toEqual([])
    const noAdmin = buildCancelTooLateNotifications({ ...input, options: { ...options, adminUrl: undefined } })
    expect(noAdmin[0].data?.admin_order_url).toBeNull()
  })
})

// API 1.3.0: an order only waiting for a pre-order release cancels with 200.
describe("interpretCancel with pre-order back-orders", () => {
  it("a 200 on a back-order order is cancelled", () => {
    const order = {
      uuid: "o1",
      status: "back-order",
      fulfilments: [{ uuid: "f1", status: "back-order", backOrderReason: "pre-order", sentToWarehouseAt: null }],
    }
    expect(interpretCancel({ status: 200, order }, null)).toEqual({ kind: "cancelled" })
  })
})
