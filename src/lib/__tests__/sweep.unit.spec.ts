import { runSweepSteps } from "../sweep-steps"
import { dueCancels, dueRows, findOrdersMissingRows, ordersMissingCancel, sweepWindow, withinLookback } from "../sweep"

const NOW = new Date("2026-10-18T12:00:00Z")
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000)

describe("sweepWindow", () => {
  it("spans lookbackDays ago to 5 minutes ago", () => {
    expect(sweepWindow(NOW, 7)).toEqual({
      from: new Date("2026-10-11T12:00:00Z"),
      to: new Date("2026-10-18T11:55:00Z"),
    })
  })
})

describe("findOrdersMissingRows", () => {
  const order = (id: string, minutesAgo: number, over: object = {}) => ({
    id,
    created_at: ago(minutesAgo),
    canceled_at: null,
    hasPrintTrailMethod: true,
    ...over,
  })

  it("finds Print Trail orders in the window that have no row", () => {
    const orders = [
      order("too-new", 4),
      order("missing", 10),
      order("has-row", 10),
      order("cancelled", 10, { canceled_at: ago(1) }),
      order("manual", 10, { hasPrintTrailMethod: false }),
      order("too-old", 8 * 24 * 60),
    ]
    expect(findOrdersMissingRows(orders, new Set(["has-row"]), NOW, 7)).toEqual(["missing"])
  })
})

describe("dueRows", () => {
  it("returns rows whose retry is due", () => {
    const rows = [
      { id: "due", pending_action: "confirm", next_attempt_at: ago(1) },
      { id: "now", pending_action: "send", next_attempt_at: NOW },
      { id: "later", pending_action: "send", next_attempt_at: ago(-5) },
      { id: "none", pending_action: null, next_attempt_at: ago(1) },
      { id: "unscheduled", pending_action: "send", next_attempt_at: null },
    ]
    expect(dueRows(rows, NOW).map((r) => r.id)).toEqual(["due", "now"])
  })
})

describe("runSweepSteps", () => {
  it("runs the stock and SKU-check queues even when an earlier step throws", async () => {
    const ran: string[] = []
    const errors: string[] = []
    await runSweepSteps(
      {
        dueRetries: async () => {
          ran.push("due")
          throw new Error("boom")
        },
        missedOrders: async () => {
          ran.push("missed")
        },
        pendingStock: async () => {
          ran.push("stock")
        },
        skuChecks: async () => {
          ran.push("sku")
        },
      },
      { error: (m: string) => errors.push(m) }
    )
    expect(ran).toEqual(["due", "missed", "stock", "sku"])
    expect(errors.join("\n")).toMatch(/boom/)
  })
})

describe("cancels in the sweep", () => {
  const now = new Date("2026-10-19T12:00:00Z")

  it("dueCancels picks requested rows whose lease is null or due, once per order", () => {
    expect(
      dueCancels(
        [
          { order_id: "o1", cancel_status: "requested", next_attempt_at: null },
          { order_id: "o1", cancel_status: "requested", next_attempt_at: "2026-10-19T11:00:00Z" },
          { order_id: "o2", cancel_status: "requested", next_attempt_at: "2026-10-19T12:00:00Z" },
          { order_id: "o3", cancel_status: "requested", pending_action: "cancel", next_attempt_at: "2026-10-19T12:15:00Z" },
          { order_id: "o4", cancel_status: "awaiting", next_attempt_at: null },
          // Another flow's lease never holds a cancel back.
          { order_id: "o5", cancel_status: "requested", pending_action: "amend", next_attempt_at: "2026-10-19T12:15:00Z" },
        ],
        now
      )
    ).toEqual(["o1", "o2", "o5"])
  })

  it("ordersMissingCancel finds a cancelled order whose row was never asked to cancel", () => {
    expect(
      ordersMissingCancel(
        [
          { id: "o1", canceled_at: "2026-10-19T10:00:00Z" },
          { id: "o2", canceled_at: "2026-10-19T10:00:00Z" },
          { id: "o3", canceled_at: "2026-10-19T10:00:00Z" },
          { id: "o4", canceled_at: null },
        ],
        [
          { order_id: "o1", cancel_requested: false, pt_uuid: "u1" },
          { order_id: "o2", cancel_requested: true, pt_uuid: "u2" },
          // Never posted: nothing to cancel at Print Trail.
          { order_id: "o3", cancel_requested: false, pt_uuid: null },
          { order_id: "o4", cancel_requested: false, pt_uuid: "u4" },
        ]
      )
    ).toEqual(["o1"])
  })
})

describe("withinLookback", () => {
  it("bounds a capture's first send to the sweep's lookback", () => {
    const now = new Date("2026-10-19T12:00:00Z")
    expect(withinLookback("2026-10-13T12:00:00Z", now, 7)).toBe(true)
    expect(withinLookback("2026-10-12T11:59:59Z", now, 7)).toBe(false)
    expect(withinLookback(null, now, 7)).toBe(false)
  })
})
