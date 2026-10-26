import type { PtFulfilment, PtOrder, PtTrackingDetail } from "../../modules/printTrail/client/types"
import {
  attentionCode,
  completionDecision,
  DISMISSABLE_REMOTE_ATTENTION,
  keepDismissed,
  pickRemote,
  readDismissed,
  remoteAttentionKeys,
  writeDismissed,
  coverageComplete,
  diffRemote,
  isSyncAttention,
  labelsFrom,
  matchPrintTrailOrder,
  nextAttention,
  planDispatch,
  ptBackToDraft,
  remoteAttention,
  type DispatchOrder,
  type MatchRow,
} from "../sync-decisions"

const track = (n: string): PtTrackingDetail => ({
  carrier: "Royal Mail",
  trackingNumber: n,
  trackingUrl: `https://rm.example/${n}`,
})

const ful = (over: Partial<PtFulfilment> = {}): PtFulfilment => ({
  uuid: "f-1",
  fulfilmentNumber: "acme-ord-1001-1",
  status: "processing",
  orderLines: [{ lineNumber: "item_a", quantity: 2 }],
  requestedShippingMethod: "standard",
  trackingDetails: [],
  ...over,
})

const pt = (over: Partial<PtOrder> = {}): PtOrder => ({
  uuid: "pt-1",
  orderNumber: "ORD-1001",
  status: "queued",
  fulfillableStatus: "fulfillable",
  fulfilments: [ful()],
  errors: [],
  ...over,
})

const snap = (o: PtOrder) => ({
  status: o.status,
  fulfillable_status: o.fulfillableStatus,
  fulfilments: o.fulfilments,
  errors: o.errors,
})

describe("diffRemote", () => {
  it("diffRemote reports nothing for identical snapshots", () => {
    const o = pt({ fulfilments: [ful({ status: "dispatched", trackingDetails: [track("T1")] })] })
    expect(diffRemote(snap(o), o)).toEqual([])
  })

  it("reports order, fulfillable and error changes", () => {
    const prev = pt()
    const next = pt({
      status: "holding",
      fulfillableStatus: "not-fulfillable",
      errors: [{ code: "x", key: "x", message: "m" }],
    })
    expect(diffRemote(snap(prev), next)).toEqual([
      { kind: "order-status", from: "queued", to: "holding" },
      { kind: "fulfillable-status", from: "fulfillable", to: "not-fulfillable" },
      { kind: "errors", errors: [{ code: "x", key: "x", message: "m" }] },
    ])
  })

  it("diffRemote matches a regenerated fulfilment by its number", () => {
    const prev = pt()
    const next = pt({ fulfilments: [ful({ uuid: "f-2", status: "dispatched", requestedShippingMethod: "express" })] })
    expect(diffRemote(snap(prev), next)).toEqual([
      { kind: "fulfilment-status", uuid: "f-2", number: "acme-ord-1001-1", from: "processing", to: "dispatched" },
    ])
  })

  it("diffRemote reports only new tracking numbers", () => {
    const prev = pt({ fulfilments: [ful({ status: "dispatched", trackingDetails: [track("T1")] })] })
    const next = pt({
      fulfilments: [ful({ status: "dispatched", trackingDetails: [track("T1"), track("T2"), {}] })],
    })
    expect(diffRemote(snap(prev), next)).toEqual([
      { kind: "tracking-added", uuid: "f-1", number: "acme-ord-1001-1", tracking: [track("T2")] },
    ])
  })

  it("diffRemote reports a shipping-method change only for the same fulfilment", () => {
    const prev = pt()
    const same = pt({ fulfilments: [ful({ requestedShippingMethod: "express" })] })
    expect(diffRemote(snap(prev), same)).toEqual([
      { kind: "shipping-method", uuid: "f-1", number: "acme-ord-1001-1", from: "standard", to: "express" },
    ])
    const regenerated = pt({ fulfilments: [ful({ uuid: "f-9", requestedShippingMethod: "express" })] })
    expect(diffRemote(snap(prev), regenerated)).toEqual([])
    const unset = pt({ fulfilments: [ful({ requestedShippingMethod: null })] })
    expect(diffRemote(snap(prev), unset)).toEqual([])
  })

  it("reports every fulfilment of a first snapshot", () => {
    expect(diffRemote({ status: "queued" }, pt())).toEqual([
      { kind: "fulfillable-status", from: null, to: "fulfillable" },
      { kind: "fulfilment-status", uuid: "f-1", number: "acme-ord-1001-1", from: null, to: "processing" },
    ])
  })
})

describe("attention", () => {
  const confirmed = { confirmed_at: new Date("2026-10-19T10:00:00Z"), cancel_requested: false }

  it("remoteAttention flags a Print Trail cancel but not one Medusa requested", () => {
    expect(remoteAttention(confirmed, pt({ status: "cancelled" }))).toBe("pt-cancelled")
    expect(
      remoteAttention(confirmed, pt({ status: "processing", fulfilments: [ful({ status: "cancelled" })] }))
    ).toBe("pt-cancelled")
    expect(remoteAttention({ ...confirmed, cancel_requested: true }, pt({ status: "cancelled" }))).toBeNull()
  })

  it("remoteAttention flags a returned order, and a returned fulfilment", () => {
    expect(remoteAttention(confirmed, pt({ status: "returned", fulfilments: [ful({ status: "returned" })] }))).toBe("pt-returned")
    expect(
      remoteAttention(confirmed, pt({ status: "complete", fulfilments: [ful({ status: "dispatched" }), ful({ status: "returned" })] }))
    ).toBe("pt-fulfilment-returned")
  })

  it("remoteAttention flags draft after confirm", () => {
    expect(remoteAttention(confirmed, pt({ status: "draft", fulfilments: [] }))).toBe("pt-draft-after-confirm")
    expect(remoteAttention({ confirmed_at: null }, pt({ status: "draft" }))).toBeNull()
  })

  it("a draft with confirmedAt set is not back to draft (an amend's rebuild)", () => {
    const o = pt({ status: "draft", fulfilments: [], confirmedAt: "2026-10-19T10:00:00+00:00" })
    expect(ptBackToDraft(o)).toBe(false)
    expect(remoteAttention(confirmed, o)).not.toBe("pt-draft-after-confirm")
  })

  it("holding or queued with confirmedAt null (not backfilled) is not back to draft", () => {
    for (const status of ["holding", "queued"]) {
      const o = pt({ status, confirmedAt: null })
      expect(ptBackToDraft(o)).toBe(false)
      expect(remoteAttention(confirmed, o)).not.toBe("pt-draft-after-confirm")
    }
  })

  it("draft with confirmedAt null, or with the key absent, is back to draft", () => {
    for (const o of [pt({ status: "draft", fulfilments: [], confirmedAt: null }), pt({ status: "draft", fulfilments: [] })]) {
      expect(ptBackToDraft(o)).toBe(true)
      expect(remoteAttention(confirmed, o)).toBe("pt-draft-after-confirm")
    }
  })

  it("remoteAttention flags a single cancelled fulfilment", () => {
    const o = pt({ fulfilments: [ful({ status: "cancelled" }), ful({ uuid: "f-2", status: "dispatched" })] })
    expect(remoteAttention(confirmed, o)).toBe("pt-fulfilment-cancelled")
  })

  it("flags order and fulfilment holds, and fulfillability after confirm only", () => {
    expect(remoteAttention(confirmed, pt({ status: "back-order" }))).toBe("pt-back-order")
    expect(remoteAttention(confirmed, pt({ fulfilments: [ful({ status: "failed" })] }))).toBe("pt-fulfilment-failed")
    expect(remoteAttention(confirmed, pt({ fulfillableStatus: "partially-fulfillable" }))).toBe(
      "pt-partially-fulfillable"
    )
    expect(remoteAttention({ confirmed_at: null }, pt({ status: "draft", fulfillableStatus: "not-fulfillable" }))).toBeNull()
    expect(remoteAttention(confirmed, pt())).toBeNull()
  })

  it("nextAttention never clears a send block", () => {
    expect(isSyncAttention("unmatched-skus")).toBe(false)
    expect(isSyncAttention("retry-cap:send")).toBe(false)
    expect(isSyncAttention("retry-cap:refetch")).toBe(true)
    expect(isSyncAttention("pt-holding")).toBe(true)
    expect(nextAttention("unmatched-skus", "pt-holding")).toBe("unmatched-skus")
    expect(nextAttention("stock-shortfall", null)).toBe("stock-shortfall")
    expect(nextAttention("unmatched-skus", "pt-cancelled")).toBe("pt-cancelled")
    expect(nextAttention("retry-cap:confirm", "pt-draft-after-confirm")).toBe("pt-draft-after-confirm")
  })

  it("replaces a stale remote code but keeps the dispatch-side codes", () => {
    expect(nextAttention("pt-holding", null)).toBeNull()
    expect(nextAttention("pt-order-missing", "pt-back-order")).toBe("pt-back-order")
    expect(nextAttention(null, "pt-holding")).toBe("pt-holding")
    expect(nextAttention("dispatched-after-cancel", "pt-partial")).toBe("dispatched-after-cancel")
    expect(nextAttention("complete-manually", null)).toBe("complete-manually")
    expect(nextAttention("dispatch-mismatch", "pt-cancelled")).toBe("pt-cancelled")
  })

  it("lists every remote attention key in remoteAttention's order, a fulfilment's keyed by its number", () => {
    expect([...DISMISSABLE_REMOTE_ATTENTION].sort()).toEqual([
      "pt-fulfilment-failed",
      "pt-fulfilment-returned",
      "pt-partial",
      "pt-pre-order-inactive",
      "pt-returned",
    ])
    const confirmed = { confirmed_at: "2026-10-19T10:00:00Z" }
    const f = (n: string, status: string) => ({ uuid: `u-${n}`, fulfilmentNumber: n, status }) as unknown as PtFulfilment
    const order = {
      uuid: "o",
      status: "partial",
      fulfillableStatus: "partially-fulfillable",
      fulfilments: [f("F1", "returned"), f("F2", "dispatched"), f("F3", "failed")],
    } as unknown as PtOrder
    const keys = remoteAttentionKeys(confirmed, order)
    expect(keys).toEqual(["pt-partial", "pt-fulfilment-returned:F1", "pt-fulfilment-failed:F3", "pt-partially-fulfillable"])
    expect(attentionCode(keys[1])).toBe("pt-fulfilment-returned")
    expect(remoteAttention(confirmed, order)).toBe("pt-partial")
    // Falls back to the uuid without a number.
    const bare = { ...order, status: "processing", fulfilments: [{ uuid: "u-9", status: "failed" }] } as unknown as PtOrder
    expect(remoteAttentionKeys(confirmed, bare)).toEqual(["pt-fulfilment-failed:u-9", "pt-partially-fulfillable"])
    // A Print Trail cancel stands alone.
    expect(remoteAttentionKeys(confirmed, { ...order, status: "cancelled" } as PtOrder)).toEqual(["pt-cancelled"])
  })

  it("pickRemote raises the first key not dismissed; keepDismissed forgets only Print Trail keys that are gone", () => {
    const keys = ["pt-partial", "pt-fulfilment-returned:F1", "pt-fulfilment-failed:F3"]
    expect(pickRemote(keys, [])).toBe("pt-partial")
    expect(pickRemote(keys, ["pt-partial"])).toBe("pt-fulfilment-returned")
    expect(pickRemote(keys, ["pt-partial", "pt-fulfilment-returned:F1"])).toBe("pt-fulfilment-failed")
    expect(pickRemote(keys, keys)).toBeNull()
    expect(pickRemote([], ["pt-partial"])).toBeNull()
    expect(keepDismissed(["pt-fulfilment-returned:F1", "pt-returned"], keys)).toEqual(["pt-fulfilment-returned:F1"])
    // A local key (complete-manually) is the completion step's to forget.
    expect(keepDismissed(["complete-manually", "pt-returned"], [])).toEqual(["complete-manually"])
  })

  it("stores the dismissed keys as text", () => {
    const row = { pt_uuid: "uuid-1", dismissed_attention: null as string | null }
    expect(readDismissed(row)).toEqual([])
    row.dismissed_attention = writeDismissed("uuid-1", ["pt-partial", "pt-fulfilment-failed:F3"])
    expect(typeof row.dismissed_attention).toBe("string")
    expect(readDismissed(row)).toEqual(["pt-partial", "pt-fulfilment-failed:F3"])
    expect(writeDismissed("uuid-1", [])).toBeNull()
  })

  it("stores keys whose fulfilment number has a comma or a bar intact", () => {
    const keys = ["pt-fulfilment-failed:A,B", "pt-fulfilment-returned:C|D", "pt-partial"]
    const value = writeDismissed("uuid-1", keys)
    expect(readDismissed({ pt_uuid: "uuid-1", dismissed_attention: value })).toEqual(keys)
    expect(pickRemote(["pt-fulfilment-failed:A,B"], readDismissed({ pt_uuid: "uuid-1", dismissed_attention: value }))).toBeNull()
  })

  it("ties the dismissed keys to the Print Trail order they were dismissed on", () => {
    const value = writeDismissed("uuid-1", ["pt-partial"])
    expect(readDismissed({ pt_uuid: "uuid-1", dismissed_attention: value })).toEqual(["pt-partial"])
    expect(readDismissed({ pt_uuid: "uuid-2", dismissed_attention: value })).toEqual([])
    expect(readDismissed({ pt_uuid: null, dismissed_attention: value })).toEqual([])
  })
})

describe("labelsFrom", () => {
  it("falls back to the legacy fields and drops empty entries", () => {
    expect(labelsFrom([{ number: "N1", url: "https://u/1" }, { carrier: "x" }, track("T1")])).toEqual([
      { tracking_number: "N1", tracking_url: "https://u/1", label_url: "https://u/1" },
      { tracking_number: "T1", tracking_url: "https://rm.example/T1", label_url: "https://rm.example/T1" },
    ])
    expect(labelsFrom([{ trackingNumber: "N2" }])).toEqual([{ tracking_number: "N2", tracking_url: "", label_url: "" }])
    expect(labelsFrom(undefined)).toEqual([])
  })
})

describe("planDispatch", () => {
  const row = { id: "ptord_1", order_id: "order_1" }
  const order = (over: Partial<DispatchOrder> = {}): DispatchOrder => ({
    id: "order_1",
    status: "pending",
    canceled_at: null,
    items: [
      { id: "item_a", quantity: 2, fulfilled_quantity: 0, shipping_profile_id: "sp_pt" },
      { id: "item_b", quantity: 1, fulfilled_quantity: 0, shipping_profile_id: "sp_pt" },
    ],
    fulfillments: [],
    ptOptionIdByProfile: { sp_pt: "so_pt" },
    ...over,
  })
  const twoParcels = pt({
    fulfilments: [
      ful({ status: "dispatched", trackingDetails: [track("T1")] }),
      ful({
        uuid: "f-2",
        fulfilmentNumber: "acme-ord-1001-2",
        status: "processing",
        orderLines: [{ lineNumber: "item_b", quantity: 1 }],
      }),
    ],
  })

  it("planDispatch creates one fulfilment per dispatched Print Trail fulfilment", () => {
    const plan = planDispatch(twoParcels, order(), row)
    expect(plan).toEqual({
      orderCanceled: false,
      create: [
        {
          ptFulfilmentUuid: "f-1",
          ptFulfilmentNumber: "acme-ord-1001-1",
          shippingOptionId: "so_pt",
          items: [{ id: "item_a", quantity: 2 }],
          labels: [{ tracking_number: "T1", tracking_url: "https://rm.example/T1", label_url: "https://rm.example/T1" }],
          metadata: {
            print_trail_fulfilment_uuid: "f-1",
            print_trail_fulfilment_number: "acme-ord-1001-1",
            print_trail_order_uuid: "pt-1",
            print_trail_order_id: "ptord_1",
            order_id: "order_1",
            carrier: "Royal Mail",
            print_trail_shipping_option_id: "so_pt",
          },
        },
      ],
      ship: [],
      addTracking: [],
      mismatches: [],
    })
  })

  it("planDispatch caps quantity at what is left to fulfil", () => {
    const o = order({
      items: [{ id: "item_a", quantity: 2, fulfilled_quantity: 1, shipping_profile_id: "sp_pt" }],
    })
    expect(planDispatch(twoParcels, o, row).create[0].items).toEqual([{ id: "item_a", quantity: 1 }])
    const done = order({
      items: [{ id: "item_a", quantity: 2, fulfilled_quantity: 2, shipping_profile_id: "sp_pt" }],
    })
    const plan = planDispatch(twoParcels, done, row)
    expect(plan.create).toEqual([])
    expect(plan.mismatches).toEqual([{ ptFulfilment: "f-1", lineNumber: "item_a", reason: "over-quantity" }])
  })

  it("planDispatch skips a fulfilment already created and ships it if unshipped", () => {
    const unshipped = order({
      fulfillments: [
        { id: "ful_old", canceled_at: new Date(), metadata: { print_trail_fulfilment_uuid: "f-1" }, labels: [] },
        { id: "ful_1", shipped_at: null, metadata: { print_trail_fulfilment_uuid: "f-1" }, labels: [] },
      ],
    })
    const plan = planDispatch(twoParcels, unshipped, row)
    expect(plan.create).toEqual([])
    expect(plan.ship).toEqual([
      {
        fulfillmentId: "ful_1",
        items: [{ id: "item_a", quantity: 2 }],
        labels: [{ tracking_number: "T1", tracking_url: "https://rm.example/T1", label_url: "https://rm.example/T1" }],
      },
    ])
    const byNumber = order({
      fulfillments: [
        {
          id: "ful_1",
          shipped_at: new Date(),
          metadata: { print_trail_fulfilment_uuid: "f-old", print_trail_fulfilment_number: "acme-ord-1001-1" },
          labels: [{ id: "lbl_1", tracking_number: "T1", tracking_url: "", label_url: "" }],
        },
      ],
    })
    expect(planDispatch(twoParcels, byNumber, row)).toMatchObject({ create: [], ship: [], addTracking: [] })
  })

  it("planDispatch tracks each shipping option of a split Print Trail fulfilment", () => {
    const split = order({
      items: [
        { id: "item_a", quantity: 2, fulfilled_quantity: 2, shipping_profile_id: "sp_pt" },
        { id: "item_b", quantity: 1, fulfilled_quantity: 0, shipping_profile_id: "sp_pt2" },
      ],
      ptOptionIdByProfile: { sp_pt: "so_pt", sp_pt2: "so_pt2" },
      fulfillments: [
        {
          id: "ful_1",
          shipped_at: new Date(),
          metadata: { print_trail_fulfilment_uuid: "f-1", print_trail_shipping_option_id: "so_pt" },
          labels: [{ id: "lbl_1", tracking_number: "T1", tracking_url: "", label_url: "" }],
        },
      ],
    })
    const both = pt({
      fulfilments: [
        ful({
          status: "dispatched",
          trackingDetails: [track("T1")],
          orderLines: [
            { lineNumber: "item_a", quantity: 2 },
            { lineNumber: "item_b", quantity: 1 },
          ],
        }),
      ],
    })
    const plan = planDispatch(both, split, row)
    expect(plan.ship).toEqual([])
    expect(plan.addTracking).toEqual([])
    expect(plan.mismatches).toEqual([])
    expect(plan.create).toEqual([
      expect.objectContaining({
        shippingOptionId: "so_pt2",
        items: [{ id: "item_b", quantity: 1 }],
        metadata: expect.objectContaining({ print_trail_shipping_option_id: "so_pt2" }),
      }),
    ])
  })

  it("planDispatch adds late tracking to a shipped fulfilment", () => {
    const o = order({
      fulfillments: [
        {
          id: "ful_1",
          shipped_at: new Date(),
          metadata: { print_trail_fulfilment_uuid: "f-1" },
          labels: [{ id: "lbl_1", tracking_number: "T1", tracking_url: "", label_url: "" }],
        },
      ],
    })
    const late = pt({ fulfilments: [ful({ status: "dispatched", trackingDetails: [track("T1"), track("T2")] })] })
    expect(planDispatch(late, o, row).addTracking).toEqual([
      {
        fulfillmentId: "ful_1",
        keep: [{ id: "lbl_1" }],
        added: [{ tracking_number: "T2", tracking_url: "https://rm.example/T2", label_url: "https://rm.example/T2" }],
      },
    ])
  })

  it("planDispatch does nothing for a cancelled order", () => {
    expect(planDispatch(twoParcels, order({ status: "canceled", canceled_at: new Date() }), row)).toEqual({
      orderCanceled: true,
      create: [],
      ship: [],
      addTracking: [],
      mismatches: [],
    })
  })

  it("planDispatch reports a line that is not on the order", () => {
    const o = pt({
      fulfilments: [
        ful({
          status: "dispatched",
          orderLines: [
            { lineNumber: "item_a", quantity: 2 },
            { lineNumber: "item_zzz", quantity: 1 },
          ],
        }),
      ],
    })
    const noOption = order({
      items: [
        { id: "item_a", quantity: 2, fulfilled_quantity: 0, shipping_profile_id: "sp_pt" },
        { id: "item_b", quantity: 1, fulfilled_quantity: 0, shipping_profile_id: "sp_other" },
      ],
    })
    const plan = planDispatch(o, noOption, row)
    expect(plan.create.map((c) => c.items)).toEqual([[{ id: "item_a", quantity: 2 }]])
    expect(plan.mismatches).toEqual([{ ptFulfilment: "f-1", lineNumber: "item_zzz", reason: "unknown-line" }])
    const other = pt({ fulfilments: [ful({ status: "dispatched", orderLines: [{ lineNumber: "item_b", quantity: 1 }] })] })
    expect(planDispatch(other, noOption, row).mismatches).toEqual([
      { ptFulfilment: "f-1", lineNumber: "item_b", reason: "no-print-trail-option" },
    ])
  })
})

describe("completion", () => {
  const submitted = [
    { lineNumber: "item_a", quantity: 2 },
    { lineNumber: "item_b", quantity: 1 },
  ]
  const dispatched = (lines: { lineNumber: string; quantity: number }[], status = "dispatched") =>
    ful({ uuid: lines[0].lineNumber, status, orderLines: lines })

  it("coverageComplete needs every line and quantity", () => {
    expect(coverageComplete(submitted, { fulfilments: [dispatched(submitted)] })).toBe(true)
    expect(
      coverageComplete(submitted, {
        fulfilments: [dispatched([{ lineNumber: "item_a", quantity: 1 }]), dispatched([{ lineNumber: "item_a", quantity: 1 }, { lineNumber: "item_b", quantity: 1 }])],
      })
    ).toBe(true)
    expect(coverageComplete(submitted, { fulfilments: [dispatched([{ lineNumber: "item_a", quantity: 2 }])] })).toBe(false)
    expect(coverageComplete(submitted, { fulfilments: [dispatched(submitted, "processing")] })).toBe(false)
    expect(coverageComplete([], { fulfilments: [dispatched(submitted)] })).toBe(false)
    expect(coverageComplete(null, { fulfilments: [] })).toBe(false)
  })

  it("completionDecision waits, completes, or flags", () => {
    const items = [
      { id: "item_a", quantity: 2 },
      { id: "item_b", quantity: 1 },
    ]
    const base = { autoComplete: true, orderStatus: "pending", orderItems: items }
    const rowWith = (fulfilments: PtFulfilment[], over: Record<string, unknown> = {}) => ({
      pt_uuid: "pt-1",
      submitted_lines: submitted,
      fulfilments,
      fulfillable_status: "fulfillable",
      ...over,
    })
    const all = rowWith([dispatched(submitted)])

    expect(completionDecision({ ...base, autoComplete: false, rows: [all] })).toEqual({ action: "none" })
    expect(completionDecision({ ...base, orderStatus: "completed", rows: [all] })).toEqual({ action: "none" })
    expect(completionDecision({ ...base, rows: [] })).toEqual({ action: "none" })
    expect(completionDecision({ ...base, rows: [rowWith([])] })).toEqual({ action: "wait" })
    expect(completionDecision({ ...base, rows: [rowWith([dispatched(submitted, "processing")])] })).toEqual({
      action: "wait",
    })
    expect(completionDecision({ ...base, rows: [all] })).toEqual({ action: "complete" })
    expect(
      completionDecision({ ...base, rows: [rowWith([dispatched(submitted), dispatched([{ lineNumber: "x", quantity: 1 }], "cancelled")])] })
    ).toEqual({ action: "attention", reason: "incomplete-dispatch" })
    expect(completionDecision({ ...base, rows: [rowWith([dispatched(submitted)], { fulfillable_status: "partially-fulfillable" })] })).toEqual({
      action: "attention",
      reason: "incomplete-dispatch",
    })
    expect(completionDecision({ ...base, rows: [rowWith([dispatched([{ lineNumber: "item_a", quantity: 2 }])])] })).toEqual({
      action: "attention",
      reason: "incomplete-dispatch",
    })
    // A Print Trail cancel is its own attention, not "complete by hand".
    const cancelled = [dispatched(submitted, "cancelled")]
    expect(completionDecision({ ...base, rows: [rowWith(cancelled, { status: "cancelled" })] })).toEqual({ action: "none" })
    expect(completionDecision({ ...base, rows: [rowWith(cancelled)] })).toEqual({ action: "none" })
    expect(
      completionDecision({ ...base, orderItems: [...items, { id: "item_other", quantity: 1 }, { id: "item_gone", quantity: 0 }], rows: [all] })
    ).toEqual({ action: "attention", reason: "other-items" })
    // A fractional item (sold by weight, say) is still another item.
    expect(completionDecision({ ...base, orderItems: [...items, { id: "item_weighed", quantity: 0.5 }], rows: [all] })).toEqual({
      action: "attention",
      reason: "other-items",
    })
  })

  // Print Trail's partial status: final, set once every
  // fulfilment has finished with at least one dispatched and at least one
  // failed or cancelled.
  it("a partial Print Trail order raises attention and is never auto-completed", () => {
    const items = [
      { id: "item_a", quantity: 2 },
      { id: "item_b", quantity: 1 },
    ]
    const base = { autoComplete: true, orderStatus: "pending", orderItems: items }
    const shipped = dispatched([{ lineNumber: "item_a", quantity: 2 }])
    for (const lost of ["cancelled", "failed"]) {
      const other = { ...dispatched([{ lineNumber: "item_b", quantity: 1 }], lost), uuid: "f-2" }
      const order = pt({ status: "partial", fulfilments: [shipped, other] })
      expect(remoteAttention({ confirmed_at: new Date() }, order)).toMatch(/^pt-/)
      const decision = completionDecision({
        ...base,
        rows: [{ pt_uuid: "pt-1", submitted_lines: submitted, fulfilments: order.fulfilments, fulfillable_status: "fulfillable", status: "partial" }],
      })
      expect(decision.action).not.toBe("complete")
    }
    // With no fulfilment detail, the status alone still raises attention.
    expect(remoteAttention({ confirmed_at: new Date() }, pt({ status: "partial", fulfilments: [] }))).toBe("pt-partial")
  })
})

describe("matchPrintTrailOrder", () => {
  const rows: MatchRow[] = [
    { id: "ptord_1", order_id: "order_1", pt_uuid: "pt-1", pt_order_number: "ORD-1001" },
    { id: "ptord_2", order_id: "order_2", pt_uuid: null, pt_order_number: "ORD-1002" },
  ]
  const find = {
    byUuid: async (u: string) => rows.find((r) => r.pt_uuid === u) ?? null,
    byNumber: async (n: string) => rows.filter((r) => r.pt_order_number === n),
  }

  it("finds a row by uuid", async () => {
    expect(await matchPrintTrailOrder({ uuid: "pt-1", orderNumber: "ORD-1001" }, find)).toEqual({
      kind: "row",
      row: rows[0],
    })
  })

  it("matchPrintTrailOrder adopts our own order whose uuid was never stored", async () => {
    expect(await matchPrintTrailOrder({ uuid: "pt-2", orderNumber: "ORD-1002" }, find)).toEqual({
      kind: "adopt",
      row: rows[1],
    })
  })

  it("matchPrintTrailOrder recognises a -COPY and never adopts it", async () => {
    expect(await matchPrintTrailOrder({ uuid: "pt-c", orderNumber: "ORD-1001-COPY" }, find)).toEqual({
      kind: "copy",
      row: rows[0],
      copyNumber: "ORD-1001-COPY",
    })
    expect(await matchPrintTrailOrder({ uuid: "pt-c", orderNumber: "ORD-1002-copy-2" }, find)).toMatchObject({
      kind: "copy",
      row: rows[1],
    })
    expect(await matchPrintTrailOrder({ uuid: "pt-c", orderNumber: "ORD-9-COPY" }, find)).toMatchObject({
      kind: "unknown",
    })
  })

  it("matchPrintTrailOrder ignores an order number with a different uuid", async () => {
    expect(await matchPrintTrailOrder({ uuid: "pt-x", orderNumber: "ORD-1001" }, find)).toEqual({
      kind: "unknown",
      why: "number-known-uuid-differs",
    })
    expect(await matchPrintTrailOrder({ uuid: "pt-x", orderNumber: "OTHER" }, find)).toMatchObject({ kind: "unknown" })
  })
})

// API 1.3.0: a fulfilment waiting for a pre-order release is not attention.
describe("pre-order back-orders", () => {
  const confirmed = { confirmed_at: new Date("2026-10-19T10:00:00Z"), cancel_requested: false }
  const waiting = (over: Partial<PtFulfilment> = {}) =>
    ful({ uuid: "f-w", fulfilmentNumber: "acme-ord-1001-1", status: "back-order", backOrderReason: "pre-order", sentToWarehouseAt: null, orderLines: [{ lineNumber: "item_b", quantity: 1 }], ...over })
  const inStock = (over: Partial<PtFulfilment> = {}) =>
    ful({ uuid: "f-s", fulfilmentNumber: "acme-ord-1001-2", backOrderReason: null, ...over })

  it("an order waiting for release needs no attention", () => {
    expect(remoteAttention(confirmed, pt({ status: "back-order", fulfilments: [waiting()] }))).toBeNull()
    expect(remoteAttention(confirmed, pt({ status: "queued", fulfilments: [waiting()] }))).toBeNull()
  })

  it("a mixed order with a waiting part needs no attention", () => {
    expect(remoteAttention(confirmed, pt({ status: "processing", fulfilments: [waiting(), inStock()] }))).toBeNull()
    expect(remoteAttention(confirmed, pt({ status: "processing", fulfilments: [waiting(), inStock({ status: "dispatched" })] }))).toBeNull()
  })

  it("the reason switching to out-of-stock raises attention", () => {
    const before = pt({ status: "queued", fulfilments: [waiting()] })
    const after = pt({ status: "queued", fulfilments: [waiting({ backOrderReason: "out-of-stock" })] })
    expect(remoteAttention(confirmed, after)).toBe("pt-fulfilment-back-order")
    expect(diffRemote(snap(before), after)).toEqual([
      { kind: "back-order-reason", uuid: "f-w", number: "acme-ord-1001-1", from: "pre-order", to: "out-of-stock" },
    ])
    // A waiting order past its countdown: the order status says so too.
    expect(remoteAttention(confirmed, pt({ status: "back-order", fulfilments: [waiting({ backOrderReason: "out-of-stock" })] }))).toBe("pt-back-order")
  })

  // A product set inactive keeps its waiting orders held as pre-order until it
  // goes active. Low priority: last.
  it("a waiting fulfilment whose product isn't active is low-priority attention", () => {
    const line = (activeState: string) => ({ lineNumber: "item_b", quantity: 1, product: { sku: "P", activeState } })
    const inactive = waiting({ orderLines: [line("inactive")] })
    expect(remoteAttentionKeys(confirmed, pt({ status: "back-order", fulfilments: [inactive] }))).toEqual(["pt-pre-order-inactive:acme-ord-1001-1"])
    expect(remoteAttention(confirmed, pt({ status: "back-order", fulfilments: [inactive] }))).toBe("pt-pre-order-inactive")
    // Not before confirm, like not-fulfillable: a draft awaiting payment.
    expect(remoteAttentionKeys({ confirmed_at: null }, pt({ status: "draft", fulfilments: [inactive] }))).toEqual([])
    expect(remoteAttentionKeys(confirmed, pt({ status: "processing", fulfilments: [inactive, inStock({ status: "holding" })] }))).toEqual([
      "pt-fulfilment-holding:acme-ord-1001-2",
      "pt-pre-order-inactive:acme-ord-1001-1",
    ])
    expect(remoteAttention(confirmed, pt({ status: "back-order", fulfilments: [waiting({ orderLines: [line("pre-order")] })] }))).toBeNull()
    // An out-of-stock back-order of an active product is today's attention.
    expect(remoteAttentionKeys(confirmed, pt({ status: "queued", fulfilments: [waiting({ backOrderReason: "out-of-stock", orderLines: [line("active")] })] }))).toEqual([
      "pt-fulfilment-back-order:acme-ord-1001-1",
    ])
  })

  it("a warehouse back-order is attention", () => {
    expect(remoteAttention(confirmed, pt({ fulfilments: [waiting({ backOrderReason: "warehouse", sentToWarehouseAt: "2026-10-19T00:00:00Z" })] }))).toBe("pt-fulfilment-back-order")
  })

  it("diffRemote marks waiting and released fulfilments", () => {
    const draft = pt({ status: "draft", fulfilments: [] })
    const queued = pt({ fulfilments: [waiting()] })
    expect(diffRemote(snap(draft), queued)).toContainEqual(
      expect.objectContaining({ kind: "fulfilment-status", uuid: "f-w", from: null, to: "back-order", waiting: true })
    )
    const released = pt({ fulfilments: [waiting({ status: "processing", backOrderReason: null })] })
    expect(diffRemote(snap(queued), released)).toEqual([
      expect.objectContaining({ kind: "fulfilment-status", from: "back-order", to: "processing", released: true }),
    ])
  })

  it("backOrderReason wins over activeState", () => {
    const lines = [{ lineNumber: "item_b", quantity: 1, product: { sku: "P", activeState: "pre-order" } }]
    expect(remoteAttention(confirmed, pt({ fulfilments: [waiting({ backOrderReason: "out-of-stock", orderLines: lines })] }))).toBe("pt-fulfilment-back-order")
    // Without the key, all-pre-order lines are the fallback.
    const fallback = ful({ status: "back-order", orderLines: lines })
    expect(remoteAttention(confirmed, pt({ fulfilments: [fallback] }))).toBeNull()
  })

  it("without either field, back-order is attention as today", () => {
    expect(remoteAttention(confirmed, pt({ fulfilments: [ful({ status: "back-order" })] }))).toBe("pt-fulfilment-back-order")
    expect(remoteAttention(confirmed, pt({ status: "back-order", fulfilments: [ful({ status: "back-order" })] }))).toBe("pt-back-order")
    expect(remoteAttention(confirmed, pt({ status: "back-order", fulfilments: [] }))).toBe("pt-back-order")
  })

  it("no auto-complete while a part waits", () => {
    const submitted = [
      { lineNumber: "item_a", quantity: 2 },
      { lineNumber: "item_b", quantity: 1 },
    ]
    const decision = completionDecision({
      autoComplete: true,
      orderStatus: "pending",
      orderItems: [
        { id: "item_a", quantity: 2 },
        { id: "item_b", quantity: 1 },
      ],
      rows: [{ pt_uuid: "pt-1", submitted_lines: submitted, fulfilments: [inStock({ status: "dispatched" }), waiting()], fulfillable_status: "fulfillable", status: "processing" }],
    })
    expect(decision).toEqual({ action: "wait" })
  })

  // Print Trail releases back-order → draft and re-queues a pure order (the
  // mock collapses the draft step): pinned here.
  it("a released fulfilment back in draft on a re-queued order is no attention", () => {
    const before = pt({ status: "back-order", confirmedAt: "2026-10-19T10:00:00Z", fulfilments: [waiting()] })
    const after = pt({ status: "queued", confirmedAt: "2026-10-19T10:00:00Z", fulfilments: [waiting({ status: "draft", backOrderReason: null })] })
    expect(ptBackToDraft(after)).toBe(false)
    expect(remoteAttention(confirmed, after)).toBeNull()
    expect(diffRemote(snap(before), after)).toContainEqual(
      expect.objectContaining({ kind: "fulfilment-status", from: "back-order", to: "draft", released: true })
    )
  })

  // A waiting fulfilment reaches holding only through
  // a release (back to draft, then a failed warehouse send or validation),
  // so it was released; the hold is still attention.
  it("a waiting fulfilment that becomes holding was released, and is held", () => {
    const before = pt({ fulfilments: [waiting()] })
    const after = pt({ status: "processing", fulfilments: [waiting({ status: "holding", backOrderReason: null })] })
    const [change] = diffRemote(snap(before), after).filter((c) => c.kind === "fulfilment-status")
    expect(change).toMatchObject({ from: "back-order", to: "holding", released: true })
    expect(remoteAttention(confirmed, after)).toBe("pt-fulfilment-holding")
  })

  it.each(["cancelled", "invalid", "error", "failed"])("a waiting fulfilment that becomes %s isn't 'released'", (to) => {
    const before = pt({ fulfilments: [waiting()] })
    const after = pt({ fulfilments: [waiting({ status: to, backOrderReason: null })] })
    const [change] = diffRemote(snap(before), after).filter((c) => c.kind === "fulfilment-status")
    expect(change).toMatchObject({ from: "back-order", to })
    expect(change).not.toHaveProperty("released")
  })

  it("a mixed order ships its in-stock parcel", () => {
    const order: DispatchOrder = {
      id: "order_1",
      status: "pending",
      canceled_at: null,
      items: [
        { id: "item_a", quantity: 2, fulfilled_quantity: 0, shipping_profile_id: "sp_pt" },
        { id: "item_b", quantity: 1, fulfilled_quantity: 0, shipping_profile_id: "sp_pt" },
      ],
      fulfillments: [],
      ptOptionIdByProfile: { sp_pt: "so_pt" },
    }
    const plan = planDispatch(pt({ status: "processing", fulfilments: [inStock({ status: "dispatched", trackingDetails: [track("T1")] }), waiting()] }), order, { id: "ptord_1", order_id: "order_1" })
    expect(plan.create.map((c) => c.ptFulfilmentUuid)).toEqual(["f-s"])
  })
})
