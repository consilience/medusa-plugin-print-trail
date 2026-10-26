import { startMockPrintTrail, type MockPrintTrail } from "../../../dev/mock-print-trail"
import { resolvePluginOptions } from "../../config"
import { PrintTrailClient } from "../../modules/printTrail/client/client"
import { preparePayload } from "../hooks"
import type { GraphOrder, ScopedLine, SelectedLine } from "../lines"
import { printTrailOrderNumber } from "../order-number"
import { resolveSendTarget, scopedLines } from "../order-scope"
import {
  adoptionClears,
  checkGate,
  confirm,
  confirmGate,
  createDraft,
  recordOutcome,
  type PrintTrailOrderRow,
  type SendContext,
  type SendStore,
} from "../send-flow"
import { memoryPreOrderSeen } from "../pre-order"
import { dueRows } from "../sweep"

const TOKEN = "flow-token"
const NOW = new Date("2026-10-18T12:00:00Z")

class MemoryStore implements SendStore {
  // The activation scan's record, as the service keeps it.
  seen = memoryPreOrderSeen()
  async markPreOrderSeen(skus: string[]) {
    await this.seen.markPreOrderSeen(skus)
  }
  rows: PrintTrailOrderRow[] = []
  events: Record<string, unknown>[] = []
  linkChecks: string[] = []
  private n = 0

  async listPrintTrailOrders(filters: Record<string, unknown>) {
    return this.rows
      .filter((r) => Object.entries(filters).every(([k, v]) => r[k] === v))
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
    return this.events.filter((e) => Object.entries(filters).every(([k, v]) => e[k] === v)) as { kind: string; data?: any }[]
  }
  async ensureOrderLink(row: PrintTrailOrderRow) {
    this.linkChecks.push(row.id)
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

const order = (over: Partial<GraphOrder> = {}): GraphOrder => ({
  id: "order_1",
  display_id: 1001,
  email: "ada@example.com",
  status: "pending",
  canceled_at: null,
  shipping_address: address,
  billing_address: null,
  payment_collections: [{ captured_amount: 0, refunded_amount: 0 }],
  ...over,
})

const line = (sku: string, quantity = 1, method = "standard", id = `item_${sku}`): SelectedLine => ({
  lineItemId: id,
  sku,
  quantity,
  method,
})

let mock: MockPrintTrail
let store: MemoryStore
let ctx: SendContext

beforeEach(async () => {
  mock = await startMockPrintTrail({
    token: TOKEN,
    channelId: "acme-medusa1",
    skus: { "978-A": 10, "978-B": 0, "US-1": 5 },
    locations: { "US-1": "US1" },
    methodsByLocation: { US1: ["standard"] },
  })
  store = new MemoryStore()
  ctx = {
    store,
    client: new PrintTrailClient({ baseUrl: mock.url, channelId: "acme-medusa1", apiToken: TOKEN, retryDelays: [0] }),
    options: resolvePluginOptions({
      baseUrl: mock.url,
      channelId: "acme-medusa1",
      apiToken: TOKEN,
      orderNumberPrefix: "ORD-",
      adminUrl: "https://admin.example/app",
    }),
    now: () => NOW,
  }
})

afterEach(() => mock.close())

// Runs the steps in the workflow's order.
async function send(
  o: GraphOrder,
  lines: SelectedLine[],
  sequence = 1,
  opts: {
    selected?: SelectedLine[]
    beforeConfirm?: () => void
    sourceRef?: string | null
    orderNumber?: string
    prepared?: ReturnType<typeof preparePayload>
  } = {}
) {
  const create = await createDraft(ctx, {
    order: o,
    lines,
    sequence,
    selected: opts.selected,
    sourceRef: opts.sourceRef,
    orderNumber: opts.orderNumber,
    prepared: opts.prepared,
  })
  const gate = await checkGate(ctx, o, create)
  opts.beforeConfirm?.()
  const confirmed =
    gate.ok && create.rowId && create.pt
      ? await confirm(ctx, { rowId: create.rowId, pt: create.pt, body: gate.body!, methodByLine: create.methodByLine })
      : null
  const events = await recordOutcome(ctx, { orderId: o.id, create, gate, confirm: confirmed })
  return { create, gate, confirmed, events, row: store.rows.find((r) => r.id === create.rowId) }
}

// The workflow's target, scope and payload steps, then the send steps.
async function sendTo(o: GraphOrder, all: ScopedLine[], input: { sequence?: number; source_ref?: string; reissue_of?: number } = {}) {
  const rows = await store.listPrintTrailOrders({ order_id: o.id })
  const target = resolveSendTarget(rows as never, input)
  if (!target.ok) throw new Error(target.detail)
  const lines = scopedLines(all, rows as never, target)
  const existing = rows.find((r) => r.id === target.rowId)
  const orderNumber = existing?.pt_order_number ?? printTrailOrderNumber("ORD-", o.display_id, target.sequence)
  const prepared = preparePayload({ order: o, lines, orderNumber, options: ctx.options })
  return send(o, lines, target.sequence, { sourceRef: target.sourceRef, orderNumber, prepared })
}

const scoped = (sku: string, quantity = 1, replacementOf: string | null = null, id = `item_${sku}`): ScopedLine => ({
  ...line(sku, quantity, "standard", id),
  replacementOf,
})

const posts = () => mock.state.requests.filter((r) => r.method === "POST" && r.path.endsWith("/orders"))

describe("sendOrderToPrintTrail steps", () => {
  it("sends and confirms a clean order", async () => {
    const { create, confirmed, events, row } = await send(order(), [line("978-A", 2, "tracked")])
    expect(create.outcome).toBe("draft")
    expect(confirmed?.outcome).toBe("confirmed")
    expect(row).toMatchObject({
      pt_order_number: "ORD-1001",
      status: "queued",
      confirmed_at: NOW,
      block_reason: null,
      attention: null,
    })
    expect(row?.pt_uuid).toBeTruthy()
    expect(events.map((e) => e.name)).toEqual(["print_trail.order.sent", "print_trail.order.confirmed"])
    const pt = mock.state.orders.get(row!.pt_uuid!)
    expect(pt.fulfilments[0].requestedShippingMethod).toBe("tracked")
    expect(posts()[0].body.orderUrl).toBe("https://admin.example/app/orders/order_1")
    expect(posts()[0].body).not.toHaveProperty("requestedShippingMethod")
    expect(store.events.map((e) => e.kind)).toEqual(["sent", "confirmed"])
  })

  it("leaves no lease on a row once the send is recorded", async () => {
    const { row } = await send(order(), [line("978-A")])
    expect(row).toMatchObject({ pending_action: null, next_attempt_at: null })
  })

  it("leases a new row, so the sweep recovers a run that dies before sending", async () => {
    jest.spyOn(ctx.client, "createOrder").mockRejectedValueOnce(new Error("process died"))
    await expect(createDraft(ctx, { order: order(), lines: [line("978-A")], sequence: 1 })).rejects.toThrow(
      "process died"
    )
    expect(store.rows[0]).toMatchObject({
      pending_action: "send",
      next_attempt_at: new Date("2026-10-18T12:15:00Z"),
      attempts: { send: 1 },
    })
    expect(dueRows(store.rows, new Date("2026-10-18T12:16:00Z"))).toHaveLength(1)
  })

  it("leases the confirm once the uuid is stored, so the sweep recovers a run that dies before confirming", async () => {
    await createDraft(ctx, { order: order(), lines: [line("978-A")], sequence: 1 })
    // The process dies here, before the gate and the outcome step.
    expect(store.rows[0]).toMatchObject({
      pending_action: "confirm",
      next_attempt_at: new Date("2026-10-18T12:15:00Z"),
      attempts: { send: 1, confirm: 1 },
    })
    expect(store.rows[0].pt_uuid).toBeTruthy()
    expect(dueRows(store.rows, new Date("2026-10-18T12:16:00Z"))).toHaveLength(1)
  })

  it("clears the lease of a run that died after confirming", async () => {
    const o = order()
    const create = await createDraft(ctx, { order: o, lines: [line("978-A")], sequence: 1 })
    const gate = confirmGate(ctx.options, o, create)
    await confirm(ctx, { rowId: create.rowId!, pt: create.pt!, body: gate.body!, methodByLine: create.methodByLine })
    // The process dies before the outcome step; the sweep runs it again.
    const again = await send(o, [line("978-A")])
    expect(again.create.outcome).toBe("skip-confirmed")
    expect(again.row).toMatchObject({ pending_action: null, next_attempt_at: null })
    expect(dueRows(store.rows, new Date("2026-10-19T12:00:00Z"))).toHaveLength(0)
  })

  it("counts runs that die after leasing, and stops at the cap", async () => {
    const createOrder = jest.spyOn(ctx.client, "createOrder").mockRejectedValue(new Error("process died"))
    for (let run = 1; run <= 3; run++) {
      await expect(createDraft(ctx, { order: order(), lines: [line("978-A")], sequence: 1 })).rejects.toThrow()
      expect(store.rows[0]).toMatchObject({ pending_action: "send", attempts: { send: run } })
    }
    // The sweep picks the lease up a fourth time: the cap (3) is spent.
    const { create, row, events } = await send(order(), [line("978-A")])
    expect(create.outcome).toBe("retry-capped")
    expect(createOrder).toHaveBeenCalledTimes(3)
    expect(row).toMatchObject({ pending_action: null, next_attempt_at: null, attention: "retry-cap:send" })
    expect(store.events.map((e) => e.message)).toContain("Stopped retrying send after repeated failures")
    expect(events.map((e) => e.name)).toEqual(["print_trail.order.attention"])
    expect(dueRows(store.rows, new Date("2026-10-19T12:00:00Z"))).toHaveLength(0)
  })

  it("counts a recorded run's attempt once, as before leases", async () => {
    mock.fail(/\/orders$/, 503, undefined, 4)
    await send(order(), [line("978-A")])
    await send(order(), [line("978-A")])
    expect(store.rows[0]).toMatchObject({ pending_action: "send", attempts: { send: 2 } })
  })

  it("counts a confirm pickup once, even when it re-posts and then dies", async () => {
    await send(order(), [line("978-B", 2)]) // stock shortfall: confirm retry due
    expect(store.rows[0]).toMatchObject({ pending_action: "confirm", attempts: { confirm: 1 } })
    // The sweep's pickup re-posts the draft, stores the uuid, then dies.
    const create = await createDraft(ctx, { order: order(), lines: [line("978-B", 2)], sequence: 1 })
    expect(create.posted).toBe(true)
    expect(store.rows[0].attempts).toEqual({ send: 0, confirm: 2 })
  })

  it("never leases over a pending cancel, amend or refetch", async () => {
    await createDraft(ctx, { order: order(), lines: [line("978-A")], sequence: 1 })
    const due = new Date("2026-10-18T11:00:00Z")
    for (const action of ["cancel", "amend", "refetch"]) {
      Object.assign(store.rows[0], { pending_action: action, next_attempt_at: due })
      await createDraft(ctx, { order: order(), lines: [line("978-A")], sequence: 1 })
      expect(store.rows[0]).toMatchObject({ pending_action: action, next_attempt_at: due })
    }
  })

  it("replaces the lease with a sync due now when adopting a confirmed order, even if the run dies before recording", async () => {
    const first = await createDraft(ctx, { order: order(), lines: [line("978-A")], sequence: 1 })
    const sent = store.rows[0].submitted_lines
    await ctx.client.confirmOrder(first.pt!.uuid, {})
    const adopted = await createDraft(ctx, { order: order(), lines: [line("978-A")], sequence: 1 })
    // The process dies here, before the outcome step.
    expect(adopted.outcome).toBe("adopted-confirmed")
    expect(store.rows[0]).toMatchObject({ pending_action: "refetch", next_attempt_at: NOW })
    // The lines the row sent are kept.
    expect(store.rows[0].submitted_lines).toEqual(sent)
    expect(store.rows[0].confirmed_at).toBeInstanceOf(Date)
  })

  it("makes sure an existing row is linked to its order", async () => {
    await createDraft(ctx, { order: order(), lines: [line("978-A")], sequence: 1 })
    expect(store.linkChecks).toEqual([])
    await createDraft(ctx, { order: order(), lines: [line("978-A")], sequence: 1 })
    expect(store.linkChecks).toEqual([store.rows[0].id])
  })

  it("never re-posts once confirmed", async () => {
    await send(order(), [line("978-A")])
    const before = mock.state.requests.length
    const again = await send(order(), [line("978-A")])
    expect(again.create.outcome).toBe("skip-confirmed")
    expect(again.gate).toMatchObject({ ok: false, reason: "already-confirmed" })
    expect(mock.state.requests.length).toBe(before)
  })

  it("leaves a confirmed row alone even when it has no lines left", async () => {
    await send(order(), [line("978-A")])
    const before = { ...store.rows[0] }
    const again = await send(order(), [])
    expect(again.create.outcome).toBe("skip-confirmed")
    expect(store.rows[0]).toEqual(before)
  })

  it("adopts an order confirmed by a run that crashed before writing confirmed_at", async () => {
    const first = await createDraft(ctx, { order: order(), lines: [line("978-A")], sequence: 1 })
    await ctx.client.confirmOrder(first.pt!.uuid, {}) // the crash happens after this call
    const postsBefore = posts().length

    const { create, confirmed, row } = await send(order(), [line("978-A")])
    expect(create.outcome).toBe("adopted-confirmed")
    expect(confirmed).toBeNull()
    expect(posts().length).toBe(postsBefore)
    expect(row?.confirmed_at).toBeInstanceOf(Date)
    expect(store.events.map((e) => e.kind)).toContain("adopted")
  })

  it("re-posts an order Print Trail is holding for its address, never confirmed", async () => {
    const first = await createDraft(ctx, { order: order(), lines: [line("978-A")], sequence: 1 })
    const remote = mock.state.orders.get(first.pt!.uuid)
    Object.assign(remote, { status: "holding", fulfillableStatus: "address-invalid", fulfillableFrom: null })

    const { create, confirmed } = await send(order(), [line("978-A")])
    expect(create.outcome).toBe("draft")
    expect(posts()).toHaveLength(2)
    expect(posts()[1].body.uuid).toBe(first.pt!.uuid)
    expect(confirmed?.outcome).toBe("confirmed")
  })

  it("blocks as a conflict when the order found after a create 409 reads as an unconfirmed draft", async () => {
    const first = await createDraft(ctx, { order: order(), lines: [line("978-A")], sequence: 1 })
    mock.fail(/\/orders$/, 409, { type: "about:blank", title: "Conflict", status: 409, detail: "already been confirmed" }, 1)

    const { create, confirmed, row, events } = await send(order(), [line("978-A")])
    expect(create).toMatchObject({
      outcome: "blocked",
      rowId: first.rowId,
      blockReason: "conflict",
      detail: "already been confirmed",
    })
    expect(confirmed).toBeNull()
    expect(row).toMatchObject({ confirmed_at: null, block_reason: "conflict", attention: "conflict" })
    expect(events.map((e) => e.name)).toEqual(["print_trail.order.blocked"])
    expect(store.events.map((e) => e.kind)).toContain("blocked")
    expect(mock.state.requests.filter((r) => r.path.endsWith("/confirm"))).toHaveLength(0)
  })

  const conflict = { type: "about:blank", title: "Conflict", status: 409, detail: "already been confirmed" }

  it("retries later when the lookup after a create 409 can't reach Print Trail", async () => {
    mock.fail(/\/orders$/, 409, conflict, 1)
    mock.fail(/\/orders$/, 503, undefined, 5)
    const { create, row } = await send(order(), [line("978-A")])
    expect(create.outcome).toBe("transient")
    expect(row).toMatchObject({ pending_action: "send", attempts: { send: 1 } })
  })

  it("blocks with the 409's detail when the lookup after it is refused", async () => {
    mock.fail(/\/orders$/, 409, conflict, 1)
    mock.fail(/\/orders$/, 403, { type: "about:blank", title: "Forbidden", status: 403, detail: "nope" }, 1)
    const { create, row } = await send(order(), [line("978-A")])
    expect(create).toMatchObject({ outcome: "blocked", blockReason: "conflict", detail: "already been confirmed" })
    expect(row?.block_reason).toBe("conflict")
  })

  describe("API 1.2.0 input limits", () => {
    it("blocks an order over the limits without posting it, and never retries it", async () => {
      const long = "S".repeat(256)
      const { create, row } = await send(order(), [line("978-A"), line(long)])
      expect(create).toMatchObject({ outcome: "blocked", blockReason: "over-limits", detail: expect.stringContaining("SKU longer than 255") })
      expect(row).toMatchObject({ block_reason: "over-limits", attention: "over-limits", pending_action: null })
      expect(mock.state.requests.filter((r) => r.method === "POST" && r.path.endsWith("/orders"))).toHaveLength(0)
    })

    it("blocks a quantity that isn't a whole number instead of rounding or dropping it", async () => {
      const { create, row } = await send(order(), [line("978-A"), line("978-B", 1.5), line("978-C", 0.5)])
      expect(create).toMatchObject({
        outcome: "blocked",
        blockReason: "over-limits",
        detail: "Over Print Trail's limits: a quantity that isn't a whole number on lines item_978-B, item_978-C",
      })
      expect(row).toMatchObject({ block_reason: "over-limits", attention: "over-limits", pending_action: null })
      expect(mock.state.requests.filter((r) => r.method === "POST" && r.path.endsWith("/orders"))).toHaveLength(0)
    })

    it("checks the number the payload hook set", async () => {
      const prepared = preparePayload({ order: order(), lines: [line("978-A")], orderNumber: "ORD-1001", options: ctx.options })
      if (!prepared.ok) throw new Error("expected a payload")
      prepared.payload.printTrailOrderNumber = "P".repeat(300)
      const { create } = await send(order(), [line("978-A")], 1, { prepared })
      expect(create).toMatchObject({ blockReason: "over-limits", detail: expect.stringContaining("printTrailOrderNumber") })
    })

    it("a 422 for a limit Print Trail enforces anyway is a refusal with its violations", async () => {
      mock.fail(/\/orders$/, 422, {
        type: "about:blank",
        status: 422,
        title: "Validation errors",
        violations: [{ property: "orderLines", message: "The order lines may not have more than 500 items." }],
      }, 1)
      const { create, row } = await send(order(), [line("978-A")])
      expect(create).toMatchObject({ outcome: "blocked", blockReason: "rejected-422", detail: "orderLines: The order lines may not have more than 500 items." })
      expect(row).toMatchObject({ pending_action: null })
    })
  })

  describe("API 1.2.0 access refusals", () => {
    const inactive = {
      type: "https://docs.printtrail.com/channel-api/problems/channel-inactive",
      title: "Channel inactive",
      status: 403,
      detail: "This channel is inactive in Print Trail.",
    }

    const unauthorised = { type: "about:blank", title: "Unauthorized", status: 401, detail: "Unauthenticated." }

    it("a create refused for the token or an inactive channel waits for access, uncounted, then goes through", async () => {
      mock.fail(/\/orders$/, 401, unauthorised, 1)
      const first = await send(order(), [line("978-A")])
      expect(first.create).toMatchObject({ outcome: "transient", deferral: { refusal: "auth-failed" } })
      expect(first.row).toMatchObject({ pending_action: "send", attention: "auth-failed" })
      expect(first.row!.block_reason ?? null).toBeNull()
      expect(first.row!.attempts?.send ?? 0).toBe(0)
      expect(first.events.map((e) => e.name)).toContain("print_trail.order.attention")

      mock.fail(/\/orders$/, 403, inactive, 1)
      const second = await send(order(), [line("978-A")])
      expect(second.row).toMatchObject({ pending_action: "send", attention: "channel-inactive" })
      expect(second.row!.attempts?.send ?? 0).toBe(0)

      // Access is back: the due send goes through and clears the attention.
      const third = await send(order(), [line("978-A")])
      expect(third.confirmed?.outcome).toBe("confirmed")
      expect(third.row).toMatchObject({ attention: null, pending_action: null })
    })

    it("a confirm refused for access waits, uncounted, with the draft kept", async () => {
      mock.fail(/\/confirm$/, 403, inactive, 1)
      const a = await send(order(), [line("978-A")])
      expect(a.confirmed).toMatchObject({ outcome: "transient", deferral: { refusal: "channel-inactive" } })
      expect(a.row).toMatchObject({ pending_action: "confirm", attention: "channel-inactive", confirmed_at: null })
      expect(a.row!.attempts?.confirm ?? 0).toBe(0)
      const b = await send(order(), [line("978-A")])
      expect(b.confirmed?.outcome).toBe("confirmed")
      expect(b.row).toMatchObject({ attention: null, pending_action: null })
      expect(mock.state.requests.filter((r) => r.method === "POST" && r.path.endsWith("/orders"))).toHaveLength(2)
    })

    it("a deferral never overwrites attention another flow owns", async () => {
      for (const [i, attention] of ["retry-cap:confirm", "stock-shortfall", "pt-order-missing"].entries()) {
        const o = order({ id: `order_${i}`, display_id: 2000 + i })
        mock.fail(/\/confirm$/, 403, inactive, 1)
        const first = await send(o, [line("978-A")])
        expect(first.row).toMatchObject({ pending_action: "confirm", attention: "channel-inactive" })
        // Another flow raises its own attention meanwhile.
        await store.updatePrintTrailOrders({ id: first.row!.id, attention })
        mock.fail(/\/confirm$/, 401, unauthorised, 1)
        const waiting = await send(o, [line("978-A")])
        expect(waiting.confirmed?.outcome).toBe("transient")
        expect(store.rows.find((r) => r.id === first.row!.id)).toMatchObject({ pending_action: "confirm", attention })
        expect(waiting.events.map((e) => e.name)).not.toContain("print_trail.order.attention")
      }
    })

    it("an inactive team (no problem type) stays a manual block with Print Trail's detail", async () => {
      mock.fail(/\/confirm$/, 403, { type: "about:blank", title: "Forbidden", status: 403, detail: "This team is inactive. Orders cannot be created, imported or processed." }, 1)
      const b = await send(order(), [line("978-A")])
      expect(b.confirmed).toMatchObject({ outcome: "rejected-403", detail: expect.stringContaining("team is inactive") })
      expect(b.row).toMatchObject({ block_reason: "rejected-403", pending_action: null })
      expect(store.events.map((e) => e.message).join("\n")).toContain("This team is inactive")
    })

    it("a request the client's Retry-After pause kept back costs no attempt and waits the pause", async () => {
      // A 429 with a long Retry-After: the request is refused at once.
      mock.fail(/\/orders$/, 429, { status: 429, title: "Too Many Requests", detail: "Too many requests." }, 1, { "Retry-After": "120" })
      const sent = await send(order(), [line("978-A")])
      // Print Trail saw that one: an attempt, the usual delay.
      expect(sent.row).toMatchObject({ pending_action: "send", attempts: { send: 1 } })
      // The next run is kept back by the pause: no request, no attempt.
      const before = mock.state.requests.length
      const kept = await send(order(), [line("978-A")])
      expect(mock.state.requests.length).toBe(before)
      expect(kept.create).toMatchObject({ outcome: "transient", deferral: { refusal: null } })
      expect(kept.row).toMatchObject({ pending_action: "send", attempts: { send: 1 } })
      const due = new Date(kept.row!.next_attempt_at as Date).getTime() - NOW.getTime()
      expect(due).toBeGreaterThan(100_000)
      expect(due).toBeLessThanOrEqual(120_000)
    })
  })

  const lookups = () => mock.state.requests.filter((r) => r.method === "GET" && r.path.includes("order-number="))
  const remoteOrder = async (orderNumber: string, confirmIt: boolean) => {
    const pt = await ctx.client.createOrder({
      orderNumber,
      orderLines: [{ quantity: 1, lineNumber: "item_978-A", product: { sku: "978-A" } }],
    })
    if (confirmIt) await ctx.client.confirmOrder(pt.uuid, { defaultShippingMethod: "standard" })
    return mock.state.orders.get(pt.uuid)
  }

  it("adopts a typed 409's order without looking it up (a lost row)", async () => {
    const remote = await remoteOrder("ORD-1001", true)
    const { create, confirmed, row } = await send(order(), [line("978-A")])
    expect(create.outcome).toBe("adopted-confirmed")
    expect(confirmed).toBeNull()
    expect(lookups()).toHaveLength(0)
    expect(row).toMatchObject({ pt_uuid: remote.uuid, status: "queued" })
    expect(row?.block_reason ?? null).toBeNull()
    expect(row?.confirmed_at).toEqual(new Date(remote.confirmedAt))
    expect(mock.state.requests.filter((r) => r.path.endsWith("/confirm"))).toHaveLength(1)
  })

  it("blocks a not-updatable 409 and records the order", async () => {
    const remote = await remoteOrder("ORD-1001", false)
    mock.setStatus(remote.uuid, "complete")
    const { create, row } = await send(order(), [line("978-A")])
    expect(create).toMatchObject({ outcome: "blocked", blockReason: "conflict" })
    expect(create.detail).toMatch(/can no longer be updated/)
    expect(lookups()).toHaveLength(0)
    expect(row).toMatchObject({ pt_uuid: remote.uuid, status: "complete", confirmed_at: null, block_reason: "conflict" })
  })

  // API 1.1.1: a replayed create for a confirmed order that has since
  // finished answers not-updatable. The order in data says it was confirmed.
  const confirms = () => mock.state.requests.filter((r) => r.path.endsWith("/confirm"))
  const finishOrder = (uuid: string, status: string) => {
    if (status === "complete") return mock.dispatch(uuid)
    const remote = mock.state.orders.get(uuid)
    remote.fulfilments.forEach((f: any) => (f.status = status === "failed" ? "failed" : "dispatched"))
    if (status === "partial") remote.fulfilments[0].status = "failed"
    remote.status = status
  }

  it.each(["complete", "partial", "failed", "returned"])(
    "adopts a confirmed order since %s from a not-updatable 409 (a lost row), and schedules its sync",
    async (status) => {
      const remote = await remoteOrder("ORD-1001", true)
      finishOrder(remote.uuid, status)
      const { create, gate, confirmed, row } = await send(order(), [line("978-A")])
      expect(posts()).toHaveLength(2)
      expect(create.outcome).toBe("adopted-confirmed")
      expect(gate.ok).toBe(false)
      expect(confirmed).toBeNull()
      expect(lookups()).toHaveLength(0)
      expect(confirms()).toHaveLength(1)
      expect(row).toMatchObject({ pt_uuid: remote.uuid, status })
      expect(row?.block_reason ?? null).toBeNull()
      expect(row?.confirmed_at).toEqual(new Date(remote.confirmedAt))
      // The lost row's lines are what Print Trail has, so completion and the
      // remainder check see them as sent.
      expect(row?.submitted_lines).toEqual([{ quantity: 1, lineNumber: "item_978-A", product: { sku: "978-A" } }])
      // Nothing else will tell the store about a finished order: the sweep
      // syncs it (dispatch, completion, attention) at once.
      expect(row).toMatchObject({ pending_action: "refetch", next_attempt_at: NOW })
      expect(row?.attention ?? null).toBeNull()
      // A later run leaves it alone.
      const again = await send(order(), [line("978-A")])
      expect(again.create.outcome).toBe("skip-confirmed")
      expect(posts()).toHaveLength(2)
      expect(confirms()).toHaveLength(1)
    }
  )

  it("adopts a confirmed order since finished after a lost confirm response, without re-posting", async () => {
    const first = await createDraft(ctx, { order: order(), lines: [line("978-A")], sequence: 1 })
    await ctx.client.confirmOrder(first.pt!.uuid, { defaultShippingMethod: "standard" }) // its response is lost
    mock.dispatch(first.pt!.uuid)
    const { create, confirmed, row } = await send(order(), [line("978-A")])
    expect(create.outcome).toBe("adopted-confirmed")
    expect(confirmed).toBeNull()
    expect(posts()).toHaveLength(1)
    expect(confirms()).toHaveLength(1)
    expect(row).toMatchObject({ status: "complete", pending_action: "refetch", next_attempt_at: NOW })
    expect(row?.confirmed_at).toEqual(new Date(mock.state.orders.get(first.pt!.uuid).confirmedAt))
  })

  it("adopting a row an older plugin blocked as a conflict clears the block", async () => {
    const remote = await remoteOrder("ORD-1001", true)
    mock.dispatch(remote.uuid)
    // As the plugin before API 1.1.1 left it: blocked, uuid recorded.
    await createDraft(ctx, { order: order(), lines: [line("978-A")], sequence: 1 })
    Object.assign(store.rows[0], {
      confirmed_at: null,
      block_reason: "conflict",
      attention: "conflict",
      last_error: "can no longer be updated",
      pending_action: null,
      next_attempt_at: null,
    })
    const { create, row } = await send(order(), [line("978-A")])
    expect(create.outcome).toBe("adopted-confirmed")
    expect(row).toMatchObject({ block_reason: null, attention: null, last_error: null, pending_action: "refetch" })
  })

  it("adopting keeps attention another flow set", async () => {
    const first = await createDraft(ctx, { order: order(), lines: [line("978-A")], sequence: 1 })
    await ctx.client.confirmOrder(first.pt!.uuid, { defaultShippingMethod: "standard" })
    Object.assign(store.rows[0], { attention: "amend-diverged", last_error: "lines differ" })
    const { create, row } = await send(order(), [line("978-A")])
    expect(create.outcome).toBe("adopted-confirmed")
    expect(row).toMatchObject({ attention: "amend-diverged", last_error: "lines differ" })
  })

  describe("what adopting clears", () => {
    // A draft whose confirm reached Print Trail, then the row as another
    // run or flow left it.
    const lostConfirm = async (left: Record<string, unknown>) => {
      const first = await createDraft(ctx, { order: order(), lines: [line("978-A")], sequence: 1 })
      await ctx.client.confirmOrder(first.pt!.uuid, { defaultShippingMethod: "standard" })
      Object.assign(store.rows[0], { confirmed_at: null, ...left })
      return first.pt!.uuid
    }

    it.each(["stock-shortfall", "retry-cap:send", "retry-cap:confirm"])("clears the send path's %s and its error", async (code) => {
      await lostConfirm({ attention: code, last_error: "boom", shortfall: [{ sku: "978-A", requested: 1, available: 0 }] })
      const { create, row } = await send(order(), [line("978-A")])
      expect(create.outcome).toBe("adopted-confirmed")
      expect(row).toMatchObject({ attention: null, last_error: null, shortfall: null })
    })

    it("keeps a Print Trail code and its error", async () => {
      await lostConfirm({ attention: "pt-holding", last_error: "held at Print Trail" })
      const { row } = await send(order(), [line("978-A")])
      expect(row).toMatchObject({ attention: "pt-holding", last_error: "held at Print Trail" })
    })

    it("keeps another flow's attention and its error", async () => {
      await lostConfirm({ attention: "cancel-failed", last_error: "cancel refused" })
      const { row } = await send(order(), [line("978-A")])
      expect(row).toMatchObject({ attention: "cancel-failed", last_error: "cancel refused" })
    })

    it("keeps the blocks the amend flow set", async () => {
      await lostConfirm({ block_reason: "no-pt-lines" })
      expect((await send(order(), [line("978-A")])).row).toMatchObject({ block_reason: "no-pt-lines" })
      Object.assign(store.rows[0], { confirmed_at: null, block_reason: "no-pt-shipping-method", attention: "no-pt-shipping-method" })
      expect((await send(order(), [line("978-A")])).row).toMatchObject({
        block_reason: "no-pt-shipping-method",
        attention: "no-pt-shipping-method",
      })
    })

    it("turns a full refund's block into refunded-not-cancelled attention", async () => {
      await lostConfirm({ block_reason: "fully-refunded", last_error: null })
      const { create, row, events } = await send(order(), [line("978-A")])
      expect(create.outcome).toBe("adopted-confirmed")
      expect(row).toMatchObject({ block_reason: null, attention: "refunded-not-cancelled" })
      const entry = store.events.find((e) => e.kind === "refunded-not-cancelled")
      expect(entry).toMatchObject({ data: expect.objectContaining({ kind: "refunded-not-cancelled" }) })
      expect(entry?.message).toContain(row!.pt_order_number)
      expect(events).toContainEqual({
        name: "print_trail.order.attention",
        data: expect.objectContaining({ attention: "refunded-not-cancelled" }),
      })
    })

    it("leaves another flow's attention in place of the refund's, but still notes the refund", async () => {
      await lostConfirm({ block_reason: "fully-refunded", attention: "cancel-failed", last_error: "cancel refused" })
      const { row, events } = await send(order(), [line("978-A")])
      expect(row).toMatchObject({ block_reason: null, attention: "cancel-failed", last_error: "cancel refused" })
      expect(events.filter((e) => e.name === "print_trail.order.attention")).toEqual([])
      expect(store.events.filter((e) => e.kind === "refunded-not-cancelled")).toEqual([
        expect.objectContaining({ data: expect.objectContaining({ kind: "refunded-not-cancelled" }) }),
      ])
    })

    it("raises nothing for a refund the refund flow already noted", async () => {
      await lostConfirm({ block_reason: "fully-refunded" })
      store.events.push({ print_trail_order_id: store.rows[0].id, kind: "refunded-not-cancelled", data: { kind: "refunded-not-cancelled" } })
      const { row, events } = await send(order(), [line("978-A")])
      expect(row).toMatchObject({ block_reason: null })
      expect(row?.attention ?? null).toBeNull()
      expect(events.filter((e) => e.name === "print_trail.order.attention")).toEqual([])
      expect(store.events.filter((e) => e.kind === "refunded-not-cancelled")).toHaveLength(1)
    })

    it("raises nothing for a refund once the Medusa order is cancelled", () => {
      // createDraft stops at a cancelled order before adopting; the rule is
      // the refund flow's all the same.
      const row = { id: "r", order_id: "o", sequence: 1, pt_order_number: "ORD-1", block_reason: "fully-refunded" } as PrintTrailOrderRow
      const remote = { uuid: "u", status: "queued" } as never
      expect(adoptionClears(row, remote, { orderCanceled: true, noted: false })).toMatchObject({ refund: null, columns: { block_reason: null } })
      expect(adoptionClears(row, remote, { orderCanceled: false, noted: false }).refund).toBe("raise")
    })

    it.each(["complete", "cancelled", "returned", "partial", "failed"])("raises nothing for a refund once Print Trail has finished (%s)", (status) => {
      const row = { id: "r", order_id: "o", sequence: 1, pt_order_number: "ORD-1", block_reason: "fully-refunded" } as PrintTrailOrderRow
      expect(adoptionClears(row, { uuid: "u", status } as never, { orderCanceled: false, noted: false }).refund).toBeNull()
    })

    it("raises nothing for a refund once Print Trail has finished the order", async () => {
      const uuid = await lostConfirm({ block_reason: "fully-refunded" })
      mock.dispatch(uuid)
      const { row } = await send(order(), [line("978-A")])
      expect(row).toMatchObject({ block_reason: null, status: "complete" })
      expect(row?.attention ?? null).toBeNull()
    })
  })

  it("adopting starts a new sync cycle: the refetch count is zeroed", async () => {
    const first = await createDraft(ctx, { order: order(), lines: [line("978-A")], sequence: 1 })
    await ctx.client.confirmOrder(first.pt!.uuid, { defaultShippingMethod: "standard" })
    // A refetch capped before the confirm was lost.
    store.rows[0].attempts = { ...store.rows[0].attempts, refetch: 4 }
    const { create, row } = await send(order(), [line("978-A")])
    expect(create.outcome).toBe("adopted-confirmed")
    expect(row).toMatchObject({ pending_action: "refetch", next_attempt_at: NOW })
    expect(row?.attempts?.refetch).toBe(0)
    expect(dueRows([row!], NOW)).toHaveLength(1)
  })

  it("a not-updatable 409 for a never-confirmed returned order is a conflict", async () => {
    const remote = await remoteOrder("ORD-1001", false)
    mock.setStatus(remote.uuid, "returned")
    const { create, row } = await send(order(), [line("978-A")])
    expect(create).toMatchObject({ outcome: "blocked", blockReason: "conflict" })
    expect(row).toMatchObject({ pt_uuid: remote.uuid, status: "returned", confirmed_at: null })
    expect(confirms()).toHaveLength(0)
  })

  it("a conflict-blocked row stays blocked on Resend, and nothing is confirmed", async () => {
    const remote = await remoteOrder("ORD-1001", false)
    mock.setStatus(remote.uuid, "complete")
    const first = await send(order(), [line("978-A")])
    expect(first.row).toMatchObject({ pt_uuid: remote.uuid, block_reason: "conflict" })
    const postsBefore = posts().length
    // Resend: the row now has the uuid, so the run fetches it first.
    const again = await send(order(), [line("978-A")])
    expect(again.create).toMatchObject({ outcome: "blocked", blockReason: "conflict" })
    expect(again.row).toMatchObject({ confirmed_at: null, block_reason: "conflict" })
    // Re-posted, and Print Trail's typed 409 blocks it again.
    expect(posts()).toHaveLength(postsBefore + 1)
    expect(mock.state.requests.filter((r) => r.path.endsWith("/confirm"))).toHaveLength(0)
  })

  it("a 409 for a confirmed order cancelled at Print Trail records the cancel", async () => {
    const remote = await remoteOrder("ORD-1001", true)
    mock.setStatus(remote.uuid, "cancelled")
    const { create, row } = await send(order(), [line("978-A")])
    expect(create.outcome).toBe("remote-cancelled")
    expect(lookups()).toHaveLength(0)
    expect(row).toMatchObject({ pt_uuid: remote.uuid, status: "cancelled", confirmed_at: null })
  })

  it("falls back to the lookup when the 409 has no order (older Print Trail API)", async () => {
    mock.state.legacy = true
    const remote = await remoteOrder("ORD-1001", true)
    const { create, row } = await send(order(), [line("978-A")])
    expect(create.outcome).toBe("adopted-confirmed")
    expect(lookups()).toHaveLength(1)
    expect(row?.pt_uuid).toBe(remote.uuid)
    // No confirmedAt (an older API): the countdown is the confirmation time.
    expect(row?.confirmed_at).toEqual(new Date(remote.fulfillableFrom))
  })

  it("never adopts a 409's order for another order number", async () => {
    const other = await remoteOrder("ORD-9999", true)
    const ours = await remoteOrder("ORD-1001", false)
    mock.setStatus(ours.uuid, "complete")
    mock.fail(/\/orders$/, 409, {
      type: "https://docs.printtrail.com/channel-api/problems/order-already-confirmed",
      title: "Conflict",
      status: 409,
      detail: "already been confirmed",
      orderUuid: other.uuid,
      orderStatus: "queued",
      data: other,
    }, 1)
    const { create, row } = await send(order(), [line("978-A")])
    // Looked up by its own number instead: ours is finished, a conflict.
    expect(lookups()).toHaveLength(1)
    expect(create).toMatchObject({ outcome: "blocked", blockReason: "conflict" })
    expect(row?.pt_uuid).toBe(ours.uuid)
    expect(row?.confirmed_at).toBeNull()
  })

  it("a typed 409 without data keeps its type through the lookup", async () => {
    // A draft-looking order found by number: the type still says confirmed.
    const remote = await remoteOrder("ORD-1001", false)
    mock.fail(/\/orders$/, 409, {
      type: "https://docs.printtrail.com/channel-api/problems/order-already-confirmed",
      title: "Conflict",
      status: 409,
      detail: "already been confirmed",
    }, 1)
    const { create, row } = await send(order(), [line("978-A")])
    expect(create.outcome).toBe("adopted-confirmed")
    expect(lookups()).toHaveLength(1)
    expect(row?.pt_uuid).toBe(remote.uuid)
  })

  it.each(["invalid", "error"])("a never-confirmed %s order is re-posted on Resend, not blocked", async (status) => {
    const first = await createDraft(ctx, { order: order(), lines: [line("978-A")], sequence: 1 })
    // Before confirm: Print Trail marked the draft, nothing under way.
    Object.assign(mock.state.orders.get(first.pt!.uuid), { status })
    const again = await createDraft(ctx, { order: order(), lines: [line("978-A")], sequence: 1 })
    expect(again.outcome).toBe("draft")
    expect(posts()).toHaveLength(2)
    expect(posts()[1].body.uuid).toBe(first.pt!.uuid)
  })

  it("a pre-order line leaves a draft that is never confirmed", async () => {
    // Print Trail before API 1.3.0 (no fallback: the order stays blocked).
    mock.state.preOrderRelease = false
    mock.state.skuStatus["978-A"] = "pre-order"
    const { create, gate, confirmed, row } = await send(order(), [line("978-A")])
    expect(create.outcome).toBe("draft")
    expect(confirmed).toBeNull()
    expect(gate).toMatchObject({ ok: false, reason: "not-fulfillable" })
    expect(mock.state.requests.filter((r) => r.path.endsWith("/confirm"))).toHaveLength(0)
    expect(row).toMatchObject({ status: "draft", fulfillable_status: "not-fulfillable", confirmed_at: null })
  })

  it("re-posts the same draft with its uuid", async () => {
    const first = await createDraft(ctx, { order: order(), lines: [line("978-A")], sequence: 1 })
    await createDraft(ctx, { order: order(), lines: [line("978-A", 3)], sequence: 1 })
    expect(posts()[1].body.uuid).toBe(first.pt!.uuid)
    expect(mock.state.orders.size).toBe(1)
  })

  it("blocks unknown SKUs and never confirms", async () => {
    const { create, confirmed, events, row } = await send(order(), [line("NOPE")])
    expect(create).toMatchObject({ outcome: "blocked", blockReason: "unmatched-skus", unmatchedSkus: ["NOPE"] })
    expect(confirmed).toBeNull()
    expect(row).toMatchObject({ block_reason: "unmatched-skus", attention: "unmatched-skus" })
    expect(events.map((e) => e.name)).toEqual(["print_trail.order.blocked"])
    // Recorded for the SKU check's re-send.
    expect(store.events.find((e) => e.kind === "blocked")).toMatchObject({ data: { unmatched_skus: ["NOPE"] } })
  })

  it("blocks an incomplete address before it reaches Print Trail", async () => {
    const { create } = await send(order({ shipping_address: { ...address, country_code: null } }), [line("978-A")])
    expect(create).toMatchObject({ outcome: "blocked", blockReason: "address-incomplete" })
    expect(posts()).toHaveLength(0)
  })

  it("records a stock shortfall and schedules a confirm retry", async () => {
    const { confirmed, row, events } = await send(order(), [line("978-B", 2)])
    expect(confirmed?.outcome).toBe("stock")
    expect(row).toMatchObject({
      pending_action: "confirm",
      attempts: { confirm: 1 },
      next_attempt_at: new Date("2026-10-18T12:15:00Z"),
      attention: "stock-shortfall",
      shortfall: [{ sku: "978-B", requested: 2, available: 0 }],
      confirmed_at: null,
    })
    expect(events.map((e) => e.name)).toContain("print_trail.order.blocked")
  })

  it("schedules a send retry when Print Trail can't be reached", async () => {
    mock.fail(/\/orders$/, 503, undefined, 5)
    const { create, row } = await send(order(), [line("978-A")])
    expect(create.outcome).toBe("transient")
    expect(row).toMatchObject({ pending_action: "send", attempts: { send: 1 } })
  })

  it("never posts for an order Medusa has cancelled", async () => {
    const { create, gate, confirmed } = await send(order({ canceled_at: "2026-10-18T11:00:00Z" }), [line("978-A")])
    expect(create).toMatchObject({ outcome: "order-canceled", rowId: null })
    expect(gate).toMatchObject({ ok: false, reason: "order-canceled" })
    expect(confirmed).toBeNull()
    expect(mock.state.requests).toHaveLength(0)
    expect(store.rows).toHaveLength(0)
  })

  it("queues a cancel when the gate finds the order cancelled after the draft was posted", async () => {
    ctx.reloadGateState = async () => ({
      status: "canceled",
      canceled_at: "2026-10-18T12:00:01Z",
      payment_collections: [{ captured_amount: 0, refunded_amount: 0 }],
    })
    const { row } = await send(order(), [line("978-A")])
    expect(row).toMatchObject({
      cancel_requested: true,
      cancel_status: "requested",
      pending_action: "cancel",
      next_attempt_at: NOW,
    })
    expect(row?.attempts).toEqual({ send: 0, confirm: 0 })
    expect(store.events.map((e) => e.kind)).toContain("cancel-requested")
  })

  it("queues a cancel for a cancelled order whose draft was posted earlier", async () => {
    await createDraft(ctx, { order: order(), lines: [line("978-A")], sequence: 1 })
    const { create, row } = await send(order({ canceled_at: "2026-10-18T11:00:00Z" }), [line("978-A")])
    expect(create.outcome).toBe("order-canceled")
    expect(row).toMatchObject({ cancel_status: "requested", pending_action: "cancel" })
    expect(posts()).toHaveLength(1)
  })

  it("a successful confirm keeps a pending cancel", async () => {
    const { confirmed, row } = await send(order(), [line("978-A")], 1, {
      beforeConfirm: () => Object.assign(store.rows[0], { pending_action: "cancel", next_attempt_at: NOW }),
    })
    expect(confirmed?.outcome).toBe("confirmed")
    expect(row).toMatchObject({ pending_action: "cancel", next_attempt_at: NOW, confirmed_at: NOW })
  })

  it("a transient confirm keeps a pending cancel", async () => {
    mock.fail(/\/confirm$/, 503, { message: "down" }, 99)
    const { row } = await send(order(), [line("978-A")], 1, {
      beforeConfirm: () => Object.assign(store.rows[0], { pending_action: "cancel", next_attempt_at: NOW }),
    })
    expect(row).toMatchObject({ pending_action: "cancel", next_attempt_at: NOW })
  })

  it("a gate refusal keeps a pending amend", async () => {
    ctx.options = { ...ctx.options, confirmOn: "payment.captured" }
    const { gate, row } = await send(order(), [line("978-A")], 1, {
      beforeConfirm: () => Object.assign(store.rows[0], { pending_action: "amend", next_attempt_at: NOW }),
    })
    expect(gate.reason).toBe("awaiting-payment")
    expect(row).toMatchObject({ pending_action: "amend", next_attempt_at: NOW })
  })

  it("records a held row when every line is held", async () => {
    const selected = [line("978-A", 2)]
    const { create, row } = await send(order(), [], 1, { selected })
    expect(create.outcome).toBe("held")
    expect(posts()).toHaveLength(0)
    expect(row).toMatchObject({
      block_reason: "held",
      held_lines: [{ lineItemId: "item_978-A", quantity: 2 }],
      pending_action: null,
      attention: null,
    })
    expect(store.events.map((e) => e.kind)).toEqual(["held"])

    // Still held: nothing new.
    await send(order(), [], 1, { selected })
    expect(store.events.map((e) => e.kind)).toEqual(["held"])
    expect(store.rows[0]).toMatchObject({ block_reason: "held", attention: null })

    // Released: posts and clears the held state.
    const released = await send(order(), selected, 1, { selected })
    expect(released.confirmed?.outcome).toBe("confirmed")
    expect(posts()).toHaveLength(1)
    expect(released.row).toMatchObject({ block_reason: null, held_lines: null })
  })

  it("records lines held back from a posted row", async () => {
    const selected = [line("978-A", 2), line("US-1", 1)]
    const { row } = await send(order(), [line("978-A", 2)], 1, { selected })
    expect(row?.held_lines).toEqual([{ lineItemId: "item_US-1", quantity: 1 }])
    expect(store.events.map((e) => e.kind)).not.toContain("held")
  })

  it("stores the address hash on post", async () => {
    const { row } = await send(order(), [line("978-A")])
    const prepared = preparePayload({ order: order(), lines: [line("978-A")], orderNumber: "ORD-1001", options: ctx.options })
    expect(row?.address_hash).toBe(prepared.ok && prepared.addressHash)
  })

  it("gates on the order as it is now, not as it was loaded", async () => {
    // Cancelled while the draft was being created.
    ctx.reloadGateState = async () => ({
      status: "canceled",
      canceled_at: "2026-10-18T12:00:01Z",
      payment_collections: [{ captured_amount: 0, refunded_amount: 0 }],
    })
    const { gate, confirmed, row } = await send(order(), [line("978-A")])
    expect(gate).toMatchObject({ ok: false, reason: "order-canceled" })
    expect(confirmed).toBeNull()
    expect(mock.state.requests.filter((r) => r.path.endsWith("/confirm"))).toHaveLength(0)
    expect(row?.block_reason).toBe("order-canceled")
  })

  it("gates on a refund made while the draft was being created", async () => {
    ctx.reloadGateState = async () => ({
      status: "pending",
      canceled_at: null,
      payment_collections: [{ captured_amount: 20, refunded_amount: 20 }],
    })
    const { gate } = await send(order({ payment_collections: [{ captured_amount: 20, refunded_amount: 0 }] }), [
      line("978-A"),
    ])
    expect(gate).toMatchObject({ ok: false, reason: "fully-refunded" })
  })

  it("blocks a method one fulfilment can't ship by, without downgrading", async () => {
    const { gate, confirmed, row } = await send(order(), [
      line("978-A", 1, "tracked"),
      line("US-1", 1, "tracked"),
    ])
    expect(gate).toMatchObject({ ok: false, reason: "blocked:shipping-method-unavailable" })
    expect(confirmed).toBeNull()
    expect(row?.attention).toBe("shipping-method-unavailable")
  })

  it("notes on the timeline when a merged fulfilment ships below a line's method", async () => {
    // US1 offers only standard; both lines land in its one fulfilment.
    const { confirmed } = await send(order(), [
      line("US-1", 1, "tracked", "item_1"),
      line("US-1", 1, "standard", "item_2"),
    ])
    expect(confirmed?.outcome).toBe("confirmed")
    const note = store.events.find((e) => e.kind === "shipping-downgraded")
    expect(note?.message).toMatch(/ships standard; tracked isn't offered for it$/)
  })

  it("records the rebuilt confirm's downgrade notes, not the gate's", async () => {
    const o = order()
    const lines = [line("US-1", 1, "tracked", "item_1"), line("US-1", 1, "standard", "item_2")]
    const create = await createDraft(ctx, { order: o, lines, sequence: 1 })
    const gate = confirmGate(ctx.options, o, create)
    expect(gate.notes).toHaveLength(1)
    const remote = mock.state.orders.get(create.pt!.uuid)
    Object.assign(remote.fulfilments[0], { uuid: "regenerated", fulfilmentNumber: "REGEN-1" })
    remote.orderLines.forEach((l: any) => (l.fulfilmentUuid = "regenerated"))
    mock.fail(/\/confirm$/, 409, { type: "about:blank", title: "Conflict", status: 409, detail: "regenerated", data: remote }, 1)

    const confirmed = await confirm(ctx, { rowId: create.rowId!, pt: create.pt!, body: gate.body!, methodByLine: create.methodByLine })
    await recordOutcome(ctx, { orderId: o.id, create, gate, confirm: confirmed })
    expect(store.events.filter((e) => e.kind === "shipping-downgraded").map((e) => e.message)).toEqual([
      "Fulfilment REGEN-1 ships standard; tracked isn't offered for it",
    ])
  })

  it("rebuilds the confirm once after a shipping-selection conflict", async () => {
    const create = await createDraft(ctx, { order: order(), lines: [line("978-A", 1, "tracked")], sequence: 1 })
    const gate = confirmGate(ctx.options, order(), create)
    // Print Trail regenerated the fulfilments since the draft was read.
    const remote = mock.state.orders.get(create.pt!.uuid)
    remote.fulfilments[0].uuid = "regenerated"
    remote.orderLines.forEach((l: any) => (l.fulfilmentUuid = "regenerated"))
    mock.fail(/\/confirm$/, 409, { type: "about:blank", title: "Conflict", status: 409, detail: "regenerated", data: remote }, 1)

    const result = await confirm(ctx, { rowId: create.rowId!, pt: create.pt!, body: gate.body!, methodByLine: create.methodByLine })
    expect(result.outcome).toBe("confirmed")
    const confirms = mock.state.requests.filter((r) => r.path.endsWith("/confirm"))
    expect(confirms[1].body.fulfilmentShippingMethods).toEqual([
      { fulfilmentUuid: "regenerated", shippingMethod: "tracked" },
    ])
  })

  // The conflict's regenerated snapshot is stored with the
  // row, so a fulfilment it shows waiting for its pre-order release is recorded.
  it("records a pre-order wait seen in a shipping conflict's snapshot", async () => {
    const create = await createDraft(ctx, { order: order(), lines: [line("978-A", 1, "tracked")], sequence: 1 })
    const gate = confirmGate(ctx.options, order(), create)
    const remote = mock.state.orders.get(create.pt!.uuid)
    remote.fulfilments[0].uuid = "regenerated"
    remote.orderLines.forEach((l: any) => (l.fulfilmentUuid = "regenerated"))
    const conflict = JSON.parse(JSON.stringify(remote))
    Object.assign(conflict.fulfilments[0], { status: "back-order", backOrderReason: "pre-order" })
    mock.fail(/\/confirm$/, 409, { type: "about:blank", title: "Conflict", status: 409, detail: "regenerated", data: conflict }, 1)

    const result = await confirm(ctx, { rowId: create.rowId!, pt: create.pt!, body: gate.body!, methodByLine: create.methodByLine })
    expect(result.outcome).toBe("confirmed")
    expect(store.rows.find((r) => r.id === create.rowId)?.pre_order_fulfilments).toContain("regenerated")
  })

  it("does nothing for an order without Print Trail lines", async () => {
    const { create, events } = await send(order(), [])
    expect(create).toMatchObject({ outcome: "no-lines", rowId: null })
    expect(events).toEqual([])
    expect(store.rows).toHaveLength(0)
  })

  it("numbers a second Print Trail order on the same Medusa order with -2", async () => {
    await send(order(), [line("978-A")])
    const { row } = await send(order(), [line("978-A", 1, "standard", "item_later")], 2)
    expect(row?.pt_order_number).toBe("ORD-1001-2")
    expect(mock.state.orders.size).toBe(2)
  })

  it("sends a claim's added items as {prefix}{display_id}-2", async () => {
    const all = [scoped("978-A"), scoped("US-1", 1, "claim:c1", "item_claimed")]
    await sendTo(order(), all)
    const { row, confirmed } = await sendTo(order(), all, { source_ref: "claim:c1" })
    expect(confirmed?.outcome).toBe("confirmed")
    expect(row).toMatchObject({ sequence: 2, source_ref: "claim:c1", pt_order_number: "ORD-1001-2" })
    expect(posts().map((p) => p.body.orderNumber)).toEqual(["ORD-1001", "ORD-1001-2"])
    expect(posts()[0].body.orderLines.map((l: any) => l.lineNumber)).toEqual(["item_978-A"])
    expect(posts()[1].body.orderLines.map((l: any) => l.lineNumber)).toEqual(["item_claimed"])
  })

  it("clears the Print Trail cancel on the original once it is re-sent as a new order", async () => {
    const all = [scoped("978-A")]
    const first = await sendTo(order(), all)
    await store.updatePrintTrailOrders({ id: first.row!.id, status: "cancelled", attention: "pt-cancelled" })
    const { row, confirmed } = await sendTo(order(), all, { reissue_of: 1 })
    expect(confirmed?.outcome).toBe("confirmed")
    expect(row).toMatchObject({ sequence: 2, source_ref: "reissue:1" })
    expect(store.rows.find((r) => r.id === first.row!.id)?.attention).toBeNull()
  })

  it("a replayed claim reuses its row", async () => {
    const all = [scoped("978-A"), scoped("US-1", 1, "claim:c1", "item_claimed")]
    await sendTo(order(), all)
    await sendTo(order(), all, { source_ref: "claim:c1" })
    const replay = await sendTo(order(), all, { source_ref: "claim:c1" })
    expect(replay.create.outcome).toBe("skip-confirmed")
    expect(store.rows).toHaveLength(2)
    expect(posts()).toHaveLength(2)
  })

  it("makes no row for a claim with no Print Trail items", async () => {
    await sendTo(order(), [scoped("978-A")])
    const { create } = await sendTo(order(), [scoped("978-A")], { source_ref: "claim:c2" })
    expect(create).toMatchObject({ outcome: "no-lines", rowId: null })
    expect(store.rows).toHaveLength(1)
  })

  it("releases held pre-order lines as a remainder once sequence 1 is confirmed", async () => {
    const all = [scoped("978-A"), scoped("US-1", 2)]
    // filterLines held US-1 on placement.
    const first = await send(order(), [line("978-A")], 1, { selected: all.map(({ replacementOf: _r, ...l }) => l) })
    expect(first.row?.held_lines).toEqual([{ lineItemId: "item_US-1", quantity: 2 }])
    const { row } = await sendTo(order(), all)
    expect(row).toMatchObject({ sequence: 2, source_ref: "remainder:2", pt_order_number: "ORD-1001-2" })
    expect(posts()[1].body.orderLines).toEqual([{ quantity: 2, lineNumber: "item_US-1", product: { sku: "US-1" } }])
    // Nothing left to release: no third order.
    const again = await sendTo(order(), all)
    expect(again.create.outcome).toBe("no-lines")
    expect(posts()).toHaveLength(2)
  })

  it("sends the prepared payload, with the row's uuid, and stores its address hash", async () => {
    const all = [scoped("978-A")]
    mock.fail(/\/confirm$/, 503, { message: "down" }, 99)
    await sendTo(order(), all)
    const uuid = store.rows[0].pt_uuid
    await sendTo(order(), all, { sequence: 1 })
    expect(posts()[1].body.uuid).toBe(uuid)
    expect(store.rows[0].address_hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it("queues a cancel for a cancelled order's row whose uuid was never stored", async () => {
    jest.spyOn(ctx.client, "createOrder").mockRejectedValueOnce(new Error("process died"))
    await expect(createDraft(ctx, { order: order(), lines: [line("978-A")], sequence: 1 })).rejects.toThrow()
    const { row } = await send(order({ canceled_at: "2026-10-18T11:00:00Z" }), [line("978-A")])
    expect(row?.pt_uuid).toBeFalsy()
    expect(row).toMatchObject({ cancel_status: "requested", pending_action: "cancel" })
  })

  it("blocks a number another Medusa order's Print Trail order already has", async () => {
    await store.createPrintTrailOrders({ order_id: "order_other", sequence: 1, pt_order_number: "SHOP-77", pt_uuid: "u-other" })
    const { create, gate, row } = await send(order(), [line("978-A")], 1, { orderNumber: "SHOP-77" })
    expect(create).toMatchObject({ outcome: "blocked", blockReason: "order-number-taken" })
    expect(gate.ok).toBe(false)
    expect(posts()).toHaveLength(0)
    expect(row).toMatchObject({ block_reason: "order-number-taken", attention: "order-number-taken" })
  })

  it("a row blocked on a taken number never blocks the row that has it", async () => {
    const original = await store.createPrintTrailOrders({ order_id: "order_other", sequence: 1, pt_order_number: "SHOP-77" })
    await send(order(), [line("978-A")], 1, { orderNumber: "SHOP-77" })
    const theirs = await createDraft(ctx, { order: order({ id: "order_other", display_id: 77 }), lines: [line("978-A")], sequence: 1 })
    expect(theirs).toMatchObject({ rowId: original.id, outcome: "draft" })
  })
})

// API 1.3.0: back-orders on confirm.
describe("confirming into a back-order", () => {
  it("a confirm into an out-of-stock back-order needs no retry", async () => {
    mock.state.backorderWarehouse = true
    const { confirmed, row, events } = await send(order(), [line("978-B", 2)])
    expect(confirmed?.outcome).toBe("confirmed")
    expect(row).toMatchObject({
      confirmed_at: NOW,
      pending_action: null,
      attention: "pt-fulfilment-back-order",
      shortfall: null,
      block_reason: null,
    })
    expect(events.filter((e) => e.name === "print_trail.order.attention")).toEqual([
      {
        name: "print_trail.order.attention",
        data: expect.objectContaining({ attention: "pt-fulfilment-back-order", back_order_skus: ["978-B"] }),
      },
    ])
    expect(events.map((e) => e.name)).not.toContain("print_trail.order.blocked")
    expect(store.events.map((e) => e.message)).toContain("Print Trail accepted the order with a back-order: 978-B out of stock")

    // Without a back-order warehouse: today's shortfall, unchanged.
    mock.state.backorderWarehouse = false
    const today = await send(order({ id: "order_2", display_id: 1002 }), [line("978-B", 2)])
    expect(today.confirmed?.outcome).toBe("stock")
    expect(today.row).toMatchObject({ pending_action: "confirm", attention: "stock-shortfall" })
    expect(today.events.map((e) => e.name)).toContain("print_trail.order.blocked")
  })

  it("a confirm with a waiting pre-order part needs no attention", async () => {
    mock.state.stock["PRE-1"] = 0
    mock.state.skuStatus["PRE-1"] = "pre-order"
    const { confirmed, row, events } = await send(order(), [line("978-A"), line("PRE-1")])
    expect(confirmed?.outcome).toBe("confirmed")
    expect(row).toMatchObject({ confirmed_at: NOW, attention: null })
    expect(events.map((e) => e.name)).not.toContain("print_trail.order.attention")
    expect(store.events.map((e) => e.message)).toContainEqual(
      expect.stringMatching(/^Print Trail fulfilment .+ is waiting for the pre-order release$/)
    )
    // Marked as seen on pre-order for the activation scan.
    expect(await store.seen.preOrderSeen(["PRE-1", "978-A"])).toEqual(["PRE-1"])
  })

  it("a confirm over a pre-order limit is today's shortfall", async () => {
    mock.state.stock["PRE-1"] = 0
    mock.state.skuStatus["PRE-1"] = "pre-order"
    mock.state.preOrderLimit = { "PRE-1": 2 }
    const first = await send(order(), [line("PRE-1", 2)])
    expect(first.confirmed?.outcome).toBe("confirmed")
    const { confirmed, row, events } = await send(order({ id: "order_2", display_id: 1002 }), [line("PRE-1", 1)])
    expect(confirmed?.outcome).toBe("stock")
    expect(row).toMatchObject({
      pending_action: "confirm",
      attention: "stock-shortfall",
      shortfall: [{ sku: "PRE-1", requested: 1, available: 0 }],
    })
    expect(events.filter((e) => e.name === "print_trail.order.blocked")).toEqual([
      { name: "print_trail.order.blocked", data: expect.objectContaining({ reason: "stock-shortfall" }) },
    ])
  })
})

// Only a back-order in the confirm response sets attention at
// confirm; anything else is left to the sync, as before (which also emits
// the attention event and timeline entry).
describe("attention from the confirm response", () => {
  it.each([
    ["holding", { status: "holding" }],
    ["partially-fulfillable", { fulfillableStatus: "partially-fulfillable" }],
  ])("a confirm answered %s leaves attention to the sync", async (_name, over) => {
    const { confirmed, row, events } = await send(order(), [line("978-A")], 1, {
      beforeConfirm: () => {
        const [o] = [...mock.state.orders.values()]
        mock.fail(/\/confirm$/, 202, { data: { ...o, ...over, confirmedAt: "2026-10-18T12:00:00Z" } })
      },
    })
    expect(confirmed?.outcome).toBe("confirmed")
    expect(row?.attention).toBeNull()
    expect(events.map((e) => e.name)).not.toContain("print_trail.order.attention")
  })
})
