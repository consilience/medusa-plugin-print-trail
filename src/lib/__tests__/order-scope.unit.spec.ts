import { BigNumber } from "@medusajs/framework/utils"
import { allPrintTrailLines, PRINT_TRAIL_PROVIDER_ID, selectPrintTrailLines, type GraphOrder, type ScopedLine } from "../lines"
import {
  addressFingerprint,
  ownedQuantities,
  parseSourceRef,
  formatSourceRef,
  resolveSendTarget,
  scopedLines,
  submittedQuantities,
  unservedPrintTrailItems,
  type ScopeRow,
} from "../order-scope"
import { buildShippingDetails } from "../payload"

const ptOption = (profile: string, method?: string) => ({
  shipping_option_id: `so_${profile}`,
  shipping_option: { provider_id: PRINT_TRAIL_PROVIDER_ID, shipping_profile_id: profile, data: method ? { method } : {} },
})

const item = (id: string, profile: string, quantity: number) => ({
  id,
  detail: { quantity },
  variant: { sku: `SKU-${id}`, metadata: null, product: { shipping_profile: { id: profile } } },
})

const row = (sequence: number, over: Partial<ScopeRow> = {}): ScopeRow => ({ id: `r${sequence}`, sequence, ...over })
const sent = (lines: Record<string, number>) => Object.entries(lines).map(([lineNumber, quantity]) => ({ lineNumber, quantity }))
const line = (id: string, quantity: number, replacementOf: string | null = null): ScopedLine => ({
  lineItemId: id,
  sku: `SKU-${id}`,
  quantity,
  method: "standard",
  replacementOf,
})

describe("source refs", () => {
  it("round-trips every kind", () => {
    for (const ref of [null, "claim:c1", "exchange:e1", "remainder:3", "reissue:2"]) {
      expect(formatSourceRef(parseSourceRef(ref))).toBe(ref)
    }
  })
})

describe("resolveSendTarget", () => {
  it("auto targets sequence 1 until it is confirmed", () => {
    expect(resolveSendTarget([], {})).toEqual({ ok: true, sequence: 1, sourceRef: null, rowId: null })
    expect(resolveSendTarget([row(1, { pt_uuid: "u1" })], {})).toEqual({ ok: true, sequence: 1, sourceRef: null, rowId: "r1" })
  })

  it("auto targets a remainder after sequence 1 is confirmed and reuses an unposted one", () => {
    const confirmed = row(1, { pt_uuid: "u1", confirmed_at: "2026-10-18T12:00:00Z" })
    expect(resolveSendTarget([confirmed], {})).toEqual({ ok: true, sequence: 2, sourceRef: "remainder:2", rowId: null })
    const unposted = row(2, { source_ref: "remainder:2" })
    expect(resolveSendTarget([confirmed, unposted], {})).toEqual({ ok: true, sequence: 2, sourceRef: "remainder:2", rowId: "r2" })
    const posted = row(2, { source_ref: "remainder:2", pt_uuid: "u2" })
    expect(resolveSendTarget([confirmed, posted], {})).toEqual({ ok: true, sequence: 3, sourceRef: "remainder:3", rowId: null })
  })

  it("a claim gets its own sequence and keeps it", () => {
    const rows = [row(1, { pt_uuid: "u1" })]
    expect(resolveSendTarget(rows, { source_ref: "claim:c1" })).toEqual({ ok: true, sequence: 2, sourceRef: "claim:c1", rowId: null })
    rows.push(row(2, { source_ref: "claim:c1" }), row(3, { source_ref: "exchange:e1" }))
    expect(resolveSendTarget(rows, { source_ref: "claim:c1" })).toEqual({ ok: true, sequence: 2, sourceRef: "claim:c1", rowId: "r2" })
    // Even with no row 1 yet, a claim never takes sequence 1.
    expect(resolveSendTarget([], { source_ref: "claim:c9" })).toMatchObject({ sequence: 2 })
  })

  it("targets a named sequence, and refuses an unknown one", () => {
    const rows = [row(1), row(2, { source_ref: "claim:c1" })]
    expect(resolveSendTarget(rows, { sequence: 2 })).toEqual({ ok: true, sequence: 2, sourceRef: "claim:c1", rowId: "r2" })
    expect(resolveSendTarget([], { sequence: 1 })).toEqual({ ok: true, sequence: 1, sourceRef: null, rowId: null })
    expect(resolveSendTarget(rows, { sequence: 5 })).toMatchObject({ ok: false, reason: "unknown-sequence" })
  })

  it("reissue is refused unless Print Trail cancelled the row", () => {
    const live = [row(1, { pt_uuid: "u1", status: "queued" })]
    expect(resolveSendTarget(live, { reissue_of: 1 })).toMatchObject({ ok: false, reason: "reissue-not-allowed" })
    expect((resolveSendTarget(live, { reissue_of: 1 }) as { detail: string }).detail).toContain("queued")
    const medusa = [row(1, { pt_uuid: "u1", status: "cancelled", cancel_status: "cancelled" })]
    expect(resolveSendTarget(medusa, { reissue_of: 1 })).toMatchObject({ ok: false, reason: "reissue-not-allowed" })
    expect(resolveSendTarget([], { reissue_of: 1 })).toMatchObject({ ok: false, reason: "reissue-not-allowed" })
    const pt = [row(1, { pt_uuid: "u1", status: "cancelled" })]
    expect(resolveSendTarget(pt, { reissue_of: 1 })).toEqual({ ok: true, sequence: 2, sourceRef: "reissue:1", rowId: null })
  })

  it("reissue reuses its row", () => {
    const rows = [row(1, { pt_uuid: "u1", status: "cancelled" }), row(2, { source_ref: "reissue:1" })]
    expect(resolveSendTarget(rows, { reissue_of: 1 })).toEqual({ ok: true, sequence: 2, sourceRef: "reissue:1", rowId: "r2" })
  })
})

describe("ownership and scoped lines", () => {
  it("sums submitted quantities by line number", () => {
    expect(submittedQuantities(row(1, { submitted_lines: [...sent({ i1: 2 }), ...sent({ i1: 1, i2: 1 })] }))).toEqual(
      new Map([["i1", 3], ["i2", 1]])
    )
    expect(submittedQuantities(row(1))).toEqual(new Map())
  })

  it("a remainder carries only what no other row has sent", () => {
    const rows = [row(1, { pt_uuid: "u1", confirmed_at: "x", submitted_lines: sent({ i1: 2 }) })]
    const target = resolveSendTarget(rows, {})
    if (!target.ok) throw new Error("refused")
    const out = scopedLines([line("i1", 3), line("i2", 1), line("c1", 1, "claim:c1")], rows, target)
    expect(out).toEqual([
      { lineItemId: "i1", sku: "SKU-i1", quantity: 1, method: "standard" },
      { lineItemId: "i2", sku: "SKU-i2", quantity: 1, method: "standard" },
    ])
  })

  it("a reissued row no longer owns its lines", () => {
    const rows = [
      row(1, { pt_uuid: "u1", status: "cancelled", submitted_lines: sent({ i1: 2 }) }),
      row(2, { source_ref: "reissue:1", pt_uuid: "u2", submitted_lines: sent({ i1: 2 }) }),
      row(3, { source_ref: "remainder:3" }),
    ]
    expect(ownedQuantities(rows)).toEqual(new Map([["i1", 2]]))
    expect(ownedQuantities(rows, "r2")).toEqual(new Map())
    // A row cancelled at Print Trail and not reissued still owns its lines.
    expect(ownedQuantities(rows.slice(0, 1))).toEqual(new Map([["i1", 2]]))
  })

  it("a row cancelled from Medusa (or never sent) owns nothing", () => {
    const rows = [
      row(1, { pt_uuid: "u1", status: "cancelled", cancel_status: "cancelled", submitted_lines: sent({ i1: 2 }) }),
      row(2, { cancel_status: "not-sent", submitted_lines: sent({ i2: 1 }) }),
      row(3, { pt_uuid: "u3", cancel_status: "too-late", submitted_lines: sent({ i3: 1 }) }),
    ]
    expect(ownedQuantities(rows)).toEqual(new Map([["i3", 1]]))
    expect(resolveSendTarget([row(1, { cancel_status: "not-sent" })], {})).toMatchObject({ sequence: 2, sourceRef: "remainder:2" })
  })

  it("a reissue carries the cancelled row's lines at their current quantities", () => {
    const rows = [row(1, { pt_uuid: "u1", status: "cancelled", submitted_lines: sent({ i1: 2, i2: 1, c1: 1 }) })]
    const out = scopedLines([line("i1", 3), line("c1", 1, "claim:c1")], rows, {
      ok: true,
      sequence: 2,
      sourceRef: "reissue:1",
      rowId: null,
    })
    expect(out.map((l) => [l.lineItemId, l.quantity])).toEqual([["i1", 3], ["c1", 1]])
  })

  it("claim lines are only that claim's added items", () => {
    const lines = [line("i1", 1), line("c1", 1, "claim:c1"), line("c2", 1, "claim:c2"), line("e1", 1, "exchange:e1")]
    const pick = (sourceRef: string | null) =>
      scopedLines(lines, [], { ok: true, sequence: 2, sourceRef, rowId: null }).map((l) => l.lineItemId)
    expect(pick("claim:c1")).toEqual(["c1"])
    expect(pick("exchange:e1")).toEqual(["e1"])
    expect(pick(null)).toEqual(["i1"])
  })
})

describe("allPrintTrailLines", () => {
  const order: GraphOrder = {
    id: "order_1",
    items: [item("a", "sp_pt", 2), item("b", "sp_manual", 1), item("x", "sp_pt", 1), item("y", "sp_pt", 1), item("z", "sp_pt", 0)],
    shipping_methods: [ptOption("sp_pt", "tracked")],
    exchanges: [{ id: "exc_1", additional_items: [{ item_id: "x" }] }],
    claims: [{ id: "claim_1", additional_items: [{ item_id: "y", is_additional_item: true }, { item_id: "a", is_additional_item: false }] }],
  }

  it("marks claim and exchange items with their source", () => {
    expect(allPrintTrailLines(order, "standard").map((l) => [l.lineItemId, l.replacementOf])).toEqual([
      ["a", null],
      ["x", "exchange:exc_1"],
      ["y", "claim:claim_1"],
    ])
  })

  // Medusa's quantities are numbers, decimal strings or BigNumbers, and can
  // be fractional: a fractional line is kept, for the send to block on.
  it("reads any quantity form and keeps a fractional line", () => {
    const at = (id: string, quantity: unknown) => ({ ...item(id, "sp_pt", 1), detail: { quantity: quantity as number } })
    const forms: GraphOrder = {
      id: "order_2",
      items: [at("s", "2.000"), at("b", new BigNumber(3)), at("f", 1.5), at("h", new BigNumber("0.5")), at("z", "0"), at("n", null)],
      shipping_methods: [ptOption("sp_pt")],
    }
    expect(allPrintTrailLines(forms, "standard").map((l) => [l.lineItemId, l.quantity])).toEqual([
      ["s", 2],
      ["b", 3],
      ["f", 1.5],
      ["h", 0.5],
    ])
    expect(unservedPrintTrailItems({ ...forms, shipping_methods: [] }, ["sp_pt"])).toEqual(["b", "f", "h", "s"])
  })

  it("selectPrintTrailLines is unchanged", () => {
    expect(selectPrintTrailLines(order, "standard")).toEqual([
      { lineItemId: "a", sku: "SKU-a", quantity: 2, method: "tracked" },
    ])
  })
})

describe("unservedPrintTrailItems", () => {
  it("finds Print Trail items with no Print Trail shipping method", () => {
    const order: GraphOrder = {
      id: "o",
      items: [item("b", "sp_pt_b", 1), item("a", "sp_pt_a", 1), item("m", "sp_manual", 1), item("gone", "sp_pt_b", 0), item("ok", "sp_pt", 1)],
      shipping_methods: [ptOption("sp_pt"), { shipping_option_id: "so_m", shipping_option: { provider_id: "manual_manual", shipping_profile_id: "sp_manual" } }],
    }
    expect(unservedPrintTrailItems(order, ["sp_pt", "sp_pt_a", "sp_pt_b"])).toEqual(["a", "b"])
    expect(unservedPrintTrailItems(order, ["sp_pt"])).toEqual([])
  })
})

describe("addressFingerprint", () => {
  const details = (over: Record<string, unknown> = {}) => {
    const built = buildShippingDetails({
      shippingAddress: {
        first_name: "Ada",
        last_name: "Lovelace",
        address_1: "1 Analytical St",
        city: "London",
        postal_code: "N1 1AA",
        country_code: "gb",
        phone: "0123",
        ...over,
      },
      billingAddress: null,
      email: (over.email as string) ?? "ada@example.com",
      note: null,
    })
    if (!built.ok) throw new Error(built.detail)
    return built.shippingDetails
  }

  it("the address fingerprint ignores email and phone", () => {
    const base = addressFingerprint(details())
    expect(base).toMatch(/^[0-9a-f]{64}$/)
    expect(addressFingerprint(details({ email: "other@example.com", phone: "999" }))).toBe(base)
    expect(addressFingerprint(details({ postal_code: "N1 1AB" }))).not.toBe(base)
  })

  it("doesn't depend on key order", () => {
    expect(addressFingerprint({ a: 1, b: { c: 2, d: 3 } })).toBe(addressFingerprint({ b: { d: 3, c: 2 }, a: 1 }))
  })
})
