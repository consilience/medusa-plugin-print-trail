import type { MockPrintTrail } from "../../../dev/mock-print-trail"
import { cancelRow, recordCancelTooLate, requestCancel, settleCancel, type CancelContext } from "../cancel-flow"
import { dueCancels } from "../sweep"
import {
  flowClient,
  flowOptions,
  MemoryStore,
  NOW,
  placeAtMock,
  RecordingNotifier,
  startFlowMock,
  TOKEN,
} from "./flow-fixtures"
import { PrintTrailClient } from "../../modules/printTrail/client/client"

let mock: MockPrintTrail
let store: MemoryStore
let notifier: RecordingNotifier
let ctx: CancelContext
let warn: jest.Mock

beforeEach(async () => {
  mock = await startFlowMock()
  store = new MemoryStore()
  notifier = new RecordingNotifier()
  warn = jest.fn()
  ctx = {
    store,
    client: flowClient(mock),
    options: flowOptions(mock),
    teamCode: "acme",
    notifier,
    logger: { warn, info: jest.fn() },
    order: { id: "order_1", display_id: 1001 },
    now: () => NOW,
  }
})

afterEach(() => mock.close())

const cancels = () => mock.state.requests.filter((r) => r.path.endsWith("/cancel"))
const asked = async (opts: Parameters<typeof placeAtMock>[2] = {}) => {
  const row = await placeAtMock(mock, store, opts)
  await requestCancel(store, [row], "order-canceled", NOW)
  return store.row(row.id)
}
const entry = (kind: string) => store.events.filter((e) => e.kind === kind)

describe("requestCancel", () => {
  it("requestCancel clears a pending send and leaves a settled cancel alone", async () => {
    const a = await store.createPrintTrailOrders({ order_id: "order_1", sequence: 1, pt_order_number: "ORD-1001", pending_action: "send", attempts: { send: 2, refetch: 1 } })
    const b = await store.createPrintTrailOrders({ order_id: "order_1", sequence: 2, pt_order_number: "ORD-1001-2", cancel_status: "cancelled", cancel_requested: true })
    const written = await requestCancel(store, [a, b], "order-canceled", NOW)
    expect(written).toEqual([a.id])
    expect(store.row(a.id)).toMatchObject({
      cancel_requested: true,
      cancel_status: "requested",
      pending_action: "cancel",
      next_attempt_at: NOW,
      attempts: { refetch: 1 },
    })
    expect(store.row(b.id).cancel_status).toBe("cancelled")
    expect(store.kinds()).toEqual(["cancel-requested"])
  })
})

describe("cancelRow", () => {
  it("cancels a confirmed order with 200 and records it", async () => {
    const row = await asked()
    const out = await cancelRow(ctx, row)
    expect(out.decision).toBe("cancelled")
    expect(store.row(row.id)).toMatchObject({ cancel_status: "cancelled", status: "cancelled", pending_action: null, next_attempt_at: null })
    expect(store.row(row.id).attempts).toEqual({ send: 0, confirm: 0, cancel: 0 })
    expect(mock.state.orders.get(row.pt_uuid!).status).toBe("cancelled")
    const [cancelled] = entry("cancelled")
    expect(cancelled.data).toMatchObject({ pt_uuid: row.pt_uuid, pt_url: `https://app.example/acme/orders/${row.pt_uuid}` })
    expect(out.events).toEqual([
      { name: "print_trail.order.cancelled", data: expect.objectContaining({ order_id: "order_1", initiated_by: "medusa" }) },
    ])
  })

  it("records awaiting on a 202 and schedules a refetch", async () => {
    const row = await asked()
    mock.setStatus(row.pt_uuid!, "processing")
    const out = await cancelRow(ctx, store.row(row.id))
    expect(out.decision).toBe("awaiting")
    expect(store.row(row.id)).toMatchObject({ cancel_status: "awaiting", pending_action: "refetch" })
    expect(store.kinds()).toEqual(["cancel-requested", "cancel-awaiting"])
  })

  it("settles a 202 cancel as cancelled from the next fetch", async () => {
    const row = await asked()
    mock.setStatus(row.pt_uuid!, "processing")
    await cancelRow(ctx, store.row(row.id))
    mock.settleCancel(row.pt_uuid!, "cancelled")
    const pt = await ctx.client.getOrder(row.pt_uuid!)
    await settleCancel(ctx, store.row(row.id), pt)
    expect(store.row(row.id).cancel_status).toBe("cancelled")
    expect(entry("cancelled")[0].message).toContain("Print Trail confirmed the cancel")
    expect(notifier.sent).toEqual([])
  })

  it("a 428 after dispatch notes, flags and emails the admin", async () => {
    const row = await asked()
    mock.dispatch(row.pt_uuid!)
    const out = await cancelRow(ctx, store.row(row.id))
    expect(out.decision).toBe("too-late")
    expect(store.row(row.id)).toMatchObject({ cancel_status: "too-late", attention: "cancel-too-late", pending_action: null, cancel_notified_at: NOW })
    const notes = entry("cancel-too-late")
    expect(notes).toHaveLength(1)
    expect(notes[0].data.pt_url).toBe(`https://app.example/acme/orders/${row.pt_uuid}`)
    expect(notes[0].message).toContain("ORD-1001")
    expect(notes[0].message).toContain("JD0002270060000000")
    expect(notifier.sent.map((n) => n.to)).toEqual(["ops@shop.test", "boss@shop.test"])
    expect(notifier.sent[0].data).toMatchObject({ pt_url: notes[0].data.pt_url, why: "dispatched" })
    expect(out.events.map((e) => e.name)).toEqual(["print_trail.order.attention"])
  })

  it("notes and emails once per row across cancel, webhook and reconcile", async () => {
    const row = await asked()
    mock.dispatch(row.pt_uuid!)
    await cancelRow(ctx, store.row(row.id))
    const pt = await ctx.client.getOrder(row.pt_uuid!)
    await settleCancel(ctx, store.row(row.id), pt)
    await settleCancel(ctx, store.row(row.id), pt)
    expect(entry("cancel-too-late")).toHaveLength(1)
    expect(notifier.sent).toHaveLength(2)
  })

  it("settles a 202 cancel that dispatched as too late, once", async () => {
    const row = await asked()
    mock.setStatus(row.pt_uuid!, "processing")
    await cancelRow(ctx, store.row(row.id))
    mock.settleCancel(row.pt_uuid!, "partial")
    const pt = await ctx.client.getOrder(row.pt_uuid!)
    await settleCancel(ctx, store.row(row.id), pt)
    await settleCancel(ctx, store.row(row.id), pt)
    expect(store.row(row.id)).toMatchObject({ cancel_status: "too-late", attention: "cancel-too-late" })
    expect(entry("cancel-too-late")).toHaveLength(1)
    expect(notifier.sent).toHaveLength(2)
  })

  it("keeps the note when the email fails", async () => {
    notifier.fail = true
    const row = await asked()
    mock.dispatch(row.pt_uuid!)
    await cancelRow(ctx, store.row(row.id))
    expect(entry("cancel-too-late")).toHaveLength(1)
    expect(store.row(row.id).cancel_notified_at).toEqual(NOW)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("couldn't send the cancel-too-late email"))
  })

  it("warns when no admin email is set", async () => {
    ctx.options = flowOptions(mock, { notifications: { adminEmail: [] } })
    const row = await asked()
    mock.dispatch(row.pt_uuid!)
    await cancelRow(ctx, store.row(row.id))
    expect(entry("cancel-too-late")).toHaveLength(1)
    expect(notifier.sent).toEqual([])
    expect(warn).toHaveBeenCalledWith("Print Trail: cancel too late for order order_1, but notifications.adminEmail is not set")
  })

  it("sends no email when cancelTooLate is false", async () => {
    ctx.options = flowOptions(mock, { notifications: { cancelTooLate: false } })
    const row = await asked()
    mock.dispatch(row.pt_uuid!)
    await cancelRow(ctx, store.row(row.id))
    expect(entry("cancel-too-late")).toHaveLength(1)
    expect(notifier.sent).toEqual([])
    expect(warn).not.toHaveBeenCalled()
  })

  it("a cancel refused for the token or an inactive channel stays requested, uncounted, and goes through once access returns", async () => {
    const row = await asked()
    const refusals = [
      { status: 401, body: { type: "about:blank", title: "Unauthorized", status: 401, detail: "Unauthenticated." }, attention: "auth-failed" },
      { status: 403, body: { type: "https://docs.printtrail.com/channel-api/problems/channel-inactive", title: "Channel inactive", status: 403, detail: "inactive" }, attention: "channel-inactive" },
    ]
    // More refusals than the cap allows: none counts.
    for (let i = 0; i < 4; i++) {
      const r = refusals[i % 2]
      mock.fail(/\/cancel$/, r.status, r.body, 1)
      const out = await cancelRow(ctx, store.row(row.id))
      expect(out.decision).toBe("transient")
      expect(store.row(row.id)).toMatchObject({
        cancel_status: "requested",
        pending_action: "cancel",
        attention: r.attention,
        next_attempt_at: new Date("2026-10-19T12:15:00Z"),
      })
      expect(store.row(row.id).attempts?.cancel ?? 0).toBe(0)
    }
    expect(entry("cancel-waiting").length).toBeGreaterThan(0)
    expect(entry("cancel-refused")).toHaveLength(0)
    // Due for the sweep once its time comes.
    expect(dueCancels([store.row(row.id)], new Date("2026-10-19T12:15:00Z"))).toEqual([row.order_id])
    // Access is back.
    expect((await cancelRow(ctx, store.row(row.id))).decision).toBe("cancelled")
    expect(store.row(row.id)).toMatchObject({ cancel_status: "cancelled", attention: null })
  })

  it("a deferral never overwrites attention another flow owns", async () => {
    const row = await asked()
    await store.updatePrintTrailOrders({ id: row.id, attention: "pt-order-missing" })
    mock.fail(/\/cancel$/, 403, { type: "https://docs.printtrail.com/channel-api/problems/channel-inactive", title: "Channel inactive", status: 403, detail: "inactive" }, 1)
    await cancelRow(ctx, store.row(row.id))
    expect(store.row(row.id)).toMatchObject({ cancel_status: "requested", pending_action: "cancel", attention: "pt-order-missing" })
    expect(entry("cancel-waiting")).toHaveLength(0)
    // The cancel goes through later; attention a cancel doesn't settle stays.
    await cancelRow(ctx, store.row(row.id))
    expect(store.row(row.id)).toMatchObject({ cancel_status: "cancelled", attention: "pt-order-missing" })
  })

  it("a cancel kept back by the client's Retry-After pause costs no attempt", async () => {
    const row = await asked()
    ctx.client = new PrintTrailClient({ baseUrl: mock.url, channelId: "acme-medusa1", apiToken: TOKEN, retryDelays: [], rateLimitGate: { until: Date.now() + 90_000 } })
    expect((await cancelRow(ctx, store.row(row.id))).decision).toBe("transient")
    expect(cancels()).toHaveLength(0)
    expect(store.row(row.id)).toMatchObject({ cancel_status: "requested", pending_action: "cancel" })
    expect(store.row(row.id).attempts?.cancel ?? 0).toBe(0)
    // Due when the pause ends (NOW is the flow clock), not the usual 15 minutes.
    const due = new Date(store.row(row.id).next_attempt_at as Date).getTime() - NOW.getTime()
    expect(due).toBeGreaterThan(80_000)
    expect(due).toBeLessThanOrEqual(90_000)
  })

  it("retries a transient cancel and stops at 3", async () => {
    const row = await asked()
    mock.fail(/\/cancel$/, 503, { message: "down" }, 99)
    await cancelRow(ctx, store.row(row.id))
    expect(store.row(row.id)).toMatchObject({
      cancel_status: "requested",
      pending_action: "cancel",
      next_attempt_at: new Date("2026-10-19T12:15:00Z"),
      attempts: { cancel: 1 },
    })
    await cancelRow(ctx, store.row(row.id))
    const last = await cancelRow(ctx, store.row(row.id))
    expect(last.decision).toBe("transient")
    expect(store.row(row.id)).toMatchObject({ cancel_status: "failed", attention: "retry-cap:cancel", pending_action: null })
    expect(entry("cancel-failed")).toHaveLength(1)
    // A capped row is never tried again.
    expect((await cancelRow(ctx, store.row(row.id))).decision).toBe("skipped")
  })

  it("stops a cancel whose runs keep dying before recording", async () => {
    const row = await asked()
    await store.updatePrintTrailOrders({ id: row.id, attempts: { cancel: 3 } })
    const out = await cancelRow(ctx, store.row(row.id))
    expect(out.decision).toBe("transient")
    expect(store.row(row.id)).toMatchObject({ cancel_status: "failed", attention: "retry-cap:cancel" })
    expect(cancels()).toHaveLength(0)
  })

  it("notes a 404 and does not retry", async () => {
    const row = await asked()
    mock.fail(/\/cancel$/, 404, { type: "about:blank", title: "Not Found", status: 404, detail: "No such order" })
    const out = await cancelRow(ctx, store.row(row.id))
    expect(out.decision).toBe("not-found")
    expect(store.row(row.id)).toMatchObject({ cancel_status: "refused", attention: "cancel-failed", pending_action: null })
    expect(entry("cancel-refused")[0].message).toContain("No such order")
  })

  it("finds an order whose uuid was never stored and cancels it", async () => {
    const placed = await placeAtMock(mock, store)
    const uuid = placed.pt_uuid
    await store.updatePrintTrailOrders({ id: placed.id, pt_uuid: null, status: null })
    await requestCancel(store, [store.row(placed.id)], "order-canceled", NOW)
    const out = await cancelRow(ctx, store.row(placed.id))
    expect(out.decision).toBe("cancelled")
    expect(store.row(placed.id)).toMatchObject({ pt_uuid: uuid, cancel_status: "cancelled" })
    expect(mock.state.orders.get(uuid!).status).toBe("cancelled")
  })

  it("marks a row with nothing at Print Trail as not sent", async () => {
    const row = await store.createPrintTrailOrders({ order_id: "order_1", sequence: 1, pt_order_number: "ORD-9999", attempts: {} })
    await requestCancel(store, [row], "order-canceled", NOW)
    const out = await cancelRow(ctx, store.row(row.id))
    expect(out.decision).toBe("not-sent")
    expect(store.row(row.id)).toMatchObject({ cancel_status: "not-sent", pending_action: null })
    expect(entry("cancelled")[0].message).toContain("Nothing was sent to Print Trail")
    expect(cancels()).toHaveLength(0)
  })

  it("makes no call for a row Print Trail has already cancelled", async () => {
    const row = await placeAtMock(mock, store)
    await store.updatePrintTrailOrders({ id: row.id, status: "cancelled" })
    await requestCancel(store, [store.row(row.id)], "order-canceled", NOW)
    expect((await cancelRow(ctx, store.row(row.id))).decision).toBe("cancelled")
    expect(cancels()).toHaveLength(0)
  })
})

describe("the sweep's cancel pass", () => {
  it("cancel that misses the lock is run by the sweep", async () => {
    const row = await placeAtMock(mock, store)
    // The workflow stored the intent, then timed out on the lock.
    await requestCancel(store, [row], "order-canceled", NOW)
    expect(cancels()).toHaveLength(0)
    const due = dueCancels(await store.listPrintTrailOrders({ cancel_status: "requested" }), NOW)
    expect(due).toEqual(["order_1"])
    for (const orderId of due) {
      for (const r of await store.listPrintTrailOrders({ order_id: orderId, cancel_status: "requested" })) {
        await cancelRow(ctx, r)
      }
    }
    expect(mock.state.orders.get(row.pt_uuid!).status).toBe("cancelled")
    expect(store.row(row.id).cancel_status).toBe("cancelled")
  })
})

describe("a 428 without the order", () => {
  it("retries a 428 it can't read the order for, rather than refusing", async () => {
    const row = await asked()
    mock.dispatch(row.pt_uuid!)
    mock.fail(new RegExp(`/orders/${row.pt_uuid}$`), 503, { message: "down" }, 99)
    const out = await cancelRow(ctx, store.row(row.id))
    expect(out.decision).toBe("transient")
    expect(store.row(row.id)).toMatchObject({ cancel_status: "requested", pending_action: "cancel" })
  })
})

describe("stale attention", () => {
  it("a cancel clears stale send and refund attention", async () => {
    for (const attention of ["stock-shortfall", "retry-cap:confirm", "refunded-not-cancelled"]) {
      store.rows = []
      const row = await asked({ orderNumber: `ORD-${attention}` })
      await store.updatePrintTrailOrders({ id: row.id, attention })
      await cancelRow(ctx, store.row(row.id))
      expect(store.row(row.id)).toMatchObject({ cancel_status: "cancelled", attention: null })
    }
  })

  it("keeps attention a cancel doesn't settle", async () => {
    const row = await asked()
    await store.updatePrintTrailOrders({ id: row.id, attention: "dispatch-mismatch" })
    await cancelRow(ctx, store.row(row.id))
    expect(store.row(row.id).attention).toBe("dispatch-mismatch")
  })
})

describe("recordCancelTooLate", () => {
  it("reads the row itself, so a stale copy can't note or email twice", async () => {
    const row = await asked()
    const stale = { ...store.row(row.id) }
    // Another path recorded it (its entry write then failed, say).
    await store.updatePrintTrailOrders({ id: row.id, cancel_notified_at: NOW, cancel_status: "too-late" })
    const out = await recordCancelTooLate(ctx, { ...stale }, { kind: "too-late", why: "dispatched", fulfilments: [] })
    expect(out.recorded).toBe(false)
    expect(entry("cancel-too-late")).toHaveLength(0)
    expect(notifier.sent).toEqual([])
  })
})

describe("settled cancels", () => {
  it("a cancelled snapshot with a dispatched fulfilment is too late and keeps its lines", async () => {
    const row = await asked({ lines: [{ lineNumber: "item_a", sku: "978-A", quantity: 1 }, { lineNumber: "item_u", sku: "US-1", quantity: 1 }] })
    mock.setStatus(row.pt_uuid!, "processing")
    mock.settleCancel(row.pt_uuid!, "partial")
    const pt = await ctx.client.getOrder(row.pt_uuid!)
    await store.updatePrintTrailOrders({ id: row.id, status: pt.status, fulfilments: pt.fulfilments })
    const out = await cancelRow(ctx, store.row(row.id))
    expect(out.decision).toBe("too-late")
    expect(store.row(row.id).cancel_status).toBe("too-late")
    expect(entry("cancel-too-late")).toHaveLength(1)
    expect(cancels()).toHaveLength(0)
  })

  it("an emptied row whose cancel settles schedules the release of re-added lines", async () => {
    ctx.orderCanceled = false
    const row = await placeAtMock(mock, store)
    await requestCancel(store, [row], "no-pt-lines", NOW)
    await cancelRow(ctx, store.row(row.id))
    expect(store.row(row.id)).toMatchObject({ cancel_status: "cancelled", pending_action: "amend", next_attempt_at: NOW })
  })

  it("a 202 that settles cancelled schedules the release too, but not for a cancelled order", async () => {
    ctx.orderCanceled = false
    const row = await placeAtMock(mock, store)
    await requestCancel(store, [row], "no-pt-lines", NOW)
    mock.setStatus(row.pt_uuid!, "processing")
    await cancelRow(ctx, store.row(row.id))
    mock.settleCancel(row.pt_uuid!, "cancelled")
    await store.updatePrintTrailOrders({ id: row.id, pending_action: null, next_attempt_at: null })
    await settleCancel(ctx, store.row(row.id), await ctx.client.getOrder(row.pt_uuid!))
    expect(store.row(row.id)).toMatchObject({ cancel_status: "cancelled", pending_action: "amend", next_attempt_at: NOW })

    ctx.orderCanceled = true
    store.rows = []
    const other = await asked({ orderNumber: "ORD-2001" })
    await cancelRow(ctx, store.row(other.id))
    expect(store.row(other.id)).toMatchObject({ cancel_status: "cancelled", pending_action: null })
  })
})

// API 1.3.0 (mock preOrderRelease on): held back-orders cancel at once.
describe("cancelling pre-order orders", () => {
  beforeEach(() => {
    mock.state.stock["PRE-1"] = 0
    mock.state.skuStatus["PRE-1"] = "pre-order"
  })

  it("cancelling an order waiting for release is a 200", async () => {
    const row = await asked({ lines: [{ lineNumber: "item_p", sku: "PRE-1", quantity: 1 }] })
    mock.setStatus(row.pt_uuid!, "back-order")
    const out = await cancelRow(ctx, store.row(row.id))
    expect(out.decision).toBe("cancelled")
    expect(store.row(row.id)).toMatchObject({ cancel_status: "cancelled", attention: null })
    expect(entry("cancel-too-late")).toEqual([])
    expect(notifier.sent).toEqual([])
  })

  it("cancelling a mixed order after a release is a 202 settled by sync", async () => {
    const row = await asked({
      lines: [
        { lineNumber: "item_a", sku: "978-A", quantity: 1 },
        { lineNumber: "item_p", sku: "PRE-1", quantity: 1 },
      ],
    })
    const o = mock.state.orders.get(row.pt_uuid!)
    mock.sendToWarehouse(row.pt_uuid!, o.fulfilments.findIndex((f: any) => f.status === "processing"))
    mock.state.stock["PRE-1"] = 1
    await mock.setSkuStatus("PRE-1", "active")
    const out = await cancelRow(ctx, store.row(row.id))
    expect(out.decision).toBe("awaiting")
    expect(store.row(row.id)).toMatchObject({ cancel_status: "awaiting", pending_action: "refetch" })
    mock.settleCancel(row.pt_uuid!, "cancelled")
    await settleCancel(ctx, store.row(row.id), await ctx.client.getOrder(row.pt_uuid!))
    expect(store.row(row.id).cancel_status).toBe("cancelled")
    expect(notifier.sent).toEqual([])
  })
})
