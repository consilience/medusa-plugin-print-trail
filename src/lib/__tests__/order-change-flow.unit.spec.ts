import { resolvePluginOptions } from "../../config"
import type { GraphOrder } from "../lines"
import { addressFingerprint } from "../order-scope"
import { recordAddressChange, recordRefunds, recordReturn, type ChangeContext } from "../order-change-flow"
import { buildShippingDetails } from "../payload"
import { MemoryStore, NOW } from "./flow-fixtures"

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
  shipping_address: address,
  billing_address: null,
  ...over,
})
const hashOf = (o: GraphOrder) => {
  const d = buildShippingDetails({ shippingAddress: o.shipping_address, billingAddress: o.billing_address, email: o.email, note: null })
  if (!d.ok) throw new Error(d.detail)
  return addressFingerprint(d.shippingDetails)
}

let store: MemoryStore
let ctx: ChangeContext

beforeEach(() => {
  store = new MemoryStore()
  ctx = {
    store,
    options: resolvePluginOptions({ baseUrl: "https://api.example", appUrl: "https://app.example" }),
    teamCode: "acme",
    now: () => NOW,
  }
})

const addRow = (over: Record<string, unknown> = {}) =>
  store.createPrintTrailOrders({
    order_id: "order_1",
    sequence: 1,
    pt_order_number: "ORD-1001",
    pt_uuid: "u1",
    status: "queued",
    confirmed_at: NOW,
    address_hash: hashOf(order()),
    pending_action: null,
    attention: null,
    block_reason: null,
    submitted_lines: [{ lineNumber: "item_a", quantity: 1 }],
    ...over,
  })
const rows = () => store.rows.map((r) => ({ ...r }))

describe("recordAddressChange", () => {
  it("ignores an order.updated that doesn't change the address", async () => {
    await addRow()
    const out = await recordAddressChange(ctx, rows(), order({ email: "new@example.com" }))
    expect(out.resend).toEqual([])
    expect(store.events).toEqual([])
  })

  it("resends a draft whose address changed", async () => {
    await addRow({ confirmed_at: null, status: "draft" })
    const out = await recordAddressChange(ctx, rows(), order({ shipping_address: { ...address, postal_code: "N1 9ZZ" } }))
    expect(out.resend).toEqual([1])
    expect(store.events).toEqual([])
  })

  it("notes once that a confirmed order's address must be changed in Print Trail", async () => {
    const row = await addRow()
    const moved = order({ shipping_address: { ...address, postal_code: "N1 9ZZ" } })
    await recordAddressChange(ctx, rows(), moved)
    await recordAddressChange(ctx, rows(), moved)
    expect(store.kinds()).toEqual(["address-changed"])
    expect(store.events[0].message).toContain("Change it in the Print Trail app")
    expect(store.events[0].data.pt_url).toBe("https://app.example/acme/orders/u1")
    expect(store.row(row.id)).toMatchObject({ address_hash: hashOf(moved), attention: null })
  })

  it("stores a first hash silently for an older row", async () => {
    const row = await addRow({ address_hash: null })
    await recordAddressChange(ctx, rows(), order())
    expect(store.row(row.id).address_hash).toBe(hashOf(order()))
    expect(store.events).toEqual([])
  })

  it("leaves rows a cancel owns, and an address below the minimum", async () => {
    await addRow({ cancel_status: "requested", confirmed_at: null })
    expect((await recordAddressChange(ctx, rows(), order({ shipping_address: { ...address, postal_code: "X" } }))).resend).toEqual([])
    store.rows = []
    await addRow({ confirmed_at: null })
    expect((await recordAddressChange(ctx, rows(), order({ shipping_address: { country_code: "gb" } }))).resend).toEqual([])
  })
})

describe("recordRefunds", () => {
  const refund = (id: string, amount: number) => ({ id, amount, currency_code: "gbp" })

  it("records each refund once", async () => {
    await addRow()
    await addRow({ sequence: 2, pt_order_number: "ORD-1001-2", pt_uuid: "u2" })
    const input = { refunds: [refund("ref_1", 5)], captured: 20, refunded: 5 }
    await recordRefunds(ctx, rows(), input)
    await recordRefunds(ctx, rows(), { ...input, refunds: [refund("ref_1", 5), refund("ref_2", 2)] })
    const entries = store.events.filter((e) => e.kind === "refund")
    expect(entries.map((e) => e.data.refund_id)).toEqual(["ref_1", "ref_2"])
    expect(entries.every((e) => e.print_trail_order_id === store.rows[0].id)).toBe(true)
    expect(entries[0].message).toContain("5 GBP")
  })

  it("a partial refund only notes", async () => {
    const row = await addRow()
    await recordRefunds(ctx, rows(), { refunds: [refund("ref_1", 5)], captured: 20, refunded: 5 })
    expect(store.row(row.id).attention).toBeNull()
    expect(store.kinds()).toEqual(["refund"])
  })

  it("a full refund blocks a pending confirm and keeps a pending cancel", async () => {
    const a = await addRow({ confirmed_at: null, status: "draft", pending_action: "confirm", next_attempt_at: NOW })
    const b = await addRow({ sequence: 2, pt_order_number: "ORD-1001-2", confirmed_at: null, status: "draft", pending_action: "cancel", next_attempt_at: NOW })
    await recordRefunds(ctx, rows(), { refunds: [refund("ref_1", 20)], captured: 20, refunded: 20 })
    expect(store.row(a.id)).toMatchObject({ pending_action: null, next_attempt_at: null, block_reason: "fully-refunded" })
    expect(store.row(b.id)).toMatchObject({ pending_action: "cancel", next_attempt_at: NOW, block_reason: "fully-refunded" })
    expect(store.kinds(a.id)).toEqual(["refund", "not-confirmed"])
  })

  it("a full refund of a confirmed order asks for a cancel, once", async () => {
    const row = await addRow()
    const input = { refunds: [refund("ref_1", 20)], captured: 20, refunded: 20 }
    const first = await recordRefunds(ctx, rows(), input)
    await recordRefunds(ctx, rows(), input)
    expect(store.row(row.id).attention).toBe("refunded-not-cancelled")
    expect(store.kinds()).toEqual(["refund", "refunded-not-cancelled"])
    expect(first.events.map((e) => e.name)).toEqual(["print_trail.order.attention"])
  })

  it.each(["complete", "cancelled", "returned", "partial", "failed"])(
    "a full refund of an order Print Trail has finished (%s) asks for nothing",
    async (status) => {
      const row = await addRow({ status })
      await recordRefunds(ctx, rows(), { refunds: [refund("ref_1", 20)], captured: 20, refunded: 20 })
      expect(store.row(row.id).attention ?? null).toBeNull()
      expect(store.kinds()).toEqual(["refund"])
    }
  )

  it("a full refund of an order Medusa cancelled sets no badge and blocks nothing", async () => {
    const row = await addRow()
    const draft = await addRow({ sequence: 2, pt_order_number: "ORD-1001-2", confirmed_at: null, pending_action: "cancel" })
    await recordRefunds(ctx, rows(), { refunds: [refund("ref_1", 20)], captured: 20, refunded: 20, orderCanceled: true })
    expect(store.row(row.id).attention).toBeNull()
    expect(store.row(draft.id).block_reason).toBeNull()
    expect(store.kinds()).toEqual(["refund"])
  })

  it("nothing captured is never a full refund", async () => {
    const row = await addRow({ confirmed_at: null, pending_action: "confirm" })
    await recordRefunds(ctx, rows(), { refunds: [], captured: 0, refunded: 0 })
    expect(store.row(row.id)).toMatchObject({ pending_action: "confirm", block_reason: null })
    expect(store.events).toEqual([])
  })
})

describe("recordReturn", () => {
  it("notes a return on the rows that sent its items", async () => {
    const a = await addRow({ fulfilments: [{ uuid: "f1", status: "dispatched", orderLines: [{ lineNumber: "item_a", quantity: 1 }] }] })
    const b = await addRow({ sequence: 2, pt_order_number: "ORD-1001-2", submitted_lines: [{ lineNumber: "item_c", quantity: 1 }] })
    await recordReturn(ctx, rows(), { returnId: "ret_1", items: [{ item_id: "item_a", quantity: 1 }] })
    await recordReturn(ctx, rows(), { returnId: "ret_1", items: [{ item_id: "item_a", quantity: 1 }] })
    expect(store.kinds(a.id)).toEqual(["return-requested"])
    expect(store.kinds(b.id)).toEqual([])
    expect(store.row(a.id).attention).toBeNull()
  })

  it("flags a return of items Print Trail hasn't dispatched", async () => {
    const row = await addRow({ fulfilments: [{ uuid: "f1", status: "processing", orderLines: [{ lineNumber: "item_a", quantity: 1 }] }] })
    const out = await recordReturn(ctx, rows(), { returnId: "ret_2", items: [{ item_id: "item_a", quantity: 1 }] })
    expect(store.row(row.id).attention).toBe("return-before-dispatch")
    expect(out.events.map((e) => e.name)).toEqual(["print_trail.order.attention"])
  })
})
