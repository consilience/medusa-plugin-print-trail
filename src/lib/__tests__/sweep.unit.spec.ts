import { resolvePluginOptions } from "../../config"
import { STATE_KEYS } from "../stock"
import { runLegacyMetadataScan, type StockContext } from "../stock-flow"
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
        // First, so the refetches it schedules are due for dueRetries.
        confirmedElsewhere: async () => {
          ran.push("confirmed")
        },
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
          throw new Error("sku boom")
        },
        legacyMetadata: async () => {
          ran.push("legacy")
        },
      },
      { error: (m: string) => errors.push(m) }
    )
    expect(ran).toEqual(["confirmed", "due", "missed", "stock", "sku", "legacy"])
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

// With the stock sync off, no full run ever scans: the sweep moves the old
// keys out of variant metadata instead, under the stock lock.
describe("runLegacyMetadataScan", () => {
  const setup = (opts: { stockSync: boolean; scan?: unknown; held?: boolean }) => {
    const values = new Map<string, unknown>(opts.scan ? [[STATE_KEYS.metadataScan, opts.scan]] : [])
    const pages: unknown[] = []
    const lock: { acquired: unknown[]; released: unknown[] } = { acquired: [], released: [] }
    const ctx = {
      state: {
        getState: async (key: string) => values.get(key) ?? null,
        setState: async (key: string, value: unknown) => void values.set(key, value),
      },
      options: resolvePluginOptions({ stockSync: { enabled: opts.stockSync } }),
      now: () => NOW,
      logger: { warn: () => {}, error: () => {} },
      catalogue: {
        listPluginMetadata: async (after: string | null, take: number) => {
          pages.push([after, take])
          return { found: [], lastId: null, read: 0 }
        },
        deleteLegacyKeys: async () => {},
      },
      variants: { adopt: async () => 0 },
    } as unknown as StockContext
    const locking = {
      acquire: async (key: string | string[], o?: unknown) => {
        if (opts.held) throw new Error(`Failed to acquire lock for key "${key}"`)
        lock.acquired.push([key, o])
      },
      release: async (key: string | string[]) => {
        lock.released.push(key)
        return true
      },
    }
    return { ctx, locking, values, pages, lock }
  }

  it("runs the scan only with stock sync off, under the stock lock", async () => {
    const on = setup({ stockSync: true })
    await runLegacyMetadataScan(on.locking, on.ctx)
    expect(on.pages).toEqual([])
    expect(on.lock.acquired).toEqual([])

    const off = setup({ stockSync: false })
    await runLegacyMetadataScan(off.locking, off.ctx)
    expect(off.lock.acquired).toEqual([["print-trail:stock", expect.objectContaining({ expire: 900 })]])
    expect(off.lock.released).toEqual(["print-trail:stock"])
    expect(off.pages).toEqual([[null, 500]])
    expect(off.values.get(STATE_KEYS.metadataScan)).toMatchObject({ version: 2, completedAt: NOW.toISOString() })
  })

  it("does nothing once a version 2 scan has completed", async () => {
    const done = setup({ stockSync: false, scan: { version: 2, after: "v1", completedAt: NOW.toISOString() } })
    await runLegacyMetadataScan(done.locking, done.ctx)
    expect(done.lock.acquired).toEqual([])
    expect(done.pages).toEqual([])
    // A completed 0.2.0 scan isn't enough.
    const old = setup({ stockSync: false, scan: { after: "v1", completedAt: NOW.toISOString() } })
    await runLegacyMetadataScan(old.locking, old.ctx)
    expect(old.pages).toEqual([[null, 500]])
  })

  it("skips it when the lock is held, until the next sweep", async () => {
    const held = setup({ stockSync: false, held: true })
    await runLegacyMetadataScan(held.locking, held.ctx)
    expect(held.pages).toEqual([])
    expect(held.values.get(STATE_KEYS.metadataScan)).toBeUndefined()
  })
})
