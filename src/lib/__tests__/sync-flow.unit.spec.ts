import { startMockPrintTrail, type MockPrintTrail } from "../../../dev/mock-print-trail"
import { resolvePluginOptions } from "../../config"
import { PrintTrailClient } from "../../modules/printTrail/client/client"
import type { GraphOrder, SelectedLine } from "../lines"
import {
  checkGate,
  confirm,
  createDraft,
  recordOutcome,
  type PrintTrailOrderRow,
  type SendContext,
  type SendStore,
} from "../send-flow"
import type { CreateDispatch, DispatchOrder, Label } from "../sync-decisions"
import {
  complete,
  dispatch,
  flagReconcileFailure,
  isLockTimeout,
  recordCopySeen,
  refetch,
  scheduleRefetch,
  scheduleWaitingRefetches,
  type MedusaOrderPort,
  type SyncContext,
  type SyncStore,
} from "../sync-flow"
import { memoryPreOrderSeen } from "../pre-order"
import { dismissColumns } from "../admin/order-view"
import { readDismissed, writeDismissed } from "../sync-decisions"

const TOKEN = "sync-token"
const NOW = new Date("2026-10-19T12:00:00Z")

class MemoryStore implements SendStore, SyncStore {
  // The activation scan's record, as the service keeps it.
  seen = memoryPreOrderSeen()
  async markPreOrderSeen(skus: string[]) {
    await this.seen.markPreOrderSeen(skus)
  }
  rows: PrintTrailOrderRow[] = []
  events: Record<string, any>[] = []
  private n = 0

  async listPrintTrailOrders(filters: Record<string, unknown>) {
    return this.rows
      .filter((r) => Object.entries(filters).every(([k, v]) => (Array.isArray(v) ? v.includes(r[k]) : r[k] === v)))
      .map((r) => ({ ...r }))
  }
  async createPrintTrailOrders(data: Record<string, unknown>) {
    const row = { id: `ptord_${++this.n}`, sequence: 1, attempts: {}, confirmed_at: null, ...data } as PrintTrailOrderRow
    this.rows.push(row)
    return { ...row }
  }
  async updatePrintTrailOrders(data: Record<string, unknown>) {
    const row = this.rows.find((r) => r.id === data.id)!
    Object.assign(row, data)
    return { ...row }
  }
  async createPrintTrailOrderEvents(data: Record<string, unknown>[]) {
    this.events.push(...data)
    return data
  }
  async listPrintTrailOrderEvents(filters: Record<string, unknown>) {
    return this.events.filter((e) => Object.entries(filters).every(([k, v]) => e[k] === v)) as any
  }
  async ensureOrderLink() {}
  kinds() {
    return this.events.map((e) => e.kind)
  }
}

type FakeFulfillment = DispatchOrder["fulfillments"][number] & { items: { id: string; quantity: number }[] }

class FakePort implements MedusaOrderPort {
  order: DispatchOrder & { fulfillments: FakeFulfillment[] }
  calls: { method: string; args: unknown[] }[] = []
  private failing = new Set<string>()
  private n = 0

  constructor(items: DispatchOrder["items"]) {
    this.order = {
      id: "order_1",
      status: "pending",
      canceled_at: null,
      items,
      fulfillments: [],
      ptOptionIdByProfile: { sp_pt: "so_pt" },
    }
  }
  private always = new Set<string>()
  failNext(method: string) {
    this.failing.add(method)
  }
  failAlways(method: string) {
    this.always.add(method)
  }
  private record(method: string, args: unknown[]) {
    this.calls.push({ method, args })
    if (this.failing.delete(method) || this.always.has(method)) {
      throw new Error(`${method} refused`)
    }
  }
  count(method: string) {
    return this.calls.filter((c) => c.method === method).length
  }
  async loadDispatchOrder() {
    return JSON.parse(JSON.stringify(this.order)) as DispatchOrder
  }
  async createFulfilment(orderId: string, c: CreateDispatch) {
    this.record("createFulfilment", [orderId, c])
    const id = `ful_${++this.n}`
    this.order.fulfillments.push({ id, shipped_at: null, canceled_at: null, metadata: c.metadata, labels: [], items: c.items })
    for (const i of c.items) {
      this.order.items.find((x) => x.id === i.id)!.fulfilled_quantity += i.quantity
    }
    return { id }
  }
  async createShipment(orderId: string, fulfillmentId: string, items: { id: string; quantity: number }[], labels: Label[]) {
    this.record("createShipment", [orderId, fulfillmentId, items, labels])
    const f = this.order.fulfillments.find((x) => x.id === fulfillmentId)!
    f.shipped_at = NOW.toISOString()
    f.labels = labels.map((l, i) => ({ ...l, id: `${fulfillmentId}_lbl_${i}` }))
  }
  async addLabels(fulfillmentId: string, keep: { id: string }[], added: Label[]) {
    this.record("addLabels", [fulfillmentId, keep, added])
    const f = this.order.fulfillments.find((x) => x.id === fulfillmentId)!
    f.labels = [
      ...f.labels.filter((l) => keep.some((k) => k.id === l.id)),
      ...added.map((l, i) => ({ ...l, id: `${fulfillmentId}_lbl_late_${f.labels.length + i}` })),
    ]
  }
  async completeOrder(orderId: string) {
    this.record("completeOrder", [orderId])
    this.order.status = "completed"
  }
}

const address = {
  first_name: "Ada",
  last_name: "Lovelace",
  address_1: "1 Analytical St",
  city: "London",
  postal_code: "N1 1AA",
  country_code: "gb",
}

const graphOrder: GraphOrder = {
  id: "order_1",
  display_id: 1001,
  email: "ada@example.com",
  status: "pending",
  canceled_at: null,
  shipping_address: address,
  billing_address: null,
  payment_collections: [{ captured_amount: 0, refunded_amount: 0 }],
}

const line = (sku: string, quantity: number, id: string): SelectedLine => ({ lineItemId: id, sku, quantity, method: "standard" })

let mock: MockPrintTrail
let store: MemoryStore
let port: FakePort
let sendCtx: SendContext
let ctx: SyncContext

beforeEach(async () => {
  mock = await startMockPrintTrail({
    token: TOKEN,
    channelId: "acme-medusa1",
    skus: { "978-A": 10, "US-1": 5 },
    locations: { "US-1": "US1" },
  })
  store = new MemoryStore()
  const client = new PrintTrailClient({ baseUrl: mock.url, channelId: "acme-medusa1", apiToken: TOKEN, retryDelays: [0] })
  const options = resolvePluginOptions({
    baseUrl: mock.url,
    channelId: "acme-medusa1",
    apiToken: TOKEN,
    orderNumberPrefix: "ORD-",
    appUrl: "https://app.pt.example",
  })
  sendCtx = { store, client, options, now: () => NOW }
  port = new FakePort([
    { id: "item_a", quantity: 2, fulfilled_quantity: 0, shipping_profile_id: "sp_pt" },
    { id: "item_b", quantity: 1, fulfilled_quantity: 0, shipping_profile_id: "sp_pt" },
  ])
  ctx = { store, client, options, medusa: port, teamCode: "acme", now: () => NOW }
})

afterEach(() => mock.close())

// Sends and confirms through the send flow's steps: two fulfilments (UK1, US1).
async function placed(lines = [line("978-A", 2, "item_a"), line("US-1", 1, "item_b")]) {
  const create = await createDraft(sendCtx, { order: graphOrder, lines, sequence: 1 })
  const gate = await checkGate(sendCtx, graphOrder, create)
  const confirmed = gate.ok
    ? await confirm(sendCtx, { rowId: create.rowId!, pt: create.pt!, body: gate.body!, methodByLine: create.methodByLine })
    : null
  await recordOutcome(sendCtx, { orderId: "order_1", create, gate, confirm: confirmed })
  store.events = []
  const row = store.rows[0]
  return { row, uuid: row.pt_uuid! }
}

const rowOf = () => store.rows[0]

async function sync(source: "webhook" | "retry" | "reconcile" = "webhook", extra: { ptUuidHint?: string } = {}) {
  const r = await refetch(ctx, { rowId: rowOf().id, source, ...extra })
  const d = await dispatch(ctx, r)
  const c = await complete(ctx, r, d)
  return { r, d, c }
}

describe("refetch", () => {
  it("records the snapshot and one timeline entry per remote change", async () => {
    const { uuid } = await placed()
    mock.dispatch(uuid, 0)
    const { r } = await sync()
    expect(r.outcome).toBe("synced")
    const remote = mock.state.orders.get(uuid)
    expect(rowOf()).toMatchObject({ status: remote.status, last_synced_at: NOW })
    // The wire adds each line product's status and pre-order figures (API 1.3.0).
    expect(rowOf().fulfilments).toMatchObject(remote.fulfilments)
    const kinds = store.kinds()
    expect(kinds).toEqual(expect.arrayContaining(["pt-status", "pt-fulfilment-status", "pt-tracking"]))
    const tracking = store.events.find((e) => e.kind === "pt-tracking")!
    expect(tracking.data).toMatchObject({ pt_url: `https://app.pt.example/acme/orders/${uuid}`, pt_uuid: uuid })
  })

  it("flags a Print Trail cancel, never re-confirms, and emits cancelled", async () => {
    const { uuid } = await placed()
    mock.setStatus(uuid, "cancelled")
    const { r } = await sync()
    expect(rowOf().attention).toBe("pt-cancelled")
    expect(r.events).toContainEqual({
      name: "print_trail.order.cancelled",
      data: expect.objectContaining({ initiated_by: "print-trail", order_id: "order_1" }),
    })
    const before = mock.state.requests.length
    const again = await createDraft(sendCtx, { order: graphOrder, lines: [line("978-A", 2, "item_a")], sequence: 1 })
    expect(again.outcome).toBe("skip-confirmed")
    expect(mock.state.requests.slice(before).filter((q) => q.method === "POST")).toEqual([])
  })

  it("doesn't flag a Print Trail cancel once the order was re-sent as a new order", async () => {
    const { uuid } = await placed()
    mock.setStatus(uuid, "cancelled")
    await sync()
    expect(rowOf().attention).toBe("pt-cancelled")
    // A reissue row that never reached Print Trail (timed out, blocked,
    // capped) answers nothing: the original keeps its flag.
    const reissue = await store.createPrintTrailOrders({ order_id: "order_1", sequence: 2, pt_order_number: "ORD-1-2", source_ref: "reissue:1" })
    await sync()
    expect(rowOf().attention).toBe("pt-cancelled")
    // Once it has reached Print Trail, the original's flag goes.
    await store.updatePrintTrailOrders({ id: reissue.id, pt_uuid: "reissue-uuid" })
    await sync()
    expect(rowOf().attention).toBeNull()
  })

  it("says a cancel Medusa asked for was Medusa's", async () => {
    const { uuid } = await placed()
    await store.updatePrintTrailOrders({ id: rowOf().id, cancel_requested: true })
    mock.setStatus(uuid, "cancelled")
    const { r } = await sync()
    expect(rowOf().attention).toBeNull()
    expect(r.events.find((e) => e.name === "print_trail.order.cancelled")?.data.initiated_by).toBe("medusa")
  })

  it("flags draft after confirm (a Print Trail full edit)", async () => {
    const { uuid } = await placed()
    const confirmedAt = rowOf().confirmed_at
    mock.fullEdit(uuid)
    const { r } = await sync("reconcile")
    expect(rowOf()).toMatchObject({ attention: "pt-draft-after-confirm", confirmed_at: confirmedAt })
    expect(store.kinds()).toContain("pt-draft-after-confirm")
    expect(r.events).toContainEqual({
      name: "print_trail.order.attention",
      data: expect.objectContaining({ attention: "pt-draft-after-confirm" }),
    })
  })

  it("puts a shipping-method change on the timeline only", async () => {
    const { uuid } = await placed()
    mock.setShippingMethod(uuid, 0, "express")
    await sync()
    expect(store.kinds()).toEqual(["pt-shipping-method"])
    expect(rowOf().attention).toBeNull()
  })

  it("clears a stale sync attention but keeps a send block", async () => {
    const { uuid } = await placed()
    await store.updatePrintTrailOrders({ id: rowOf().id, attention: "pt-holding" })
    await sync()
    expect(rowOf().attention).toBeNull()
    await store.updatePrintTrailOrders({ id: rowOf().id, attention: "unmatched-skus" })
    mock.setStatus(uuid, "holding")
    await sync()
    expect(rowOf().attention).toBe("unmatched-skus")
  })

  it("schedules a refetch at +60 s when Print Trail can't be reached", async () => {
    const { uuid } = await placed()
    mock.fail(new RegExp(`/orders/${uuid}$`), 503, undefined, 9)
    const { r, d } = await sync()
    expect(r.outcome).toBe("transient")
    expect(d.created).toEqual([])
    expect(rowOf()).toMatchObject({
      pending_action: "refetch",
      next_attempt_at: new Date(NOW.getTime() + 60_000),
      attempts: { refetch: 1 },
    })
    expect(rowOf().last_error).toBeTruthy()
  })

  it("clears the refetch once it succeeds", async () => {
    await placed()
    await scheduleRefetch(store, rowOf().id, NOW)
    await sync("retry")
    expect(rowOf()).toMatchObject({ pending_action: null, next_attempt_at: null })
    expect(rowOf().attempts?.refetch ?? 0).toBe(0)
  })

  it("never schedules a refetch over a pending confirm", async () => {
    await placed()
    await store.updatePrintTrailOrders({ id: rowOf().id, pending_action: "confirm", next_attempt_at: NOW })
    expect(await scheduleRefetch(store, rowOf().id, NOW)).toBe(false)
    expect(rowOf()).toMatchObject({ pending_action: "confirm", next_attempt_at: NOW })
    // A successful refetch leaves the pending confirm alone too.
    await sync()
    expect(rowOf().pending_action).toBe("confirm")
  })

  it("caps refetch after three retries", async () => {
    await placed()
    for (let i = 0; i < 3; i++) await scheduleRefetch(store, rowOf().id, NOW)
    expect(rowOf().next_attempt_at).toEqual(new Date(NOW.getTime() + 900_000))
    await scheduleRefetch(store, rowOf().id, NOW)
    expect(rowOf()).toMatchObject({ pending_action: null, attention: "retry-cap:refetch", next_attempt_at: null })
    expect(store.kinds()).toEqual(["retry-capped"])
  })

  it("marks the order missing on a 404 and does not retry", async () => {
    const { uuid } = await placed()
    mock.state.orders.delete(uuid)
    const first = await sync()
    expect(first.r.outcome).toBe("not-found")
    expect(rowOf()).toMatchObject({ attention: "pt-order-missing", pending_action: null })
    await sync()
    expect(store.kinds()).toEqual(["pt-order-missing"])
  })

  it("adopts the uuid of our own order from a webhook hint", async () => {
    const { uuid } = await placed()
    await store.updatePrintTrailOrders({ id: rowOf().id, pt_uuid: null })
    const { r } = await sync("webhook", { ptUuidHint: uuid })
    expect(r.outcome).toBe("synced")
    expect(rowOf().pt_uuid).toBe(uuid)
  })

  it("refuses a hint whose order number differs", async () => {
    const { uuid } = await placed()
    const other = mock.copy(uuid)
    await store.updatePrintTrailOrders({ id: rowOf().id, pt_uuid: null })
    const { r } = await sync("webhook", { ptUuidHint: other })
    expect(r.outcome).toBe("hint-mismatch")
    expect(rowOf().pt_uuid).toBeNull()
    const none = await refetch(ctx, { rowId: rowOf().id, source: "webhook" })
    expect(none.outcome).toBe("no-uuid")
  })

  it("reports auth failure and retries it without counting an attempt", async () => {
    await placed()
    mock.fail(/\/orders\//, 401, { status: 401, title: "Unauthorized", detail: "Unauthenticated.", type: "about:blank" })
    const { r } = await sync()
    expect(r.outcome).toBe("auth-failed")
    expect(rowOf()).toMatchObject({ pending_action: "refetch", next_attempt_at: new Date(NOW.getTime() + 15 * 60_000) })
    expect(rowOf().attempts?.refetch ?? 0).toBe(0)
  })

  it("a fetch that works ends stale access attention, whatever settles the row", async () => {
    for (const attention of ["auth-failed", "channel-inactive"]) {
      const { uuid } = await placed()
      // A cancel waiting on access, which an admin then made in the Print Trail app.
      await store.updatePrintTrailOrders({ id: rowOf().id, attention, cancel_requested: true, cancel_status: "requested", pending_action: "cancel" })
      mock.setStatus(uuid, "cancelled")
      const { r } = await sync()
      expect(r.outcome).toBe("synced")
      expect(rowOf().attention).not.toBe(attention)
      store.rows = []
    }
  })

  it("keeps attention a fetch doesn't settle", async () => {
    await placed()
    await store.updatePrintTrailOrders({ id: rowOf().id, attention: "retry-cap:amend" })
    await sync()
    expect(rowOf().attention).toBe("retry-cap:amend")
  })

  it("reports an inactive channel (API 1.2.0) and retries it like an auth failure", async () => {
    await placed()
    mock.fail(/\/orders\//, 403, { type: "https://docs.printtrail.com/channel-api/problems/channel-inactive", title: "Channel inactive", status: 403, detail: "This channel is inactive in Print Trail." })
    const { r } = await sync()
    expect(r.outcome).toBe("channel-inactive")
    expect(rowOf()).toMatchObject({ pending_action: "refetch" })
    expect(rowOf().attempts?.refetch ?? 0).toBe(0)
  })
})

describe("dispatch", () => {
  it("dispatch creates a Medusa fulfilment and shipment per dispatched Print Trail fulfilment", async () => {
    const { uuid } = await placed()
    mock.dispatch(uuid, 0)
    const first = await sync()
    expect(port.count("createFulfilment")).toBe(1)
    const [, created] = port.calls.find((c) => c.method === "createFulfilment")!.args as [string, CreateDispatch]
    const ptFulfilment = mock.state.orders.get(uuid).fulfilments[0]
    expect(created).toMatchObject({
      shippingOptionId: "so_pt",
      items: [{ id: "item_a", quantity: 2 }],
      metadata: { print_trail_fulfilment_uuid: ptFulfilment.uuid, carrier: "Royal Mail" },
    })
    const [, , , labels] = port.calls.find((c) => c.method === "createShipment")!.args as [string, string, unknown, Label[]]
    expect(labels).toEqual([
      {
        tracking_number: "JD0002270060000000",
        tracking_url: "https://www.royalmail.com/track-your-item#/tracking-results/JD0002270060000000",
        label_url: "https://www.royalmail.com/track-your-item#/tracking-results/JD0002270060000000",
      },
    ])
    expect(first.d.events).toEqual([
      {
        name: "print_trail.order.dispatched",
        data: {
          order_id: "order_1",
          print_trail_order_id: rowOf().id,
          pt_uuid: uuid,
          pt_fulfilment_uuid: ptFulfilment.uuid,
          fulfillment_id: "ful_1",
          was_pre_order: false,
        },
      },
    ])
    mock.dispatch(uuid, 1)
    await sync()
    expect(port.count("createFulfilment")).toBe(2)
    expect(port.count("createShipment")).toBe(2)
  })

  it("dispatch is idempotent across repeated syncs", async () => {
    const { uuid } = await placed()
    mock.dispatch(uuid, 0)
    await sync("webhook")
    const entries = store.events.length
    await sync("reconcile")
    await sync("retry")
    expect(port.count("createFulfilment")).toBe(1)
    expect(port.count("createShipment")).toBe(1)
    expect(store.events.length).toBe(entries)
  })

  it("ships a fulfilment created by a run that died before shipping", async () => {
    const { uuid } = await placed()
    mock.dispatch(uuid, 0)
    port.failNext("createShipment")
    const first = await sync()
    expect(first.d.failures).toHaveLength(1)
    expect(rowOf().attention).toBe("medusa-fulfilment-failed")
    await sync()
    expect(port.count("createFulfilment")).toBe(1)
    expect(port.count("createShipment")).toBe(2)
    expect(port.order.fulfillments[0].shipped_at).toBeTruthy()
    expect(rowOf().attention).not.toBe("medusa-fulfilment-failed")
  })

  it("records a dispatch after the Medusa order was cancelled, without creating anything", async () => {
    const { uuid } = await placed()
    port.order.status = "canceled"
    port.order.canceled_at = NOW.toISOString()
    mock.dispatch(uuid, 0)
    await sync()
    await sync()
    expect(port.count("createFulfilment")).toBe(0)
    expect(port.count("createShipment")).toBe(0)
    expect(rowOf().attention).toBe("dispatched-after-cancel")
    expect(store.kinds().filter((k) => k === "dispatched-after-cancel")).toHaveLength(1)
  })

  it("adds tracking that arrives after dispatch", async () => {
    const { uuid } = await placed()
    mock.dispatch(uuid, 0, { tracking: false })
    await sync()
    expect(port.count("createShipment")).toBe(1)
    mock.addTracking(uuid, 0)
    await sync()
    await sync()
    expect(port.count("addLabels")).toBe(1)
    const [, keep, added] = port.calls.find((c) => c.method === "addLabels")!.args as [string, unknown[], Label[]]
    expect(keep).toEqual([])
    expect(added.map((l) => l.tracking_number)).toEqual(["JD0002270060000000"])
  })

  it("records a Medusa refusal as attention and carries on", async () => {
    const { uuid } = await placed()
    mock.dispatch(uuid)
    port.failNext("createFulfilment")
    const { d } = await sync()
    expect(d.failures).toEqual([{ ptFulfilment: expect.any(String), detail: "createFulfilment refused" }])
    expect(d.created).toHaveLength(1)
    expect(port.order.fulfillments).toHaveLength(1)
    expect(rowOf().attention).toBe("medusa-fulfilment-failed")
    expect(store.kinds().filter((k) => k === "dispatch-failed")).toHaveLength(1)
  })

  it("reports a Print Trail line that isn't on the order once", async () => {
    const { uuid } = await placed()
    mock.state.orders.get(uuid).fulfilments[0].orderLines.push({ lineNumber: "item_zzz", quantity: 1 })
    mock.dispatch(uuid, 0)
    await sync()
    await sync()
    expect(rowOf().attention).toBe("dispatch-mismatch")
    expect(store.kinds().filter((k) => k === "dispatch-mismatch")).toHaveLength(1)
    expect(port.count("createFulfilment")).toBe(1)
  })
})

describe("complete", () => {
  it("completes the order when every Print Trail line is dispatched", async () => {
    const { uuid } = await placed()
    mock.dispatch(uuid, 0)
    const partial = await sync()
    expect(partial.c.action).toBe("wait")
    mock.dispatch(uuid, 1)
    const done = await sync()
    expect(done.c).toMatchObject({ action: "complete", completed: true })
    expect(port.count("completeOrder")).toBe(1)
    expect(store.kinds()).toContain("completed")
    await sync()
    expect(port.count("completeOrder")).toBe(1)
  })

  it("does not complete a mixed basket and says so once", async () => {
    port.order.items.push({ id: "item_other", quantity: 1, fulfilled_quantity: 0, shipping_profile_id: "sp_other" })
    const { uuid } = await placed()
    mock.dispatch(uuid)
    const first = await sync()
    expect(first.c).toMatchObject({ action: "attention", completed: false })
    await sync()
    expect(port.count("completeOrder")).toBe(0)
    expect(rowOf().attention).toBe("complete-manually")
    expect(store.kinds().filter((k) => k === "complete-manually")).toHaveLength(1)
  })

  it("doesn't raise complete-manually again once dismissed, until completion changes", async () => {
    port.order.items.push({ id: "item_other", quantity: 1, fulfilled_quantity: 0, shipping_profile_id: "sp_other" })
    const { uuid } = await placed()
    mock.dispatch(uuid)
    await sync()
    expect(rowOf().attention).toBe("complete-manually")
    const columns = dismissColumns(rowOf(), "complete-manually")
    await store.updatePrintTrailOrders({ id: rowOf().id, ...columns })
    expect(readDismissed(rowOf())).toEqual(["complete-manually"])
    const again = await sync()
    expect(rowOf().attention).toBeNull()
    expect(again.c.events).toEqual([])
    expect(readDismissed(rowOf())).toEqual(["complete-manually"])
    // Completed by hand: the completion state has moved on, so it's forgotten.
    port.order.status = "completed"
    await sync()
    expect(rowOf().dismissed_attention).toBeNull()
  })

  it("flags a single cancelled fulfilment and keeps the order open", async () => {
    const { uuid } = await placed()
    mock.cancelFulfilment(uuid, 1)
    await sync()
    expect(rowOf().attention).toBe("pt-fulfilment-cancelled")
    mock.dispatch(uuid, 0)
    const { c } = await sync()
    expect(c.action).toBe("attention")
    expect(port.count("completeOrder")).toBe(0)
  })

  it("records a refusal to complete like a dispatch failure", async () => {
    const { uuid } = await placed()
    mock.dispatch(uuid)
    port.failNext("completeOrder")
    const { c } = await sync()
    expect(c.completed).toBe(false)
    expect(rowOf().attention).toBe("medusa-complete-failed")
  })
})

describe("copies", () => {
  it("records a Print Trail copy once and never adopts it", async () => {
    const { uuid } = await placed()
    const copy = mock.copy(uuid)
    const input = { rowId: rowOf().id, orderId: "order_1", copyUuid: copy, copyOrderNumber: "ORD-1001-COPY" }
    expect(await recordCopySeen(ctx, input)).toBe(true)
    expect(await recordCopySeen(ctx, input)).toBe(false)
    expect(store.events).toEqual([
      expect.objectContaining({
        kind: "pt-copy",
        message: "Print Trail order ORD-1001-COPY is a copy of this order made in Print Trail. Medusa doesn't track the copy.",
        data: { copy_uuid: copy, pt_url: `https://app.pt.example/acme/orders/${copy}` },
      }),
    ])
    expect(rowOf()).toMatchObject({ pt_uuid: uuid, attention: null })
  })
})

describe("refetch leases and Medusa refusals", () => {
  it("retries a Medusa refusal by refetch", async () => {
    const { uuid } = await placed()
    mock.dispatch(uuid)
    port.failNext("createFulfilment")
    await sync()
    expect(rowOf()).toMatchObject({ pending_action: "refetch", next_attempt_at: new Date(NOW.getTime() + 60_000) })
    await sync("retry")
    expect(port.order.fulfillments).toHaveLength(2)
    expect(rowOf()).toMatchObject({ pending_action: null, next_attempt_at: null })
  })

  it("leases a refetch before touching Medusa, so a crash mid-dispatch is retried", async () => {
    const { uuid } = await placed()
    mock.dispatch(uuid, 0)
    const seen: unknown[] = []
    const original = port.createFulfilment.bind(port)
    port.createFulfilment = async (orderId, c) => {
      seen.push(rowOf().pending_action)
      return original(orderId, c)
    }
    await sync()
    expect(seen).toEqual(["refetch"])
    expect(rowOf()).toMatchObject({ pending_action: null, next_attempt_at: null })
  })

  it("does not complete while a dispatched line has no Medusa fulfilment", async () => {
    const { uuid } = await placed()
    mock.state.orders.get(uuid).fulfilments[0].orderLines.push({ lineNumber: "item_zzz", quantity: 1 })
    mock.dispatch(uuid)
    await sync()
    await sync()
    expect(rowOf().attention).toBe("dispatch-mismatch")
    expect(port.count("completeOrder")).toBe(0)
  })

  it("re-reads an order whose listed copy is older than the stored snapshot", async () => {
    const { uuid } = await placed()
    const stale = JSON.parse(JSON.stringify(mock.state.orders.get(uuid)))
    mock.dispatch(uuid, 0)
    await sync()
    const entries = store.events.length
    const gets = () => mock.state.requests.filter((q) => q.method === "GET" && q.path.endsWith(`/orders/${uuid}`)).length
    const before = gets()
    const r = await refetch(ctx, { rowId: rowOf().id, source: "reconcile", pt: stale, listedAt: new Date(NOW.getTime() - 1000) })
    expect(gets()).toBe(before + 1)
    expect(r.pt?.fulfilments?.[0].status).toBe("dispatched")
    expect(store.events.length).toBe(entries)
    // A listing made after the last sync is used as it is.
    await refetch(ctx, { rowId: rowOf().id, source: "reconcile", pt: mock.state.orders.get(uuid), listedAt: NOW })
    expect(gets()).toBe(before + 1)
  })
})

describe("refetch retry accounting", () => {
  it("caps a Medusa refusal that never goes away, then stops leasing", async () => {
    const { uuid } = await placed()
    mock.dispatch(uuid, 0)
    port.failAlways("createFulfilment")
    for (let i = 0; i < 3; i++) {
      await sync(i ? "retry" : "webhook")
      expect(rowOf()).toMatchObject({ pending_action: "refetch", attempts: expect.objectContaining({ refetch: i + 1 }) })
    }
    await sync("retry")
    expect(rowOf()).toMatchObject({ pending_action: null, next_attempt_at: null, attention: "retry-cap:refetch" })
    const leases: unknown[] = []
    const original = port.createFulfilment.bind(port)
    port.createFulfilment = async (orderId, c) => {
      leases.push(rowOf().pending_action)
      return original(orderId, c)
    }
    await sync("reconcile")
    expect(leases).toEqual([null])
    expect(rowOf()).toMatchObject({ pending_action: null, next_attempt_at: null })
    expect(store.kinds().filter((k) => k === "retry-capped")).toHaveLength(1)
  })
})

describe("refetch outcomes that aren't a sync", () => {
  const pending = async () => {
    await store.updatePrintTrailOrders({
      id: rowOf().id,
      pending_action: "refetch",
      next_attempt_at: NOW,
      attempts: { refetch: 1 },
    })
  }

  it("clears a pending refetch when there's no uuid to fetch", async () => {
    await placed()
    await store.updatePrintTrailOrders({ id: rowOf().id, pt_uuid: null })
    await pending()
    const r = await refetch(ctx, { rowId: rowOf().id, source: "retry" })
    expect(r.outcome).toBe("no-uuid")
    expect(rowOf()).toMatchObject({ pending_action: null, next_attempt_at: null })
    expect(rowOf().attempts?.refetch ?? 0).toBe(0)
    expect(store.kinds()).toEqual(["refetch-skipped"])
  })

  it("clears a pending refetch when Print Trail has no such order", async () => {
    const { uuid } = await placed()
    await pending()
    mock.state.orders.delete(uuid)
    await refetch(ctx, { rowId: rowOf().id, source: "retry" })
    expect(rowOf()).toMatchObject({ pending_action: null, next_attempt_at: null, attention: "pt-order-missing" })
    expect(rowOf().attempts?.refetch ?? 0).toBe(0)
  })

  it("clears a pending refetch whose hint names another order", async () => {
    const { uuid } = await placed()
    const other = mock.copy(uuid)
    await store.updatePrintTrailOrders({ id: rowOf().id, pt_uuid: null })
    await pending()
    const r = await refetch(ctx, { rowId: rowOf().id, source: "retry", ptUuidHint: other })
    expect(r).toMatchObject({ outcome: "hint-mismatch", detail: expect.stringContaining("ORD-1001-COPY") })
    expect(rowOf()).toMatchObject({ pending_action: null, next_attempt_at: null })
  })

  it("never counts an auth failure as a retry: it waits for access", async () => {
    await placed()
    await pending()
    mock.fail(/\/orders\//, 401, { status: 401, title: "Unauthorized", detail: "Unauthenticated.", type: "about:blank" })
    const r = await refetch(ctx, { rowId: rowOf().id, source: "retry" })
    expect(r.outcome).toBe("auth-failed")
    expect(rowOf()).toMatchObject({
      pending_action: "refetch",
      attempts: { refetch: 1 },
      next_attempt_at: new Date(NOW.getTime() + 15 * 60_000),
    })
  })
})

describe("completion failures", () => {
  it("retries a refused completion and clears its attention once it completes", async () => {
    const { uuid } = await placed()
    mock.dispatch(uuid)
    port.failNext("completeOrder")
    await sync()
    expect(rowOf()).toMatchObject({
      attention: "medusa-complete-failed",
      pending_action: "refetch",
      attempts: expect.objectContaining({ refetch: 1 }),
    })
    const { c } = await sync("retry")
    expect(c.completed).toBe(true)
    expect(rowOf()).toMatchObject({ pending_action: null, next_attempt_at: null })
    expect(rowOf().attention).not.toBe("medusa-complete-failed")
    expect(rowOf().attempts?.refetch ?? 0).toBe(0)
  })

  it("doesn't flap attention while completion keeps failing", async () => {
    const { uuid } = await placed()
    mock.dispatch(uuid)
    port.failAlways("completeOrder")
    const attentionEvents: unknown[] = []
    for (let i = 0; i < 3; i++) {
      const { r, d, c } = await sync(i ? "retry" : "webhook")
      attentionEvents.push(
        ...[...r.events, ...d.events, ...c.events]
          .filter((e) => e.name === "print_trail.order.attention")
          .map((e) => e.data.attention)
      )
      expect(rowOf().attention).toBe("medusa-complete-failed")
    }
    expect(attentionEvents).toEqual(["medusa-complete-failed"])
    expect(store.kinds().filter((k) => k === "complete-failed")).toHaveLength(1)
    expect(rowOf().attempts?.refetch).toBe(3)
  })
})

describe("interleaving", () => {
  it("keeps a refetch another run asked for while this one held the lock", async () => {
    const { uuid } = await placed()
    mock.dispatch(uuid, 0)
    const original = port.createFulfilment.bind(port)
    port.createFulfilment = async (orderId, c) => {
      // A webhook's subscriber timed out on the lock and scheduled a refetch.
      await scheduleRefetch(store, rowOf().id, NOW)
      return original(orderId, c)
    }
    await sync()
    expect(port.order.fulfillments).toHaveLength(1)
    expect(rowOf()).toMatchObject({
      pending_action: "refetch",
      next_attempt_at: new Date(NOW.getTime() + 60_000),
      attempts: expect.objectContaining({ refetch: 1 }),
    })
  })
})

describe("flagReconcileFailure", () => {
  it("flags the row once and clears on the next sync that works", async () => {
    const { uuid } = await placed()
    await flagReconcileFailure(ctx, { rowId: rowOf().id, ptUuid: uuid, detail: "boom" })
    await flagReconcileFailure(ctx, { rowId: rowOf().id, ptUuid: uuid, detail: "boom" })
    expect(rowOf().attention).toBe("reconcile-failed")
    expect(store.kinds()).toEqual(["reconcile-failed"])
    await sync("reconcile")
    expect(rowOf().attention).toBeNull()
  })
})

describe("medusa-complete-failed clears", () => {
  const failOnce = async () => {
    const { uuid } = await placed()
    mock.dispatch(uuid)
    port.failNext("completeOrder")
    await sync()
    expect(rowOf().attention).toBe("medusa-complete-failed")
  }

  it("when the order was completed by hand", async () => {
    await failOnce()
    port.order.status = "completed"
    await sync("retry")
    expect(rowOf().attention).not.toBe("medusa-complete-failed")
  })

  it("when the order was cancelled", async () => {
    await failOnce()
    port.order.status = "canceled"
    await sync("retry")
    expect(rowOf().attention).not.toBe("medusa-complete-failed")
  })

  it("when auto-complete is turned off", async () => {
    await failOnce()
    ctx.options = { ...ctx.options, autoComplete: false }
    await sync("retry")
    expect(rowOf().attention).not.toBe("medusa-complete-failed")
    expect(port.count("completeOrder")).toBe(1)
  })
})

describe("a dismissed final Print Trail code", () => {
  // As the admin's Dismiss does, on the row as it is now.
  const dismiss = async () => {
    const columns = dismissColumns(rowOf(), rowOf().attention!)
    expect(columns).not.toBeNull()
    await store.updatePrintTrailOrders({ id: rowOf().id, ...columns })
  }
  const memory = () => readDismissed(rowOf())
  const setFulfilment = (uuid: string, i: number, status: string) => {
    mock.state.orders.get(uuid).fulfilments[i].status = status
  }
  const numberOf = (uuid: string, i: number) => mock.state.orders.get(uuid).fulfilments[i].fulfilmentNumber

  it("isn't raised again while Print Trail still reports it", async () => {
    const { uuid } = await placed()
    mock.setStatus(uuid, "partial")
    await sync()
    expect(rowOf().attention).toBe("pt-partial")
    await dismiss()
    store.events = []
    const { r } = await sync("reconcile")
    expect(rowOf().attention).toBeNull()
    expect(memory()).toEqual(["pt-partial"])
    expect(store.kinds()).not.toContain("pt-partial")
    expect(r.events.filter((e) => e.name === "print_trail.order.attention")).toEqual([])
  })

  it("keeps a dismissed parcel dismissed while a higher code comes and goes", async () => {
    const { uuid } = await placed()
    setFulfilment(uuid, 0, "returned")
    await sync()
    expect(rowOf().attention).toBe("pt-fulfilment-returned")
    await dismiss()
    expect(memory()).toEqual([`pt-fulfilment-returned:${numberOf(uuid, 0)}`])
    mock.setStatus(uuid, "partial")
    await sync()
    expect(rowOf().attention).toBe("pt-partial")
    expect(memory()).toEqual([`pt-fulfilment-returned:${numberOf(uuid, 0)}`])
    mock.setStatus(uuid, "complete")
    await sync()
    expect(rowOf().attention).toBeNull()
  })

  it("keeps a dismissed parcel dismissed through a transient hold", async () => {
    const { uuid } = await placed()
    setFulfilment(uuid, 0, "returned")
    await sync()
    await dismiss()
    mock.setStatus(uuid, "holding")
    await sync()
    expect(rowOf().attention).toBe("pt-holding")
    mock.setStatus(uuid, "processing")
    await sync()
    expect(rowOf().attention).toBeNull()
    expect(memory()).toEqual([`pt-fulfilment-returned:${numberOf(uuid, 0)}`])
  })

  it("still raises another parcel with the same code", async () => {
    const { uuid } = await placed()
    setFulfilment(uuid, 0, "failed")
    await sync()
    await dismiss()
    await sync()
    expect(rowOf().attention).toBeNull()
    setFulfilment(uuid, 1, "failed")
    await sync()
    expect(rowOf().attention).toBe("pt-fulfilment-failed")
  })

  it("still raises a lower code on another parcel", async () => {
    const { uuid } = await placed()
    setFulfilment(uuid, 0, "failed")
    await sync()
    await dismiss()
    setFulfilment(uuid, 1, "returned")
    await sync()
    expect(rowOf().attention).toBe("pt-fulfilment-returned")
    expect(memory()).toEqual([`pt-fulfilment-failed:${numberOf(uuid, 0)}`])
  })

  it("lets a different code through and forgets the dismissal", async () => {
    const { uuid } = await placed()
    setFulfilment(uuid, 0, "returned")
    await sync()
    await dismiss()
    mock.setStatus(uuid, "returned")
    setFulfilment(uuid, 0, "dispatched")
    const { r } = await sync()
    expect(rowOf().attention).toBe("pt-returned")
    expect(rowOf().dismissed_attention).toBeNull()
    expect(r.events).toContainEqual({
      name: "print_trail.order.attention",
      data: expect.objectContaining({ attention: "pt-returned" }),
    })
  })

  it("is forgotten once Print Trail stops reporting it, so it can be raised afresh", async () => {
    const { uuid } = await placed()
    mock.setStatus(uuid, "partial")
    await sync()
    await dismiss()
    mock.setStatus(uuid, "processing")
    await sync()
    expect(rowOf()).toMatchObject({ attention: null, dismissed_attention: null })
    mock.setStatus(uuid, "partial")
    await sync()
    expect(rowOf().attention).toBe("pt-partial")
  })

  it("resolves a returned order once, parcels and all", async () => {
    const { uuid } = await placed()
    mock.setStatus(uuid, "returned")
    expect(mock.state.orders.get(uuid).fulfilments.map((f: any) => f.status)).toEqual(["returned", "returned"])
    await sync()
    expect(rowOf().attention).toBe("pt-returned")
    await dismiss()
    await sync()
    expect(rowOf().attention).toBeNull()
  })

  it("resolves a partial order once, its failed parcel included", async () => {
    const { uuid } = await placed()
    setFulfilment(uuid, 0, "dispatched")
    setFulfilment(uuid, 1, "failed")
    mock.setStatus(uuid, "partial")
    await sync()
    expect(rowOf().attention).toBe("pt-partial")
    await dismiss()
    await sync()
    expect(rowOf().attention).toBeNull()
  })

  it("is kept when Print Trail can't find the order", async () => {
    const { uuid } = await placed()
    mock.setStatus(uuid, "partial")
    await sync()
    await dismiss()
    const before = rowOf().dismissed_attention
    expect(before).not.toBeNull()
    const order = mock.state.orders.get(uuid)
    mock.state.orders.delete(uuid)
    const { r } = await sync()
    expect(r.outcome).toBe("not-found")
    expect(rowOf().dismissed_attention).toBe(before)
    expect(memory()).toEqual(["pt-partial"])
    // Print Trail finds it again, still partial: the dismissal still holds.
    mock.state.orders.set(uuid, order)
    await sync()
    expect(rowOf().attention).toBeNull()
  })

  it("belongs to the Print Trail order it was dismissed on", async () => {
    const { uuid } = await placed()
    mock.setStatus(uuid, "partial")
    // Remembered for an order the row no longer points at.
    await store.updatePrintTrailOrders({ id: rowOf().id, dismissed_attention: writeDismissed("another-uuid", ["pt-partial"]) })
    await sync()
    expect(rowOf()).toMatchObject({ attention: "pt-partial", dismissed_attention: null })
  })

  it("never holds back a Print Trail cancel", async () => {
    const { uuid } = await placed()
    mock.setStatus(uuid, "partial")
    await sync()
    await dismiss()
    mock.setStatus(uuid, "cancelled")
    await sync()
    expect(rowOf()).toMatchObject({ attention: "pt-cancelled", dismissed_attention: null })
  })

  it("stays held back when a completion refusal clears", async () => {
    const { uuid } = await placed()
    mock.dispatch(uuid)
    port.failNext("completeOrder")
    await sync()
    expect(rowOf().attention).toBe("medusa-complete-failed")
    await store.updatePrintTrailOrders({ id: rowOf().id, dismissed_attention: writeDismissed(uuid, ["pt-partial"]) })
    mock.setStatus(uuid, "partial")
    port.order.status = "completed"
    await sync("retry")
    expect(rowOf().attention).toBeNull()
    expect(memory()).toEqual(["pt-partial"])
  })
})

describe("lock timeouts", () => {
  it("recognises Medusa's lock errors", () => {
    expect(isLockTimeout(new Error('Failed to acquire lock for key "print-trail:order:order_1"'))).toBe(true)
    expect(isLockTimeout(new Error("Order not found"))).toBe(false)
  })

  it("don't count towards the refetch cap", async () => {
    const { uuid } = await placed()
    mock.dispatch(uuid, 0)
    for (let i = 0; i < 5; i++) {
      expect(await scheduleRefetch(store, rowOf().id, NOW, "lock", { counted: false })).toBe(true)
    }
    expect(rowOf()).toMatchObject({ pending_action: "refetch", next_attempt_at: new Date(NOW.getTime() + 60_000) })
    expect(rowOf().attempts?.refetch ?? 0).toBe(0)
    await sync("retry")
    expect(rowOf()).toMatchObject({ pending_action: null })
    expect(rowOf().attention).not.toBe("retry-cap:refetch")
    expect(port.count("createFulfilment")).toBe(1)
  })
})

describe("lock timeouts during dispatch", () => {
  it("keeps an uncounted refetch scheduled while the holder dispatches", async () => {
    const { uuid } = await placed()
    mock.dispatch(uuid, 0)
    const original = port.createFulfilment.bind(port)
    port.createFulfilment = async (orderId, c) => {
      await scheduleRefetch(store, rowOf().id, NOW, 'Failed to acquire lock for key "print-trail:order:order_1"', {
        counted: false,
      })
      return original(orderId, c)
    }
    await sync()
    expect(rowOf()).toMatchObject({ pending_action: "refetch" })
  })
})

describe("reconcile failure records", () => {
  it("are cleared by a sync that works through any path", async () => {
    const { uuid } = await placed()
    const values = new Map<string, unknown>([
      ["reconcile_failures", { [uuid]: { updatedAt: "x", runs: 3, skipped: true, error: "e" }, other: { updatedAt: "x", runs: 1, error: "e" } }],
    ])
    ctx.state = {
      getState: async <T,>(k: string) => (values.get(k) as T) ?? null,
      setState: async (k, v) => void values.set(k, v),
    }
    await sync("webhook")
    expect(values.get("reconcile_failures")).toEqual({ other: { updatedAt: "x", runs: 1, error: "e" } })
  })
})

describe("reconcile record cleanup failures", () => {
  it("are logged at warn and never fail complete()", async () => {
    await placed()
    const warnings: string[] = []
    ctx.logger = { warn: (m: string) => void warnings.push(m) }
    ctx.state = {
      getState: async () => {
        throw new Error("state store down")
      },
      setState: async () => {},
    }
    const { c } = await sync("webhook")
    expect(c).toBeDefined()
    expect(warnings).toEqual([expect.stringContaining("state store down")])
  })

  describe("settling a Medusa cancel", () => {
    const notified: unknown[] = []
    beforeEach(() => {
      notified.length = 0
      ctx.options = { ...ctx.options, notifications: { ...ctx.options.notifications, adminEmail: ["ops@shop.test"] } }
      ctx.notifier = { notify: async (n) => void notified.push(...n) }
      ctx.orderDisplayId = async () => 1001
    })

    it("settles a Medusa cancel from a webhook and emails once", async () => {
      const { uuid } = await placed()
      port.order.status = "canceled"
      port.order.canceled_at = NOW.toISOString()
      await store.updatePrintTrailOrders({ id: rowOf().id, cancel_requested: true, cancel_status: "awaiting" })
      mock.dispatch(uuid, 0)
      await sync()
      await sync("reconcile")
      expect(rowOf()).toMatchObject({ cancel_status: "too-late", attention: "cancel-too-late" })
      expect(store.kinds().filter((k) => k === "cancel-too-late")).toHaveLength(1)
      expect(notified).toHaveLength(1)
    })

    it("notes a dispatch after a Medusa cancel that failed or was refused", async () => {
      for (const cancel_status of ["failed", "refused"]) {
        store.rows = []
        store.events = []
        port.order.status = "pending"
        port.order.canceled_at = null
        const { uuid } = await placed()
        port.order.status = "canceled"
        port.order.canceled_at = NOW.toISOString()
        await store.updatePrintTrailOrders({ id: rowOf().id, cancel_requested: true, cancel_status })
        mock.dispatch(uuid, 0)
        await sync()
        await sync()
        expect(store.kinds().filter((k) => k === "dispatched-after-cancel")).toHaveLength(1)
        expect(store.kinds()).not.toContain("cancel-too-late")
      }
    })

    it("writes no dispatched-after-cancel entry for a cancel Medusa asked for", async () => {
      const { uuid } = await placed()
      port.order.status = "canceled"
      port.order.canceled_at = NOW.toISOString()
      await store.updatePrintTrailOrders({ id: rowOf().id, cancel_requested: true, cancel_status: "awaiting" })
      mock.dispatch(uuid, 0)
      await sync()
      expect(store.kinds()).not.toContain("dispatched-after-cancel")
      expect(rowOf().attention).toBe("cancel-too-late")
    })

    it("settles a finished 202 as cancelled", async () => {
      const { uuid } = await placed()
      await store.updatePrintTrailOrders({ id: rowOf().id, cancel_requested: true, cancel_status: "awaiting" })
      mock.setStatus(uuid, "cancelled")
      const { r } = await sync()
      expect(rowOf().cancel_status).toBe("cancelled")
      expect(r.events.map((e) => e.name)).toEqual(["print_trail.order.cancelled"])
    })

    it("notes a too-late cancel without a notifier, and skips the email", async () => {
      const warnings: string[] = []
      ctx.notifier = undefined
      ctx.logger = { warn: (m: string) => void warnings.push(m) }
      const { uuid } = await placed()
      await store.updatePrintTrailOrders({ id: rowOf().id, cancel_requested: true, cancel_status: "awaiting" })
      mock.dispatch(uuid, 0)
      await sync()
      expect(store.kinds()).toContain("cancel-too-late")
      expect(warnings.join(" ")).toContain("cancel-too-late email")
    })
  })
})

// API 1.3.0: pre-order lines wait at Print Trail, then are released.
describe("pre-order releases", () => {
  it("a waiting order syncs without attention, then releases", async () => {
    mock.state.stock["PRE-1"] = 0
    mock.state.skuStatus["PRE-1"] = "pre-order"
    const { uuid } = await placed([line("978-A", 2, "item_a"), line("PRE-1", 1, "item_b")])
    expect(rowOf().confirmed_at).toEqual(NOW)
    // A sync that sees a waiting fulfilment marks its SKU seen on pre-order
    // (the confirm's mark is cleared first, so only the sync can).
    store.seen = memoryPreOrderSeen()
    const first = await sync()
    expect(await store.seen.preOrderSeen(["PRE-1", "978-A"])).toEqual(["PRE-1"])
    expect(first.r.outcome).toBe("synced")
    expect(rowOf().attention).toBeNull()
    const messages = () => store.events.map((e) => e.message)
    // The confirm's snapshot already had the wait (recorded then): no change.
    expect(messages()).toEqual([])
    expect(first.c).toMatchObject({ action: "wait" })

    store.events = []
    mock.state.stock["PRE-1"] = 3
    await mock.setSkuStatus("PRE-1", "active")
    await sync()
    expect(rowOf().attention).toBeNull()
    expect(messages()).toContainEqual(expect.stringMatching(/fulfilment .* was released: back-order → draft$/))

    // Ships once dispatched, then completes.
    mock.dispatch(uuid)
    const last = await sync()
    expect(port.count("createFulfilment")).toBe(2)
    expect(last.c).toMatchObject({ action: "complete" })
  })

  it("remembers the waiting fulfilment, so its parcel dispatches as the pre-order", async () => {
    mock.state.stock["PRE-1"] = 0
    mock.state.skuStatus["PRE-1"] = "pre-order"
    const { uuid } = await placed([line("978-A", 2, "item_a"), line("PRE-1", 1, "item_b")])
    const fulfilments = mock.state.orders.get(uuid).fulfilments as { uuid: string; status: string }[]
    const inStock = fulfilments.findIndex((f) => f.status !== "back-order")
    const waiting = fulfilments.findIndex((f) => f.status === "back-order")
    // Recorded from the create and confirm responses, before any sync (the
    // mock regenerates fulfilments on confirm: the draft's uuid stays too,
    // harmlessly, since it never dispatches).
    const recorded = rowOf().pre_order_fulfilments as string[]
    expect(recorded).toContain(fulfilments[waiting].uuid)
    expect(recorded).not.toContain(fulfilments[inStock].uuid)

    mock.dispatch(uuid, inStock)
    const first = await sync()
    expect(first.d.events).toEqual([
      expect.objectContaining({
        name: "print_trail.order.dispatched",
        data: expect.objectContaining({ pt_fulfilment_uuid: fulfilments[inStock].uuid, was_pre_order: false }),
      }),
    ])

    // Released and dispatched in one go: no sync saw it waiting since, and
    // its backOrderReason is null now.
    mock.state.stock["PRE-1"] = 3
    await mock.setSkuStatus("PRE-1", "active")
    mock.dispatch(uuid, waiting)
    const last = await sync()
    expect(mock.state.orders.get(uuid).fulfilments[waiting].backOrderReason).toBeNull()
    expect(last.d.events).toEqual([
      expect.objectContaining({
        name: "print_trail.order.dispatched",
        data: expect.objectContaining({ pt_fulfilment_uuid: fulfilments[waiting].uuid, was_pre_order: true }),
      }),
    ])
    // Kept as it was.
    expect(rowOf().pre_order_fulfilments).toEqual(recorded)
  })

  it("a sync adds a fulfilment first seen waiting to the record", async () => {
    const { uuid } = await placed()
    expect(rowOf().pre_order_fulfilments ?? null).toBeNull()
    // Back on pre-order with no webhook: the next sync
    // sees the wait.
    const f = mock.state.orders.get(uuid).fulfilments[0]
    f.status = "back-order"
    f.backOrderReason = "pre-order"
    await sync()
    expect(rowOf().pre_order_fulfilments).toEqual([f.uuid])
  })

  it("going live without stock is an ordinary back-order, with its own entry", async () => {
    mock.state.stock["PRE-1"] = 0
    mock.state.skuStatus["PRE-1"] = "pre-order"
    await placed([line("PRE-1", 1, "item_b")])
    await sync()
    store.events = []
    await mock.setSkuStatus("PRE-1", "active")
    await sync()
    expect(rowOf().attention).toBe("pt-fulfilment-back-order")
    expect(store.events.map((e) => e.kind)).toEqual(["pt-back-order-reason", "pt-fulfilment-back-order"])
    expect(store.events[0].message).toMatch(/is now out of stock \(the product went live before its stock arrived\)$/)
  })

  it("an activated SKU refetches the rows waiting on it", async () => {
    const waitingOn = (sku: string, over: Record<string, unknown> = {}) =>
      store.createPrintTrailOrders({
        order_id: `order_${sku}`,
        pt_uuid: `pt-${sku}`,
        status: "queued",
        confirmed_at: NOW,
        pending_action: null,
        fulfilments: [
          { uuid: `f-${sku}`, status: "back-order", backOrderReason: "pre-order", orderLines: [{ lineNumber: "l", quantity: 1, product: { sku, activeState: "pre-order" } }] },
        ],
        ...over,
      })
    const waitingWith = (order_id: string, lines: { sku: string; activeState?: string }[]) =>
      waitingOn(order_id, {
        order_id,
        fulfilments: [
          {
            uuid: `f-${order_id}`,
            status: "back-order",
            backOrderReason: "pre-order",
            orderLines: lines.map((product, i) => ({ lineNumber: `l${i}`, quantity: 1, product })),
          },
        ],
      })
    const p = await waitingOn("pre-1")
    const q = await waitingOn("PRE-2")
    const amending = await waitingOn("PRE-1", { order_id: "order_amend", pending_action: "amend", next_attempt_at: NOW })
    const unconfirmed = await waitingOn("PRE-1", { order_id: "order_draft", confirmed_at: null, status: "draft" })
    const finished = await waitingOn("PRE-1", { order_id: "order_done", status: "complete" })
    // A refetch retry already scheduled: left as it is (never pulled earlier
    // or overwritten).
    const retrying = await waitingOn("PRE-1", { order_id: "order_retry", pending_action: "refetch", next_attempt_at: new Date(NOW.getTime() + 900_000), attempts: { refetch: 2 } })
    // Holds PRE-1, but in a fulfilment that isn't waiting for release.
    const shipping = await waitingOn("PRE-1", {
      order_id: "order_shipping",
      fulfilments: [{ uuid: "f-s", status: "processing", backOrderReason: null, orderLines: [{ lineNumber: "l", quantity: 1, product: { sku: "PRE-1" } }] }],
    })
    // Waits on PRE-3; its PRE-1 line already says active.
    const mixed = await waitingWith("order_mixed", [{ sku: "PRE-3", activeState: "pre-order" }, { sku: "PRE-1", activeState: "active" }])
    // No activeState to compare: a refetch wouldn't make it current.
    const unknown = await waitingWith("order_unknown", [{ sku: "PRE-1" }])
    const scheduled = await scheduleWaitingRefetches(store, { active: ["PRE-1"] }, NOW)
    expect(scheduled).toEqual([p.id])
    expect(store.rows.find((r) => r.id === mixed.id)!.pending_action).toBeNull()
    expect(store.rows.find((r) => r.id === unknown.id)!.pending_action).toBeNull()
    const byId = (id: string) => store.rows.find((r) => r.id === id)!
    expect(byId(p.id)).toMatchObject({ pending_action: "refetch" })
    // Due now, and not counted against the refetch cap.
    expect(byId(p.id).next_attempt_at).toEqual(NOW)
    expect(byId(p.id).attempts?.refetch ?? 0).toBe(0)
    expect(byId(q.id).pending_action).toBeNull()
    expect(byId(amending.id).pending_action).toBe("amend")
    expect(byId(unconfirmed.id).pending_action).toBeNull()
    expect(byId(finished.id).pending_action).toBeNull()
    expect(byId(shipping.id).pending_action).toBeNull()
    expect(byId(retrying.id)).toMatchObject({ pending_action: "refetch", next_attempt_at: new Date(NOW.getTime() + 900_000), attempts: { refetch: 2 } })
    expect(await scheduleWaitingRefetches(store, {}, NOW)).toEqual([])
  })

  // Back on pre-order, or set inactive: Print Trail holds the fulfilment as
  // pre-order with no order webhook and no updatedAt change. A refetch is
  // wanted where the stored snapshot is stale: an out-of-stock back-order, or a
  // line whose activeState isn't the item's status.
  it("a held SKU refetches the rows whose snapshot is behind its status", async () => {
    const holding = (order_id: string, reason: string, activeState: string, over: Record<string, unknown> = {}) =>
      store.createPrintTrailOrders({
        order_id,
        pt_uuid: `pt-${order_id}`,
        status: "back-order",
        confirmed_at: NOW,
        pending_action: null,
        fulfilments: [
          {
            uuid: `f-${order_id}`,
            status: "back-order",
            backOrderReason: reason,
            sentToWarehouseAt: reason === "warehouse" ? NOW.toISOString() : null,
            orderLines: [{ lineNumber: "l", quantity: 1, product: { sku: "SKU-1", activeState } }],
          },
        ],
        ...over,
      })
    const oos = await holding("order_oos", "out-of-stock", "active")
    const warehouse = await holding("order_wh", "warehouse", "active")
    const current = await holding("order_current", "pre-order", "pre-order")
    const wasInactive = await holding("order_was_inactive", "pre-order", "inactive")
    const pending = await holding("order_pending", "out-of-stock", "active", { pending_action: "amend", next_attempt_at: NOW })
    const unknown = await holding("order_unknown", "pre-order", "", {
      fulfilments: [{ uuid: "f-u", status: "back-order", backOrderReason: "pre-order", sentToWarehouseAt: null, orderLines: [{ lineNumber: "l", quantity: 1, product: { sku: "SKU-1" } }] }],
    })
    const byId = (id: string) => store.rows.find((r) => r.id === id)!

    expect(await scheduleWaitingRefetches(store, { held: [{ sku: "sku-1", status: "pre-order" }] }, NOW)).toEqual([oos.id, wasInactive.id])
    expect(byId(oos.id)).toMatchObject({ pending_action: "refetch", next_attempt_at: NOW })
    for (const r of [warehouse, current]) expect(byId(r.id).pending_action).toBeNull()
    expect(byId(pending.id).pending_action).toBe("amend")
    expect(byId(unknown.id).pending_action).toBeNull()

    for (const r of [oos, wasInactive]) await store.updatePrintTrailOrders({ id: r.id, pending_action: null, next_attempt_at: null })
    // Set inactive: the waiting row whose lines still say pre-order too.
    expect(await scheduleWaitingRefetches(store, { held: [{ sku: "SKU-1", status: "inactive" }] }, NOW)).toEqual([oos.id, current.id])
  })
})

// Released, then the warehouse send failed. Seen in one
// refetch (the draft step in between was missed).
describe("a released fulfilment whose warehouse send failed", () => {
  it("is described as released and on hold", async () => {
    mock.state.stock["PRE-1"] = 0
    mock.state.skuStatus["PRE-1"] = "pre-order"
    const { uuid } = await placed([line("PRE-1", 1, "item_b")])
    await sync()
    store.events = []
    Object.assign(mock.state.orders.get(uuid).fulfilments[0], { status: "holding", backOrderReason: null })
    mock.setStatus(uuid, "processing")
    await sync()
    expect(rowOf().attention).toBe("pt-fulfilment-holding")
    expect(store.events.map((e) => e.message)).toContainEqual(
      expect.stringMatching(/fulfilment .* was released and is on hold at Print Trail: back-order → holding \(Print Trail may retry the warehouse send\)$/)
    )
  })
})

// Held as pre-order until the product goes active.
describe("a product set inactive while orders wait", () => {
  it("raises low-priority attention, dismissable until Print Trail no longer calls for it", async () => {
    mock.state.stock["PRE-1"] = 0
    mock.state.skuStatus["PRE-1"] = "pre-order"
    await placed([line("PRE-1", 1, "item_b")])
    await sync()
    expect(rowOf().attention).toBeNull()
    await mock.setSkuStatus("PRE-1", "inactive")
    const held = { held: [{ sku: "PRE-1", status: "inactive" }] }
    expect(await scheduleWaitingRefetches(store, held, NOW)).toEqual([rowOf().id])
    store.events = []
    const { r } = await sync()
    expect(rowOf().attention).toBe("pt-pre-order-inactive")
    expect((rowOf().fulfilments as any[])[0]).toMatchObject({ status: "back-order", backOrderReason: "pre-order" })
    expect(r.events).toContainEqual(expect.objectContaining({ name: "print_trail.order.attention", data: expect.objectContaining({ attention: "pt-pre-order-inactive" }) }))
    expect(store.events.map((e) => e.message)).toContainEqual(expect.stringMatching(/isn't active at Print Trail/))
    // The snapshot is current: the next event for the SKU queues nothing.
    expect(await scheduleWaitingRefetches(store, held, NOW)).toEqual([])

    await store.updatePrintTrailOrders({ id: rowOf().id, ...dismissColumns(rowOf(), "pt-pre-order-inactive") })
    await sync()
    expect(rowOf().attention).toBeNull()
    // Back on pre-order: forgotten, so a later withdrawal is raised again.
    await mock.setSkuStatus("PRE-1", "pre-order")
    await sync()
    expect(readDismissed(rowOf())).toEqual([])
    await mock.setSkuStatus("PRE-1", "inactive")
    await sync()
    expect(rowOf().attention).toBe("pt-pre-order-inactive")
  })
})

describe("a product back on pre-order", () => {
  it("clears the out-of-stock back-order attention after the refetch", async () => {
    mock.state.stock["PRE-1"] = 0
    mock.state.skuStatus["PRE-1"] = "pre-order"
    await placed([line("PRE-1", 1, "item_b")])
    await sync()
    await mock.setSkuStatus("PRE-1", "active")
    await sync()
    expect(rowOf().attention).toBe("pt-fulfilment-back-order")
    store.events = []
    await mock.setSkuStatus("PRE-1", "pre-order")
    expect(await scheduleWaitingRefetches(store, { held: [{ sku: "PRE-1", status: "pre-order" }] }, NOW)).toEqual([rowOf().id])
    await sync()
    expect(rowOf()).toMatchObject({ attention: null, pending_action: null })
    expect(store.events.map((e) => e.message)).toContainEqual(
      expect.stringMatching(/is waiting for the pre-order release again \(its product is no longer active\)$/)
    )
  })
})

// API 1.1.1: the sweep re-posts an order whose row was lost; Print Trail
// confirmed it and it has since finished, so the replay answers
// not-updatable with the order. The send adopts it and schedules a sync,
// which brings the store up to Print Trail's final state.
describe("a finished order adopted from a not-updatable 409", () => {
  const sendAgain = async () => {
    const lines = [line("978-A", 2, "item_a"), line("US-1", 1, "item_b")]
    const create = await createDraft(sendCtx, { order: graphOrder, lines, sequence: 1 })
    const gate = await checkGate(sendCtx, graphOrder, create)
    await recordOutcome(sendCtx, { orderId: "order_1", create, gate, confirm: null })
    return create
  }
  // Placed and confirmed, then the row is lost (its uuid never stored).
  const lostRow = async () => {
    const { uuid } = await placed()
    store.rows = []
    store.events = []
    return uuid
  }
  const confirms = () => mock.state.requests.filter((r) => r.path.endsWith("/confirm")).length

  it("complete: ships every parcel and completes the order, with nothing re-sent", async () => {
    const uuid = await lostRow()
    mock.dispatch(uuid)
    expect((await sendAgain()).outcome).toBe("adopted-confirmed")
    expect(rowOf()).toMatchObject({ pt_uuid: uuid, status: "complete", pending_action: "refetch", next_attempt_at: NOW })
    const { c } = await sync("retry")
    expect(port.count("createFulfilment")).toBe(2)
    expect(port.count("createShipment")).toBe(2)
    expect(c).toMatchObject({ action: "complete", completed: true })
    expect(rowOf()).toMatchObject({ pending_action: null, attention: null })
    expect(confirms()).toBe(1)
  })

  it("partial: ships what dispatched and flags the order", async () => {
    const uuid = await lostRow()
    mock.dispatch(uuid, 0)
    const remote = mock.state.orders.get(uuid)
    remote.fulfilments[1].status = "failed"
    remote.status = "partial"
    await sendAgain()
    const { c } = await sync("retry")
    expect(port.count("createFulfilment")).toBe(1)
    expect(rowOf().attention).toBe("pt-partial")
    expect(c.completed).toBe(false)
    expect(port.count("completeOrder")).toBe(0)
  })

  it("failed: nothing ships and the order is flagged", async () => {
    const uuid = await lostRow()
    const remote = mock.state.orders.get(uuid)
    remote.fulfilments.forEach((f: any) => (f.status = "failed"))
    remote.status = "failed"
    await sendAgain()
    await sync("retry")
    expect(port.count("createFulfilment")).toBe(0)
    expect(rowOf().attention).toBe("pt-fulfilment-failed")
  })

  it("returned: nothing ships or completes, and the order is flagged", async () => {
    const uuid = await lostRow()
    // Print Trail's shape: a returned order has every fulfilment returned.
    const remote = mock.state.orders.get(uuid)
    remote.fulfilments.forEach((f: any) => (f.status = "returned"))
    remote.status = "returned"
    await sendAgain()
    const { c } = await sync("retry")
    expect(port.count("createFulfilment")).toBe(0)
    expect(port.count("completeOrder")).toBe(0)
    expect(rowOf()).toMatchObject({ status: "returned", attention: "pt-returned", pending_action: null })
    expect(c.completed).toBe(false)
    expect(store.kinds()).toContain("pt-returned")
  })
})
