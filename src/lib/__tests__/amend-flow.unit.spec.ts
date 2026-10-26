import type { MockPrintTrail } from "../../../dev/mock-print-trail"
import { amendRow, amendRows, leaseAmends, recordAmendIntent, type AmendContext } from "../amend-flow"
import type { ScopedLine } from "../lines"
import { resolveSendTarget, scopedLines } from "../order-scope"
import { checkGate, confirm, createDraft, recordOutcome, type SendContext } from "../send-flow"
import {
  flowClient,
  flowOptions,
  MemoryStore,
  NOW,
  placeAtMock,
  RecordingNotifier,
  startFlowMock,
} from "./flow-fixtures"

let mock: MockPrintTrail
let store: MemoryStore
let ctx: AmendContext

beforeEach(async () => {
  mock = await startFlowMock()
  store = new MemoryStore()
  ctx = {
    store,
    client: flowClient(mock),
    options: flowOptions(mock),
    teamCode: "acme",
    notifier: new RecordingNotifier(),
    logger: { warn: jest.fn(), info: jest.fn() },
    order: { id: "order_1", display_id: 1001 },
    now: () => NOW,
  }
})

afterEach(() => mock.close())

const line = (id: string, sku: string, quantity: number): ScopedLine => ({ lineItemId: id, sku, quantity, method: "standard", replacementOf: null })
const puts = () => mock.state.requests.filter((r) => r.method === "PUT" && r.path.endsWith("/lines"))
const kinds = () => store.kinds()

// As the workflow runs it: the lease step right after the lock, then the row.
async function amend(rowId: string, lines: ScopedLine[], orderCanceled = false) {
  const { leased } = await leaseAmends(store, "order_1", NOW)
  void leased
  const rows = store.rows.map((r) => ({ ...r }))
  return amendRow(ctx, store.row(rowId), rows, lines, orderCanceled)
}

describe("amendRow", () => {
  it("amends a confirmed order and records Print Trail's message", async () => {
    const row = await placeAtMock(mock, store)
    await store.updatePrintTrailOrders({ id: row.id, pending_action: "amend", next_attempt_at: NOW })
    const out = await amend(row.id, [line("item_a", "978-A", 2)])
    expect(out).toMatchObject({ action: "put-lines", result: "amended" })
    expect(puts()[0].body).toEqual({ orderLines: [{ lineNumber: "item_a", quantity: 2 }] })
    const [entry] = store.events.filter((e) => e.kind === "amended")
    expect(entry.message).toContain("Order amended")
    expect(entry.data.pt_url).toBe(`https://app.example/acme/orders/${row.pt_uuid}`)
    expect(store.row(row.id).submitted_lines).toEqual([{ quantity: 2, lineNumber: "item_a", product: { sku: "978-A" } }])
    expect(mock.state.orders.get(row.pt_uuid!).orderLines[0].quantity).toBe(2)
  })

  it("stores the amended order's regenerated fulfilments and schedules a refetch", async () => {
    const row = await placeAtMock(mock, store)
    const before = (row.fulfilments as any[]).map((f) => f.uuid)
    await store.updatePrintTrailOrders({ id: row.id, pending_action: "amend", next_attempt_at: NOW })
    await amend(row.id, [line("item_a", "978-A", 2), line("item_b", "978-B", 1)])
    const after = (store.row(row.id).fulfilments as any[]).map((f) => f.uuid)
    expect(after).not.toEqual(before)
    expect(store.row(row.id)).toMatchObject({ pending_action: "refetch" })
    expect(puts()[0].body.orderLines[1]).toEqual({ lineNumber: "item_b", quantity: 1, product: { sku: "978-B" } })
  })

  it("an unchanged amend writes no entry", async () => {
    const row = await placeAtMock(mock, store)
    // A PUT whose recording died: Print Trail has the new lines, the row doesn't.
    await ctx.client.amendLines(row.pt_uuid!, { orderLines: [{ lineNumber: "item_a", quantity: 2 }] })
    const out = await amend(row.id, [line("item_a", "978-A", 2)])
    expect(out.result).toBe("unchanged")
    expect(kinds()).toEqual([])
    expect(store.row(row.id).submitted_lines).toEqual([{ quantity: 2, lineNumber: "item_a", product: { sku: "978-A" } }])
  })

  it("never amends over a Print Trail edit", async () => {
    const row = await placeAtMock(mock, store)
    mock.fullEdit(row.pt_uuid!)
    const out = await amend(row.id, [line("item_a", "978-A", 2)])
    expect(out.result).toBe("diverged")
    expect(puts()).toHaveLength(0)
    expect(store.row(row.id).attention).toBe("amend-diverged")
    await amend(row.id, [line("item_a", "978-A", 2)])
    expect(kinds()).toEqual(["amend-diverged"])
  })

  it("never amends over lines changed in the Print Trail app", async () => {
    const row = await placeAtMock(mock, store)
    await ctx.client.amendLines(row.pt_uuid!, { orderLines: [{ lineNumber: "item_a", quantity: 5 }] })
    const out = await amend(row.id, [line("item_a", "978-A", 2)])
    expect(out.result).toBe("diverged")
    expect(puts()).toHaveLength(1)
  })

  it("notes Print Trail's refusal once production has started", async () => {
    const row = await placeAtMock(mock, store)
    mock.setStatus(row.pt_uuid!, "processing")
    const out = await amend(row.id, [line("item_a", "978-A", 2)])
    expect(out.result).toBe("refused")
    expect(store.row(row.id)).toMatchObject({ attention: "amend-refused", pending_action: "refetch" })
    const refused = store.events.filter((e) => e.kind === "amend-refused")
    expect(refused).toHaveLength(1)
    expect(refused[0].message).toContain("Print Trail has started on this order.")
    expect(store.row(row.id).status).toBe("processing")
  })

  it("an edit refused for the token or an inactive channel stays pending, uncounted, and is sent once access returns", async () => {
    const row = await placeAtMock(mock, store)
    await recordAmendIntent(store, store.rows, { retry: false }, NOW)
    const inactive = { type: "https://docs.printtrail.com/channel-api/problems/channel-inactive", title: "Channel inactive", status: 403, detail: "inactive" }
    // Refused on the read, then on the PUT: more than the cap, none counted.
    for (const path of [/\/orders\/[^/]+$/, /\/lines$/, /\/orders\/[^/]+$/, /\/lines$/]) {
      mock.fail(path, 403, inactive, 1)
      const out = await amend(row.id, [line("item_a", "978-A", 2)])
      expect(out.result).toBe("retry")
      expect(store.row(row.id)).toMatchObject({ pending_action: "amend", attention: "channel-inactive", next_attempt_at: new Date(NOW.getTime() + 15 * 60_000) })
      expect(store.row(row.id).attempts?.amend ?? 0).toBe(0)
    }
    const out = await amend(row.id, [line("item_a", "978-A", 2)])
    expect(out.result).toBe("amended")
    expect(store.row(row.id).attention).toBeNull()
    expect(puts().length).toBeGreaterThan(0)
  })

  it("a deferral never overwrites attention another flow owns", async () => {
    const row = await placeAtMock(mock, store)
    await store.updatePrintTrailOrders({ id: row.id, attention: "pt-order-missing" })
    await recordAmendIntent(store, store.rows, { retry: false }, NOW)
    mock.fail(/\/lines$/, 401, { type: "about:blank", title: "Unauthorized", status: 401, detail: "Unauthenticated." }, 1)
    expect((await amend(row.id, [line("item_a", "978-A", 2)])).result).toBe("retry")
    expect(store.row(row.id)).toMatchObject({ pending_action: "amend", attention: "pt-order-missing" })
    expect((await amend(row.id, [line("item_a", "978-A", 2)])).result).toBe("amended")
    expect(store.row(row.id).attention).toBe("pt-order-missing")
  })

  it("never sends an edit over Print Trail's limits (API 1.2.0), and says so", async () => {
    const row = await placeAtMock(mock, store)
    const long = "S".repeat(256)
    const out = await amend(row.id, [line("item_a", "978-A", 1), line("item_new", long, 1)])
    expect(out.result).toBe("refused")
    expect(puts()).toHaveLength(0)
    expect(store.row(row.id)).toMatchObject({ attention: "amend-unsent-items", last_error: expect.stringContaining("longer than 255") })
    expect(store.events.find((e) => e.kind === "amend-refused")!.message).toContain("Over Print Trail's limits")
  })

  it("never sends an edit to a quantity that isn't a whole number", async () => {
    const row = await placeAtMock(mock, store)
    const out = await amend(row.id, [line("item_a", "978-A", 1.5)])
    expect(out.result).toBe("refused")
    expect(puts()).toHaveLength(0)
    expect(store.row(row.id).last_error).toContain("a quantity that isn't a whole number on line item_a")
  })

  it("says added items weren't sent when Print Trail refuses them", async () => {
    const row = await placeAtMock(mock, store)
    mock.setStatus(row.pt_uuid!, "processing")
    await amend(row.id, [line("item_a", "978-A", 1), line("item_new", "978-B", 1)])
    expect(store.row(row.id).attention).toBe("amend-unsent-items")
    expect(store.events.find((e) => e.kind === "amend-refused")!.message).toContain("Resend")
  })

  it("retries being-rebuilt and stops at 3", async () => {
    const row = await placeAtMock(mock, store)
    mock.fail(/\/lines$/, 409, { type: "about:blank", title: "Conflict", status: 409, detail: "rebuilding", reason: "being-rebuilt" }, 99)
    await store.updatePrintTrailOrders({ id: row.id, pending_action: "amend", next_attempt_at: NOW })
    const first = await amend(row.id, [line("item_a", "978-A", 2)])
    expect(first.result).toBe("retry")
    expect(store.row(row.id)).toMatchObject({ pending_action: "amend", attempts: { amend: 1 }, next_attempt_at: new Date("2026-10-19T12:15:00Z") })
    await amend(row.id, [line("item_a", "978-A", 2)])
    await amend(row.id, [line("item_a", "978-A", 2)])
    expect(store.row(row.id)).toMatchObject({ attention: "retry-cap:amend", pending_action: null })
    expect(kinds()).toContain("retry-capped")
  })

  it("blocks then cancels a confirmed order whose lines were all removed", async () => {
    const row = await placeAtMock(mock, store)
    const out = await amend(row.id, [])
    expect(out).toMatchObject({ action: "cancel-emptied", result: "cancelled" })
    expect(kinds()).toEqual(["blocked", "cancel-requested", "cancelled"])
    expect(store.row(row.id)).toMatchObject({ block_reason: "no-pt-lines", cancel_status: "cancelled" })
    expect(mock.state.orders.get(row.pt_uuid!).status).toBe("cancelled")
  })

  it("blocks then cancels an emptied draft", async () => {
    const row = await placeAtMock(mock, store, { draft: true })
    const out = await amend(row.id, [])
    expect(out.action).toBe("cancel-emptied")
    expect(kinds()).toEqual(["blocked", "cancel-requested", "cancelled"])
    expect(mock.state.orders.get(row.pt_uuid!).status).toBe("cancelled")
  })

  it("tells the merchant a cancelled order can't be reopened", async () => {
    const row = await placeAtMock(mock, store)
    mock.setStatus(row.pt_uuid!, "cancelled")
    await store.updatePrintTrailOrders({ id: row.id, status: "cancelled" })
    await amend(row.id, [line("item_a", "978-A", 2)])
    await amend(row.id, [line("item_a", "978-A", 2)])
    const entries = store.events.filter((e) => e.kind === "reopen-refused")
    expect(entries).toHaveLength(1)
    expect(entries[0].message).toContain("Resend as a new Print Trail order")
    expect(puts()).toHaveLength(0)
  })

  it("clears its own amend lease when there's nothing to do, and restores a displaced refetch", async () => {
    const row = await placeAtMock(mock, store)
    await store.updatePrintTrailOrders({ id: row.id, pending_action: "amend", next_attempt_at: NOW, attempts: { refetch_displaced: 1 } })
    const out = await amend(row.id, [line("item_a", "978-A", 1)])
    expect(out.result).toBe("none")
    expect(store.row(row.id).pending_action).toBe("refetch")
    expect(store.row(row.id).attempts?.refetch_displaced ?? 0).toBe(0)
  })

  it("hands a resend back with no amend lease left", async () => {
    const row = await placeAtMock(mock, store, { draft: true })
    await store.updatePrintTrailOrders({ id: row.id, pending_action: "amend", next_attempt_at: NOW })
    const out = await amend(row.id, [line("item_a", "978-A", 2)])
    expect(out.result).toBe("resend")
    expect(store.row(row.id)).toMatchObject({ pending_action: null, next_attempt_at: null })
  })
})

describe("amend retries and shared lines", () => {
  it("amends rows that share a line against each other's new lines", async () => {
    const one = await placeAtMock(mock, store, { lines: [{ lineNumber: "item_a", sku: "978-A", quantity: 2 }] })
    const two = await placeAtMock(mock, store, {
      orderNumber: "ORD-1001-2",
      sequence: 2,
      sourceRef: "remainder:2",
      lines: [{ lineNumber: "item_a", sku: "978-A", quantity: 1 }],
    })
    await amendRows(ctx, "order_1", [line("item_a", "978-A", 4)], false)
    const qty = (uuid: string) => mock.state.orders.get(uuid).orderLines.reduce((n: number, l: any) => n + l.quantity, 0)
    expect(qty(one.pt_uuid!) + qty(two.pt_uuid!)).toBe(4)
    await amendRows(ctx, "order_1", [line("item_a", "978-A", 2)], false)
    expect(qty(one.pt_uuid!) + qty(two.pt_uuid!)).toBe(2)
    expect(mock.state.orders.get(two.pt_uuid!).status).not.toBe("cancelled")
    expect(mock.state.orders.get(one.pt_uuid!).status).not.toBe("cancelled")
  })

  it("a new edit starts a capped amend's count again", async () => {
    const row = await placeAtMock(mock, store)
    await store.updatePrintTrailOrders({ id: row.id, attempts: { amend: 3 }, attention: "retry-cap:amend", pending_action: null })
    await recordAmendIntent(store, store.rows, { retry: false }, NOW)
    expect(store.row(row.id).attempts?.amend ?? 0).toBe(0)
    expect(store.row(row.id)).toMatchObject({ pending_action: "amend", attention: null })
    const out = await amend(row.id, [line("item_a", "978-A", 2)])
    expect(out.result).toBe("amended")
  })

  it("a retry run keeps the count and only pushes the lease out", async () => {
    const row = await placeAtMock(mock, store)
    await store.updatePrintTrailOrders({ id: row.id, attempts: { amend: 2 }, pending_action: "amend", next_attempt_at: NOW })
    await recordAmendIntent(store, store.rows, { retry: true }, NOW)
    expect(store.row(row.id)).toMatchObject({
      attempts: { amend: 2 },
      pending_action: "amend",
      next_attempt_at: new Date("2026-10-19T12:15:00Z"),
    })
  })
})

describe("re-added lines", () => {
  it("lines removed then re-added go out as a new -n order", async () => {
    const row = await placeAtMock(mock, store)
    await amendRows(ctx, "order_1", [], false)
    expect(store.row(row.id).cancel_status).toBe("cancelled")
    const readded = [line("item_a", "978-A", 1)]
    const out = await amendRows(ctx, "order_1", readded, false)
    expect(out.remainder).toBe(true)
    expect(store.events.find((e) => e.kind === "reopen-refused")!.message).toContain("sent as a new Print Trail order")

    // The follow-up: the send workflow's auto target.
    const sendCtx: SendContext = { store, client: ctx.client, options: ctx.options, now: () => NOW }
    const order = { id: "order_1", display_id: 1001, email: "a@example.com", status: "pending", canceled_at: null,
      shipping_address: { first_name: "A", address_1: "1 St", city: "London", country_code: "gb" },
      payment_collections: [] }
    const rows = await store.listPrintTrailOrders({ order_id: "order_1" })
    const target = resolveSendTarget(rows as never, {})
    if (!target.ok) throw new Error(target.detail)
    expect(target).toMatchObject({ sequence: 2, sourceRef: "remainder:2" })
    const lines = scopedLines(readded, rows as never, target)
    const create = await createDraft(sendCtx, { order, lines, sequence: target.sequence, sourceRef: target.sourceRef })
    const gate = await checkGate(sendCtx, order, create)
    const confirmed = await confirm(sendCtx, { rowId: create.rowId!, pt: create.pt!, body: gate.body!, methodByLine: create.methodByLine })
    await recordOutcome(sendCtx, { orderId: "order_1", create, gate, confirm: confirmed })
    expect(store.rows.find((r) => r.sequence === 2)).toMatchObject({ pt_order_number: "ORD-1001-2", confirmed_at: NOW })
  })

  it("a row whose cancel didn't happen still points at Resend", async () => {
    const row = await placeAtMock(mock, store)
    await store.updatePrintTrailOrders({ id: row.id, cancel_status: "refused", cancel_requested: true })
    const out = await amendRows(ctx, "order_1", [line("item_a", "978-A", 2)], false)
    expect(out.remainder).toBe(false)
    expect(store.events.find((e) => e.kind === "reopen-refused")!.message).toContain("Resend as a new Print Trail order")
  })
})

describe("amend leases", () => {
  it("caps an amend whose runs keep failing before they reach Print Trail", async () => {
    const row = await placeAtMock(mock, store)
    await recordAmendIntent(store, store.rows, { retry: false }, NOW)
    // Three runs that throw after the lease (a filterLines handler, say).
    for (let i = 0; i < 3; i++) await leaseAmends(store, "order_1", NOW)
    expect(store.row(row.id).attempts).toMatchObject({ amend: 3 })
    await leaseAmends(store, "order_1", NOW)
    expect(store.row(row.id)).toMatchObject({ pending_action: null, attention: "retry-cap:amend" })
    expect(kinds()).toContain("retry-capped")
    // No PUT until a new edit.
    await amendRow(ctx, store.row(row.id), store.rows, [line("item_a", "978-A", 2)], false)
    expect(puts()).toHaveLength(0)
  })

  it("never leases an amend over a cancel, and stops a PUT when one lands", async () => {
    const row = await placeAtMock(mock, store)
    await store.updatePrintTrailOrders({ id: row.id, pending_action: "amend", next_attempt_at: NOW })
    const list = store.listPrintTrailOrders.bind(store)
    let reads = 0
    jest.spyOn(store, "listPrintTrailOrders").mockImplementation(async (f) => {
      // A Medusa cancel lands while the amend is reading Print Trail.
      if (f.id === row.id && ++reads === 2) {
        Object.assign(store.row(row.id), { cancel_status: "requested", cancel_requested: true, pending_action: "cancel", next_attempt_at: NOW })
      }
      return list(f)
    })
    await amend(row.id, [line("item_a", "978-A", 2)])
    expect(puts()).toHaveLength(0)
    expect(store.row(row.id)).toMatchObject({ pending_action: "cancel", next_attempt_at: NOW, cancel_status: "requested" })
    await leaseAmends(store, "order_1", NOW)
    expect(store.row(row.id).pending_action).toBe("cancel")
  })
})

describe("run size", () => {
  it("amends at most the rows a lock's ttl allows and leaves the rest due", async () => {
    const rows: Awaited<ReturnType<typeof placeAtMock>>[] = []
    for (let n = 1; n <= 3; n++) {
      rows.push(await placeAtMock(mock, store, { orderNumber: `ORD-1001${n > 1 ? `-${n}` : ""}`, sequence: n, sourceRef: n > 1 ? `claim:c${n}` : null,
        lines: [{ lineNumber: `item_${n}`, sku: "978-A", quantity: 1 }] }))
    }
    const lines = rows.map((_, i) => ({ ...line(`item_${i + 1}`, "978-A", 2), replacementOf: i ? `claim:c${i + 1}` : null }))
    await amendRows(ctx, "order_1", lines, false)
    expect(puts()).toHaveLength(2)
    expect(store.row(rows[2].id)).toMatchObject({ pending_action: "amend", next_attempt_at: NOW })
    await leaseAmends(store, "order_1", NOW)
    await amendRows(ctx, "order_1", lines, false)
    expect(puts()).toHaveLength(3)
  })
})

describe("lease and run cap together", () => {
  it("never caps a row the per-run cap kept from Print Trail", async () => {
    const rows: Awaited<ReturnType<typeof placeAtMock>>[] = []
    for (let n = 1; n <= 3; n++) {
      rows.push(await placeAtMock(mock, store, { orderNumber: `ORD-1001${n > 1 ? `-${n}` : ""}`, sequence: n, sourceRef: n > 1 ? `claim:c${n}` : null,
        lines: [{ lineNumber: `item_${n}`, sku: "978-A", quantity: 1 }] }))
    }
    const lines = rows.map((_, i) => ({ ...line(`item_${i + 1}`, "978-A", 2), replacementOf: i ? `claim:c${i + 1}` : null }))
    mock.fail(/\/lines$/, 409, { type: "about:blank", title: "Conflict", status: 409, detail: "rebuilding", reason: "being-rebuilt" }, 99)
    await recordAmendIntent(store, store.rows, { retry: false }, NOW)
    const putsFor = (uuid: string) => puts().filter((r) => r.path.includes(uuid)).length
    for (let run = 0; run < 6; run++) {
      const leased = await leaseAmends(store, "order_1", NOW)
      await amendRows(ctx, "order_1", lines, false, undefined, { leased: leased.leased })
      for (const r of rows) {
        expect(store.row(r.id).attempts?.amend ?? putsFor(r.pt_uuid!)).toBeLessThanOrEqual(putsFor(r.pt_uuid!))
        if (store.row(r.id).attention === "retry-cap:amend") expect(putsFor(r.pt_uuid!)).toBe(3)
      }
    }
    expect(rows.map((r) => store.row(r.id).attention)).toEqual(["retry-cap:amend", "retry-cap:amend", "retry-cap:amend"])
  })

  it("leaseAmends never counts a row a cancel owns", async () => {
    const row = await placeAtMock(mock, store)
    await store.updatePrintTrailOrders({ id: row.id, pending_action: "amend", cancel_status: "requested", attempts: { amend: 1 } })
    const out = await leaseAmends(store, "order_1", NOW)
    expect(out.leased).toEqual([])
    expect(store.row(row.id).attempts).toEqual({ amend: 1 })
  })
})

// API 1.3.0 (mock preOrderRelease on): PUT …/lines is allowed while the only
// non-draft fulfilments are held back-orders, refused once anything is sent.
describe("amending pre-order orders", () => {
  const waiting = async () => {
    mock.state.stock["PRE-1"] = 0
    mock.state.skuStatus["PRE-1"] = "pre-order"
    const row = await placeAtMock(mock, store, { lines: [{ lineNumber: "item_p", sku: "PRE-1", quantity: 1 }] })
    mock.setStatus(row.pt_uuid!, "back-order")
    await store.updatePrintTrailOrders({ id: row.id, status: "back-order", pending_action: "amend", next_attempt_at: NOW })
    return row
  }

  it("an edit to a waiting order is sent", async () => {
    const row = await waiting()
    const out = await amend(row.id, [line("item_p", "PRE-1", 2)])
    expect(out).toMatchObject({ action: "put-lines", result: "amended" })
    expect(store.row(row.id).attention).toBeNull()
    expect(mock.state.orders.get(row.pt_uuid!).orderLines[0].quantity).toBe(2)
  })

  it("an edit after a release is refused and shown", async () => {
    const row = await waiting()
    mock.state.stock["PRE-1"] = 5
    await mock.setSkuStatus("PRE-1", "active")
    mock.sendToWarehouse(row.pt_uuid!, 0)
    const out = await amend(row.id, [line("item_p", "PRE-1", 2)])
    expect(out.result).toBe("refused")
    expect(store.row(row.id).attention).toBe("amend-refused")
  })

  // Print Trail's amend: 409 stock-held (the pre-order limit, or stock
  // held by other orders). The refusal stays amend-refused; the store's stock
  // for those SKUs is refreshed, as after a confirm shortfall, every time.
  it("an edit refused for stock asks for a stock refresh of its SKUs, each time", async () => {
    mock.state.preOrderLimit = { "PRE-1": 2 }
    const row = await waiting()
    const first = await amend(row.id, [line("item_p", "PRE-1", 3)])
    expect(first.result).toBe("refused")
    expect(store.row(row.id).attention).toBe("amend-refused")
    expect(store.events.filter((e) => e.kind === "amend-refused").map((e) => e.message)).toEqual([
      expect.stringContaining("Not enough stock for PRE-1: 3 requested, 2 available"),
    ])
    const short = (o: typeof first) => o.events.filter((e) => e.name === "print_trail.order.stock_held")
    expect(short(first)).toEqual([
      { name: "print_trail.order.stock_held", data: { order_id: "order_1", print_trail_order_id: row.id, pt_uuid: row.pt_uuid, skus: ["PRE-1"] } },
    ])
    expect(first.events.map((e) => e.name)).toContain("print_trail.order.attention")
    // Already flagged: no second attention event, but the refresh again.
    await store.updatePrintTrailOrders({ id: row.id, pending_action: "amend", next_attempt_at: NOW })
    const again = await amend(row.id, [line("item_p", "PRE-1", 4)])
    expect(again.result).toBe("refused")
    expect(again.events.map((e) => e.name)).toEqual(["print_trail.order.stock_held"])
    expect(short(again)[0].data.skus).toEqual(["PRE-1"])
  })

  it("removing every Print Trail item from a waiting order cancels it", async () => {
    const row = await waiting()
    const out = await amend(row.id, [])
    expect(out).toMatchObject({ action: "cancel-emptied", result: "cancelled" })
    expect(store.row(row.id)).toMatchObject({ block_reason: "no-pt-lines", cancel_status: "cancelled" })
    expect(mock.state.orders.get(row.pt_uuid!).status).toBe("cancelled")
    expect(mock.state.requests.filter((r) => r.path.endsWith("/cancel"))).toHaveLength(1)
  })
})
