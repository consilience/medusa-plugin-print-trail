import { PrintTrailApiError } from "../../modules/printTrail/client/errors"
import { desiredLines, interpretAmendError, planAmend, ptLinesDiverged } from "../amend-decisions"
import type { ScopedLine } from "../lines"
import type { ScopeRow } from "../order-scope"
import { isSyncAttention } from "../sync-decisions"

const sent = (lines: Record<string, number>) =>
  Object.entries(lines).map(([lineNumber, quantity]) => ({ lineNumber, quantity, product: { sku: `SKU-${lineNumber}` } }))
const row = (sequence: number, over: Partial<ScopeRow> = {}): ScopeRow => ({
  id: `r${sequence}`,
  sequence,
  pt_uuid: `u${sequence}`,
  status: "queued",
  confirmed_at: "2026-10-19T10:00:00Z",
  ...over,
})
const line = (id: string, quantity: number, replacementOf: string | null = null): ScopedLine => ({
  lineItemId: id,
  sku: `SKU-${id}`,
  quantity,
  method: "standard",
  replacementOf,
})
const err = (status: number, body: Record<string, unknown> = {}) =>
  new PrintTrailApiError("x", status, { status, detail: "d", ...body }, "PUT", "/orders/u/lines", "d")

describe("desiredLines", () => {
  it("adds new items to sequence 1 only", () => {
    const r1 = row(1, { submitted_lines: sent({ i1: 1 }) })
    const r2 = row(2, { source_ref: "claim:c1", submitted_lines: sent({ c1: 1 }) })
    const lines = [line("i1", 2), line("i2", 1), line("c1", 1, "claim:c1"), line("c9", 1, "claim:c9")]
    expect(desiredLines(r1, [r1, r2], lines)).toEqual([
      { lineNumber: "i1", quantity: 2, sku: "SKU-i1", added: false },
      { lineNumber: "i2", quantity: 1, sku: "SKU-i2", added: true },
    ])
    expect(desiredLines(r2, [r1, r2], lines)).toEqual([{ lineNumber: "c1", quantity: 1, sku: "SKU-c1", added: false }])
  })

  it("leaves what another row carries to that row", () => {
    const r1 = row(1, { submitted_lines: sent({ i1: 2 }) })
    const r2 = row(2, { source_ref: "remainder:2", submitted_lines: sent({ i1: 1 }) })
    expect(desiredLines(r1, [r1, r2], [line("i1", 3)])).toEqual([{ lineNumber: "i1", quantity: 2, sku: "SKU-i1", added: false }])
  })
})

describe("lines filterLines holds back", () => {
  it("keeps a sent line the hook dropped at its submitted quantity", () => {
    const r1 = row(1, { submitted_lines: sent({ i1: 2, i2: 1 }) })
    const items = new Map([["i1", 2], ["i2", 1]])
    expect(desiredLines(r1, [r1], [line("i2", 1)], items)).toEqual([
      { lineNumber: "i1", quantity: 2, sku: "SKU-i1", added: false },
      { lineNumber: "i2", quantity: 1, sku: "SKU-i2", added: false },
    ])
    expect(planAmend(r1, [r1], [line("i2", 1)], false, items)).toEqual({ kind: "none" })
  })

  it("zeroes a line whose item is gone or at 0", () => {
    const r1 = row(1, { submitted_lines: sent({ i1: 2, i2: 1 }) })
    expect(planAmend(r1, [r1], [line("i2", 1)], false, new Map([["i1", 0], ["i2", 1]]))).toMatchObject({
      kind: "put-lines",
      body: { orderLines: [{ lineNumber: "i1", quantity: 0 }, { lineNumber: "i2", quantity: 1 }] },
    })
    expect(planAmend(r1, [r1], [], false, new Map([["i2", 0]]))).toEqual({ kind: "cancel-emptied" })
  })
})

describe("planAmend", () => {
  const r1 = row(1, { submitted_lines: sent({ i1: 1, i2: 1 }) })

  it("plans nothing for unchanged lines", () => {
    expect(planAmend(r1, [r1], [line("i1", 1), line("i2", 1)], false)).toEqual({ kind: "none" })
  })

  it("resends a draft whose lines changed", () => {
    const draft = row(1, { confirmed_at: null, status: "draft", submitted_lines: sent({ i1: 1 }) })
    expect(planAmend(draft, [draft], [line("i1", 2)], false)).toEqual({ kind: "resend" })
  })

  it("puts the full line set for a confirmed order, removed lines at 0", () => {
    expect(planAmend(r1, [r1], [line("i1", 3), line("i3", 1)], false)).toEqual({
      kind: "put-lines",
      body: {
        orderLines: [
          { lineNumber: "i1", quantity: 3 },
          { lineNumber: "i2", quantity: 0 },
          { lineNumber: "i3", quantity: 1, product: { sku: "SKU-i3" } },
        ],
      },
      added: ["i3"],
    })
  })

  it("cancels when every Print Trail line is gone", () => {
    expect(planAmend(r1, [r1], [], false)).toEqual({ kind: "cancel-emptied" })
    const draft = row(1, { confirmed_at: null, status: "draft", submitted_lines: sent({ i1: 1 }) })
    expect(planAmend(draft, [draft], [], false)).toEqual({ kind: "cancel-emptied" })
  })

  it("stays out of a Medusa-cancelled order", () => {
    expect(planAmend(r1, [r1], [], true)).toEqual({ kind: "none" })
  })

  it("reports re-added lines on a cancelled row", () => {
    const here = row(1, { cancel_status: "cancelled", status: "cancelled", submitted_lines: sent({ i1: 1 }) })
    expect(planAmend(here, [here], [line("i1", 2), line("i9", 1)], false)).toEqual({
      kind: "closed",
      why: "cancelled-here",
      reAdded: ["i1", "i9"],
    })
    const pt = row(1, { status: "cancelled", submitted_lines: sent({ i1: 1 }) })
    expect(planAmend(pt, [pt], [line("i1", 1)], false)).toEqual({ kind: "closed", why: "pt-cancelled", reAdded: [] })
  })
})

describe("interpretAmendError", () => {
  it("retries only being-rebuilt, unexpected-error and transient refusals", () => {
    expect(interpretAmendError(err(503)).kind).toBe("retry")
    expect(interpretAmendError(err(409, { reason: "being-rebuilt" })).kind).toBe("retry")
    expect(interpretAmendError(err(500, { reason: "unexpected-error" })).kind).toBe("retry")
    expect(interpretAmendError(err(409, { reason: "unexpected-error" })).kind).toBe("retry")
    expect(interpretAmendError(err(422, { reason: "no-lines" }))).toEqual({ kind: "no-lines" })
    expect(interpretAmendError(err(404))).toEqual({ kind: "not-found" })
    expect(interpretAmendError(err(409, { reason: "order-not-found" }))).toEqual({ kind: "not-found" })
    expect(interpretAmendError(err(401))).toEqual({ kind: "auth-failed" })
    expect(interpretAmendError(err(403, { type: "https://docs.printtrail.com/channel-api/problems/channel-inactive" }))).toEqual({
      kind: "channel-inactive",
    })
    expect(interpretAmendError(err(403, { reason: "team-inactive", merchantMessage: "Team inactive" }))).toEqual({
      kind: "refused",
      detail: "Team inactive",
      reason: "team-inactive",
    })
    expect(interpretAmendError(err(409, { reason: "fulfilment-underway", merchantMessage: "Started" }))).toEqual({
      kind: "refused",
      detail: "Started",
      reason: "fulfilment-underway",
    })
    expect(interpretAmendError(err(422, { reason: "invalid-lines" }))).toEqual({ kind: "refused", detail: "d", reason: "invalid-lines" })
  })

  // Print Trail's stock-held amend refusal: the confirm's shortfall body
  // inside the amend problem.
  it("a stock-held refusal carries its shortfall", () => {
    const errors = [{ sku: "PRE-1", requested: 3, available: 2 }]
    const body = { reason: "stock-held", merchantMessage: "Not enough stock for PRE-1", message: "Stock unavailable for one or more items", errors }
    expect(interpretAmendError(err(409, body))).toEqual({ kind: "refused", detail: "Not enough stock for PRE-1", reason: "stock-held", shortfall: errors })
    // Other refusals carry none, even with an errors array.
    expect(interpretAmendError(err(409, { reason: "not-fulfillable", errors }))).not.toHaveProperty("shortfall")
  })
})

describe("ptLinesDiverged", () => {
  it("ptLinesDiverged sums split lines", () => {
    const submitted = sent({ i1: 3, i2: 1 })
    expect(
      ptLinesDiverged(submitted, {
        orderLines: [
          { lineNumber: "i1", quantity: 2 },
          { lineNumber: "i1", quantity: 1 },
          { lineNumber: "i2", quantity: 1 },
        ],
      })
    ).toBe(false)
    expect(ptLinesDiverged(submitted, { orderLines: [{ lineNumber: "i1", quantity: 3 }] })).toBe(true)
  })
})

describe("attention codes", () => {
  it("none of the cancel and amend codes are sync codes", () => {
    for (const code of [
      "cancel-too-late",
      "cancel-failed",
      "retry-cap:cancel",
      "retry-cap:amend",
      "amend-refused",
      "amend-diverged",
      "amend-unsent-items",
      "no-pt-shipping-method",
      "refunded-not-cancelled",
      "return-before-dispatch",
    ]) {
      expect(isSyncAttention(code)).toBe(false)
    }
  })
})
