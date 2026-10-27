import { DEFAULT_RETRY_DELAYS_MS, DEFAULT_TIMEOUT_MS } from "../../modules/printTrail/client/client"
import { PrintTrailApiError } from "../../modules/printTrail/client/errors"
import type { PtOrder } from "../../modules/printTrail/client/types"
import { buildConfirmBody, evaluateGate, type GateInput } from "../gate"
import {
  attachShippingOptions,
  PRINT_TRAIL_PROVIDER_ID,
  selectPrintTrailLines,
  shippingOptionIds,
  type GraphOrder,
} from "../lines"
import { clearRetry, RETRY_CAPS, RETRY_DELAY_MS, scheduleRetry } from "../retry"
import { PROBLEM_TYPES } from "../../modules/printTrail/client/errors"
import { confirmedAtOf, confirmedAtPrintTrail, decideCreate, interpretConfirmError } from "../send-decisions"
import { PT_CALL_SECONDS, remoteSubmittedLines, rowsPerRun, SEND_LOCK_TTL_SECONDS } from "../send-flow"

const ptOption = (profile: string, method?: string) => ({
  shipping_option_id: `so_${profile}`,
  shipping_option: {
    provider_id: PRINT_TRAIL_PROVIDER_ID,
    shipping_profile_id: profile,
    data: method ? { method } : {},
  },
})

const item = (id: string, profile: string, quantity: number, sku = `SKU-${id}`) => ({
  id,
  detail: { quantity },
  variant: { sku, metadata: null, product: { shipping_profile: { id: profile } } },
})

describe("selectPrintTrailLines", () => {
  const order: GraphOrder = {
    id: "order_1",
    items: [
      item("a", "sp_pt", 2),
      item("b", "sp_manual", 1),
      item("c", "sp_pt_us", 1),
      item("d", "sp_pt", 0),
    ],
    shipping_methods: [
      ptOption("sp_pt", "tracked"),
      ptOption("sp_pt_us"),
      {
        shipping_option_id: "so_manual",
        shipping_option: { provider_id: "manual_manual", shipping_profile_id: "sp_manual", data: {} },
      },
    ],
  }

  it("keeps only lines in Print Trail profiles, with their option's method", () => {
    expect(selectPrintTrailLines(order, "standard")).toEqual([
      { lineItemId: "a", sku: "SKU-a", quantity: 2, method: "tracked" },
      { lineItemId: "c", sku: "SKU-c", quantity: 1, method: "standard" },
    ])
  })

  it("selects nothing without a Print Trail shipping method", () => {
    expect(
      selectPrintTrailLines({ ...order, shipping_methods: order.shipping_methods!.slice(2) }, "standard")
    ).toEqual([])
  })

  it("leaves out items added by claims and exchanges", () => {
    const o: GraphOrder = {
      ...order,
      items: [...order.items!, item("x", "sp_pt", 1), item("y", "sp_pt", 1), item("w", "sp_pt", 1)],
      exchanges: [{ additional_items: [{ item_id: "x" }] }],
      claims: [
        {
          additional_items: [
            { item_id: "y", is_additional_item: true },
            // A written-off original item is a claim item too, but not an added one.
            { item_id: "a", is_additional_item: false },
          ],
        },
      ],
    }
    expect(selectPrintTrailLines(o, "standard").map((l) => l.lineItemId)).toEqual(["a", "c", "w"])
  })

  it("uses the SKU override", () => {
    const o: GraphOrder = {
      ...order,
      items: [
        {
          ...item("a", "sp_pt", 1),
          variant: {
            sku: "978-A",
            metadata: { print_trail_sku: "PT-A" },
            product: { shipping_profile: { id: "sp_pt" } },
          },
        },
      ],
    }
    expect(selectPrintTrailLines(o, "standard")[0].sku).toBe("PT-A")
  })
})

describe("attachShippingOptions", () => {
  it("joins options fetched separately (orders have no shipping option link)", () => {
    const order: GraphOrder = {
      id: "order_1",
      items: [item("a", "sp_pt", 1)],
      shipping_methods: [{ shipping_option_id: "so_pt" }, { shipping_option_id: "so_gone" }],
    }
    expect(shippingOptionIds([order])).toEqual(["so_pt", "so_gone"])
    const joined = attachShippingOptions(order, [
      { id: "so_pt", provider_id: PRINT_TRAIL_PROVIDER_ID, shipping_profile_id: "sp_pt", data: { method: "air" } },
    ])
    expect(joined.shipping_methods![1]!.shipping_option).toBeNull()
    expect(selectPrintTrailLines(joined, "standard")).toEqual([
      { lineItemId: "a", sku: "SKU-a", quantity: 1, method: "air" },
    ])
  })
})

const ptOrder = (over: Partial<PtOrder> = {}): PtOrder => ({
  uuid: "pt-1",
  status: "draft",
  fulfillableStatus: "fulfillable",
  orderLines: [
    { lineNumber: "a", quantity: 2, fulfilmentUuid: "f1" },
    { lineNumber: "c", quantity: 1, fulfilmentUuid: "f2" },
  ],
  fulfilments: [
    {
      uuid: "f1",
      status: "draft",
      orderLines: [{ lineNumber: "a", quantity: 2 }],
      availableShippingMethods: [
        { code: "standard", name: "Standard" },
        { code: "tracked", name: "Tracked" },
      ],
    },
    {
      uuid: "f2",
      status: "draft",
      orderLines: [{ lineNumber: "c", quantity: 1 }],
      availableShippingMethods: [{ code: "standard", name: "Standard" }],
    },
  ],
  errors: [],
  ...over,
})

describe("evaluateGate", () => {
  const ok: GateInput = {
    confirmedAt: null,
    canceled: false,
    captured: 0,
    refunded: 0,
    confirmOn: "order.placed",
    blockReason: null,
    pt: ptOrder(),
    sentLineNumbers: ["a", "c"],
  }

  it("confirms a clean draft with nothing captured yet (order.placed)", () => {
    expect(evaluateGate(ok)).toEqual({ ok: true })
  })

  it.each([
    ["already-confirmed", { confirmedAt: new Date() }],
    ["order-canceled", { canceled: true }],
    ["fully-refunded", { captured: 10, refunded: 10 }],
    ["awaiting-payment", { confirmOn: "payment.captured" as const }],
    ["blocked:unmatched-skus", { blockReason: "unmatched-skus" }],
    ["not-fulfillable", { pt: ptOrder({ fulfillableStatus: "partially-fulfillable" }) }],
    ["pt-errors", { pt: ptOrder({ errors: [{ key: "product-not-found", message: "x" }] }) }],
    ["missing-lines", { sentLineNumbers: ["a", "c", "e"] }],
  ])("refuses with %s", (reason, over) => {
    expect(evaluateGate({ ...ok, ...over })).toMatchObject({ ok: false, reason })
  })

  it("checks in a fixed order", () => {
    expect(
      evaluateGate({ ...ok, confirmedAt: new Date(), canceled: true, blockReason: "x" })
    ).toMatchObject({ reason: "already-confirmed" })
    expect(evaluateGate({ ...ok, canceled: true, captured: 5, refunded: 5 })).toMatchObject({
      reason: "order-canceled",
    })
  })

  it("lets a partial refund through", () => {
    expect(evaluateGate({ ...ok, captured: 10, refunded: 4 })).toEqual({ ok: true })
  })

  it("confirms with payment.captured once captured", () => {
    expect(evaluateGate({ ...ok, confirmOn: "payment.captured", captured: 10 })).toEqual({ ok: true })
  })
  // API 1.3.0: a fulfillable order holds its pre-order lines as a back-order
  // and carries no product_preorder error.
  it("a fulfillable order with a pre-order back-order passes the gate", () => {
    const pt = ptOrder()
    pt.fulfilments![0] = { ...pt.fulfilments![0], status: "back-order", backOrderReason: "pre-order", sentToWarehouseAt: null }
    expect(evaluateGate({ ...ok, pt })).toEqual({ ok: true })
  })

  // No fallback for a Print Trail API before 1.3.0 (by design): blocked as before.
  it("not-fulfillable with product_preorder is blocked as today", () => {
    const pt = ptOrder({
      fulfillableStatus: "not-fulfillable",
      fulfilments: [],
      errors: [{ code: "product_preorder", key: "product", message: "Product P is on pre-order" }],
    })
    expect(evaluateGate({ ...ok, pt })).toMatchObject({ ok: false, reason: "not-fulfillable" })
  })
})

describe("buildConfirmBody", () => {
  it("chooses each fulfilment's method from its lines", () => {
    const methods = new Map([
      ["a", "tracked"],
      ["c", "standard"],
    ])
    expect(buildConfirmBody(ptOrder(), methods, "standard")).toEqual({
      ok: true,
      body: {
        defaultShippingMethod: "standard",
        fulfilmentShippingMethods: [
          { fulfilmentUuid: "f1", shippingMethod: "tracked" },
          { fulfilmentUuid: "f2", shippingMethod: "standard" },
        ],
      },
    })
  })

  it("ships a fulfilment holding lines bought with different methods by the best one it offers", () => {
    const merged = ptOrder({
      fulfilments: [
        {
          uuid: "f1",
          status: "draft",
          orderLines: [
            { lineNumber: "a", quantity: 1 },
            { lineNumber: "b", quantity: 1 },
          ],
          availableShippingMethods: [
            { code: "standard", name: "Standard" },
            { code: "tracked", name: "Tracked" },
          ],
        },
      ],
    })
    const methods = new Map([
      ["a", "standard"],
      ["b", "tracked"],
    ])
    expect(buildConfirmBody(merged, methods, "standard")).toMatchObject({
      ok: true,
      body: { fulfilmentShippingMethods: [{ fulfilmentUuid: "f1", shippingMethod: "tracked" }] },
    })
    expect(buildConfirmBody(merged, methods, "standard")).not.toHaveProperty("notes")
    // Express isn't offered, so tracked is the best the fulfilment can do, and
    // the downgrade is noted.
    methods.set("a", "express")
    expect(buildConfirmBody(merged, methods, "standard")).toMatchObject({
      ok: true,
      body: { fulfilmentShippingMethods: [{ fulfilmentUuid: "f1", shippingMethod: "tracked" }] },
      notes: ["Fulfilment f1 ships tracked; express isn't offered for it"],
    })
  })

  it("refuses rather than downgrading an unavailable method", () => {
    const methods = new Map([
      ["a", "tracked"],
      ["c", "tracked"],
    ])
    expect(buildConfirmBody(ptOrder(), methods, "standard")).toMatchObject({
      ok: false,
      reason: "shipping-method-unavailable",
    })
  })
})

describe("scheduleRetry", () => {
  const now = new Date("2026-10-18T12:00:00Z")

  it("schedules the next attempt 15 minutes out and counts it", () => {
    expect(scheduleRetry({ attempts: { send: 1 } }, "send", now)).toEqual({
      pending_action: "send",
      attempts: { send: 2 },
      next_attempt_at: new Date("2026-10-18T12:15:00Z"),
      attention: null,
    })
  })

  it("stops at the cap and flags attention", () => {
    expect(RETRY_CAPS.confirm).toBe(4)
    expect(scheduleRetry({ attempts: { confirm: 3 } }, "confirm", now)).toEqual({
      pending_action: null,
      attempts: { confirm: 4 },
      next_attempt_at: null,
      attention: "retry-cap:confirm",
    })
  })

  it("uses 60/300/900 second delays for refetch, capping after three retries", () => {
    expect(scheduleRetry({ attempts: {} }, "refetch", now)).toMatchObject({
      pending_action: "refetch",
      next_attempt_at: new Date("2026-10-18T12:01:00Z"),
    })
    expect(scheduleRetry({ attempts: { refetch: 1 } }, "refetch", now).next_attempt_at).toEqual(
      new Date("2026-10-18T12:05:00Z")
    )
    expect(scheduleRetry({ attempts: { refetch: 2 } }, "refetch", now).next_attempt_at).toEqual(
      new Date("2026-10-18T12:15:00Z")
    )
    expect(scheduleRetry({ attempts: { refetch: 3 } }, "refetch", now)).toEqual({
      pending_action: null,
      attempts: { refetch: 4 },
      next_attempt_at: null,
      attention: "retry-cap:refetch",
    })
  })

  it("clears the pending action and that action's count", () => {
    expect(clearRetry({ attempts: { send: 2, cancel: 1 } }, "send")).toEqual({
      pending_action: null,
      // 0, not deleted: Medusa's update merges JSON objects.
      attempts: { send: 0, cancel: 1 },
      next_attempt_at: null,
    })
  })
})

describe("decideCreate", () => {
  it("skips a row confirmed locally", () => {
    expect(decideCreate({ pt_uuid: "pt-1", confirmed_at: new Date() }, null)).toBe("skip-confirmed")
  })

  it("posts a new order, or a draft again", () => {
    expect(decideCreate(null, null)).toBe("post")
    expect(decideCreate({ pt_uuid: "pt-1", confirmed_at: null }, ptOrder())).toBe("post")
  })

  it("posts again over a holding order that was never confirmed (address rejected)", () => {
    expect(
      decideCreate({ pt_uuid: "pt-1", confirmed_at: null }, ptOrder({ status: "holding", fulfillableFrom: null }))
    ).toBe("post")
  })

  it("treats an order found after a create 409 as confirmed unless it reads as a draft", () => {
    const row = { pt_uuid: null, confirmed_at: null }
    expect(decideCreate(row, ptOrder({ status: "holding", fulfillableFrom: null }), { conflict: true })).toBe(
      "adopt-confirmed"
    )
    expect(
      decideCreate(row, ptOrder({ status: "draft", fulfillableFrom: "2026-10-18T12:00:00Z" }), { conflict: true })
    ).toBe("adopt-confirmed")
    expect(decideCreate(row, ptOrder({ status: "cancelled" }), { conflict: true })).toBe("remote-cancelled")
    // Nothing says it was confirmed: block rather than strand it as confirmed.
    expect(decideCreate(row, ptOrder({ status: "draft" }), { conflict: true })).toBe("conflict")
  })

  it("adopts a remote order that is past draft (crash between confirm and confirmed_at)", () => {
    expect(decideCreate({ pt_uuid: "pt-1", confirmed_at: null }, ptOrder({ status: "queued" }))).toBe(
      "adopt-confirmed"
    )
    expect(
      decideCreate(
        { pt_uuid: "pt-1", confirmed_at: null },
        ptOrder({ status: "holding", fulfillableFrom: "2026-10-18T12:00:00Z" })
      )
    ).toBe("adopt-confirmed")
  })

  it("never re-posts a cancelled remote order", () => {
    expect(decideCreate({ pt_uuid: "pt-1", confirmed_at: null }, ptOrder({ status: "cancelled" }))).toBe(
      "remote-cancelled"
    )
  })
})

describe("confirmedAtPrintTrail", () => {
  const AT = "2026-10-19T10:00:00+00:00"
  it("is confirmedAt when Print Trail sends it, else its legacy signals", () => {
    expect(confirmedAtPrintTrail(ptOrder({ status: "holding", confirmedAt: AT, fulfillableFrom: null }))).toBe(true)
    // An order confirmed before confirmedAt existed reads null.
    expect(confirmedAtPrintTrail(ptOrder({ status: "queued", confirmedAt: null, fulfillableFrom: null }))).toBe(true)
    // Held with its address rejected, never confirmed.
    expect(confirmedAtPrintTrail(ptOrder({ status: "holding", confirmedAt: null, fulfillableFrom: null }))).toBe(false)
    expect(confirmedAtPrintTrail(ptOrder({ status: "draft", confirmedAt: null, fulfillableFrom: null }))).toBe(false)
  })

  it.each([
    ["queued", {}, true],
    ["scheduled", {}, true],
    ["processing", {}, true],
    ["holding", { fulfillableFrom: AT }, true],
    ["draft", {}, false],
    ["holding", {}, false],
    // Not the create step's heuristic: nothing says a finished order was confirmed.
    ["complete", {}, false],
  ] as [string, Partial<PtOrder>, boolean][])("an older Print Trail API (no confirmedAt key): %s %o is %s", (status, over, expected) => {
    const remote = ptOrder({ status, fulfillableFrom: null, ...over })
    delete remote.confirmedAt
    expect(confirmedAtPrintTrail(remote)).toBe(expected)
  })
})

describe("decideCreate with confirmedAt and the typed 409", () => {
  const row = { pt_uuid: null, confirmed_at: null }
  const AT = "2026-10-19T10:00:00+00:00"
  it.each([
    // [name, remote, opts, expected]
    ["holding with confirmedAt set is confirmed (fulfillableFrom cleared)", { status: "holding", confirmedAt: AT }, {}, "adopt-confirmed"],
    ["holding with confirmedAt null is the address hold: post", { status: "holding", confirmedAt: null }, {}, "post"],
    ["draft with confirmedAt null: post", { status: "draft", confirmedAt: null }, {}, "post"],
    ["queued with confirmedAt null (pre-backfill) is still confirmed", { status: "queued", confirmedAt: null }, {}, "adopt-confirmed"],
    ["draft with confirmedAt null after a 409: conflict", { status: "draft", confirmedAt: null }, { conflict: true }, "conflict"],
    ["queued with confirmedAt null after a 409: Print Trail's own rule says confirmed", { status: "queued", confirmedAt: null }, { conflict: true }, "adopt-confirmed"],
    ["holding with a countdown and confirmedAt null after a 409", { status: "holding", confirmedAt: null, fulfillableFrom: AT }, { conflict: true }, "adopt-confirmed"],
    ["holding with confirmedAt null after a 409: not confirmed (today: adopt)", { status: "holding", confirmedAt: null }, { conflict: true }, "conflict"],
    ["complete with confirmedAt null after a 409: conflict", { status: "complete", confirmedAt: null }, { conflict: true }, "conflict"],
    ["holding with confirmedAt set after a 409", { status: "holding", confirmedAt: AT }, { conflict: true }, "adopt-confirmed"],
    ["already-confirmed type on a draft-looking order without the key", { status: "draft" }, { conflict: true, problemType: PROBLEM_TYPES.alreadyConfirmed }, "adopt-confirmed"],
    ["already-confirmed type on a cancelled order", { status: "cancelled", confirmedAt: AT }, { conflict: true, problemType: PROBLEM_TYPES.alreadyConfirmed }, "remote-cancelled"],
    ["not-updatable type on a complete order", { status: "complete", confirmedAt: null }, { conflict: true, problemType: PROBLEM_TYPES.notUpdatable }, "conflict"],
    ["not-updatable type on a cancelled order", { status: "cancelled" }, { conflict: true, problemType: PROBLEM_TYPES.notUpdatable }, "remote-cancelled"],
    // API 1.1.1: a finished order answers not-updatable even if it was once
    // confirmed; the order in data says which.
    ["not-updatable type on a confirmed order since complete", { status: "complete", confirmedAt: AT }, { conflict: true, problemType: PROBLEM_TYPES.notUpdatable }, "adopt-confirmed"],
    ["not-updatable type on a confirmed order since partial", { status: "partial", confirmedAt: AT }, { conflict: true, problemType: PROBLEM_TYPES.notUpdatable }, "adopt-confirmed"],
    ["not-updatable type on a confirmed order since failed", { status: "failed", confirmedAt: AT }, { conflict: true, problemType: PROBLEM_TYPES.notUpdatable }, "adopt-confirmed"],
    ["not-updatable type on a confirmed order since returned", { status: "returned", confirmedAt: AT }, { conflict: true, problemType: PROBLEM_TYPES.notUpdatable }, "adopt-confirmed"],
    ["not-updatable type on a confirmed order since cancelled", { status: "cancelled", confirmedAt: AT }, { conflict: true, problemType: PROBLEM_TYPES.notUpdatable }, "remote-cancelled"],
    ["not-updatable type on a complete order confirmed before confirmedAt (countdown)", { status: "complete", confirmedAt: null, fulfillableFrom: AT }, { conflict: true, problemType: PROBLEM_TYPES.notUpdatable }, "adopt-confirmed"],
    ["not-updatable type on a never-confirmed returned order", { status: "returned", confirmedAt: null }, { conflict: true, problemType: PROBLEM_TYPES.notUpdatable }, "conflict"],
    // No 409 yet: post; Print Trail's typed 409 blocks what it can't replace.
    ["complete with confirmedAt null, no 409: post, Print Trail's 409 decides", { status: "complete", confirmedAt: null }, {}, "post"],
    ["partial with confirmedAt null, no 409", { status: "partial", confirmedAt: null }, {}, "post"],
    ["invalid with confirmedAt null, no 409 (Print Trail replaces it)", { status: "invalid", confirmedAt: null }, {}, "post"],
    ["error with confirmedAt null, no 409 (Print Trail replaces it)", { status: "error", confirmedAt: null }, {}, "post"],
    ["processing with confirmedAt null, no 409 (pre-backfill)", { status: "processing", confirmedAt: null }, {}, "adopt-confirmed"],
    ["holding with a countdown and confirmedAt null, no 409", { status: "holding", confirmedAt: null, fulfillableFrom: AT }, {}, "adopt-confirmed"],
    ["an unknown type falls through to the order", { status: "queued" }, { conflict: true, problemType: "about:blank" }, "adopt-confirmed"],
  ] as [string, Partial<PtOrder>, Parameters<typeof decideCreate>[2], string][])("%s", (_name, remote, opts, expected) => {
    expect(decideCreate(row, ptOrder({ fulfillableFrom: null, ...remote }), opts)).toBe(expected)
  })

  it("a row confirmed locally is skipped whatever the type", () => {
    expect(
      decideCreate({ pt_uuid: "x", confirmed_at: new Date() }, ptOrder({ status: "draft" }), { conflict: true, problemType: PROBLEM_TYPES.notUpdatable })
    ).toBe("skip-confirmed")
  })

  it("confirmedAtOf prefers confirmedAt, then fulfillableFrom, then now", () => {
    const now = new Date("2026-10-19T12:00:00Z")
    expect(confirmedAtOf(ptOrder({ confirmedAt: AT, fulfillableFrom: "2026-10-19T11:00:00Z" }), now)).toEqual(new Date(AT))
    expect(confirmedAtOf(ptOrder({ confirmedAt: null, fulfillableFrom: "2026-10-19T11:00:00Z" }), now)).toEqual(new Date("2026-10-19T11:00:00Z"))
    expect(confirmedAtOf(ptOrder({ fulfillableFrom: null }), now)).toEqual(now)
    expect(confirmedAtOf(ptOrder({ confirmedAt: "not a date" }), now)).toEqual(now)
  })
})

describe("interpretConfirmError", () => {
  const err = (status: number, body: unknown) =>
    new PrintTrailApiError("x", status, body, "PUT", "/orders/pt-1/confirm", "detail")

  it("classifies each refusal", () => {
    expect(
      interpretConfirmError(err(409, { message: "m", errors: [{ sku: "A", requested: 1, available: 0 }] }))
    ).toEqual({ kind: "stock", shortfall: [{ sku: "A", requested: 1, available: 0 }] })
    expect(
      interpretConfirmError(
        err(409, { type: "t", title: "Conflict", status: 409, detail: "d", data: { uuid: "pt-1", status: "draft" } })
      )
    ).toMatchObject({ kind: "shipping-conflict", order: { uuid: "pt-1" } })
    expect(interpretConfirmError(err(428, { status: 428, detail: "d" }))).toMatchObject({
      kind: "not-confirmable",
    })
    expect(interpretConfirmError(err(422, { status: 422, detail: "d" }))).toMatchObject({ kind: "invalid" })
    expect(interpretConfirmError(err(503, null))).toMatchObject({ kind: "transient" })
    expect(interpretConfirmError(err(0, null))).toMatchObject({ kind: "transient" })
    expect(interpretConfirmError(err(401, { status: 401, detail: "d" }))).toEqual({ kind: "auth-failed" })
  })

  it("API 1.2.0: an inactive channel, and any other 403 (an inactive team), are refusals", () => {
    expect(interpretConfirmError(err(403, { type: "https://docs.printtrail.com/channel-api/problems/channel-inactive", title: "Channel inactive", status: 403, detail: "This channel is inactive in Print Trail." }))).toEqual({ kind: "channel-inactive" })
    expect(
      interpretConfirmError(err(403, { type: "about:blank", status: 403, detail: "This team is inactive. Orders cannot be created, imported or processed." }))
    ).toEqual({ kind: "rejected-403", detail: "detail" })
  })
})

describe("send lock", () => {
  it("outlives the slowest run the client allows, and expires before a retry is due", () => {
    const perRequestMs =
      (DEFAULT_RETRY_DELAYS_MS.length + 1) * DEFAULT_TIMEOUT_MS +
      DEFAULT_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0)
    // getOrder, createOrder, findOrderByNumber, and confirm twice.
    expect(SEND_LOCK_TTL_SECONDS * 1000).toBeGreaterThan(5 * perRequestMs)
    expect(SEND_LOCK_TTL_SECONDS * 1000).toBeLessThan(RETRY_DELAY_MS)
  })
})

describe("rowsPerRun", () => {
  it("fits a run's Print Trail calls inside the lock's ttl", () => {
    expect(PT_CALL_SECONDS).toBe(67)
    // (600 − 60) / (3 × 67) = 2.69 → 2 rows; (600 − 60) / (4 × 67) = 2.01 → 2.
    expect(rowsPerRun(SEND_LOCK_TTL_SECONDS, 3)).toBe(2)
    expect(rowsPerRun(SEND_LOCK_TTL_SECONDS, 4)).toBe(2)
    expect(rowsPerRun(SEND_LOCK_TTL_SECONDS, 1)).toBe(8)
    // Always at least one, so a run makes progress.
    expect(rowsPerRun(100, 3)).toBe(1)
    expect(rowsPerRun(SEND_LOCK_TTL_SECONDS, 3) * 3 * PT_CALL_SECONDS).toBeLessThanOrEqual(SEND_LOCK_TTL_SECONDS - 60)
  })
})

describe("remoteSubmittedLines (a lost row's lines, from Print Trail's order)", () => {
  const ol = (lineNumber: string | null, quantity: number, sku?: string) => ({
    lineNumber,
    quantity,
    ...(sku ? { product: { sku } } : {}),
  })
  const of = (orderLines?: ReturnType<typeof ol>[]) => remoteSubmittedLines({ uuid: "u", status: "complete", orderLines })

  it("merges a line split across fulfilments by line number, summing quantities", () => {
    expect(of([ol("a", 1, "978-A"), ol("b", 1, "978-B"), ol("a", 2, "978-A")])).toEqual([
      { lineNumber: "a", quantity: 3, product: { sku: "978-A" } },
      { lineNumber: "b", quantity: 1, product: { sku: "978-B" } },
    ])
  })

  it("drops a zero quantity and a missing line number", () => {
    expect(of([ol("a", 0, "978-A"), ol(null, 2, "978-B"), ol("c", 1, "978-C")])).toEqual([
      { lineNumber: "c", quantity: 1, product: { sku: "978-C" } },
    ])
  })

  it("keeps a line without a SKU, with no SKU", () => {
    expect(of([ol("a", 1)])).toEqual([{ lineNumber: "a", quantity: 1, product: {} }])
  })

  it("is empty for an order without lines", () => {
    expect(of(undefined)).toEqual([])
  })
})
