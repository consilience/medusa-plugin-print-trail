import { InMemoryLockingProvider } from "@medusajs/locking/dist/providers/in-memory"
import { startMockPrintTrail, type MockPrintTrail } from "../../../dev/mock-print-trail"
import { resolvePluginOptions } from "../../config"
import { PrintTrailClient } from "../../modules/printTrail/client/client"
import type { PtOrder } from "../../modules/printTrail/client/types"
import {
  advanceCursor,
  clearReconcileFailure,
  initialCursor,
  RECONCILE_CURSOR_KEY,
  RECONCILE_FAILURES_KEY,
  runReconcile,
  withHeldLock,
  type ReconcileCursor,
  type ReconcileDeps,
} from "../reconcile"
import type { PrintTrailOrderRow } from "../send-flow"
import type { MatchRow } from "../sync-decisions"
import { refetch, type MedusaOrderPort, type SyncStore } from "../sync-flow"
import type { StateStore } from "../team-code"

const NOW = new Date("2026-10-19T12:00:00Z")

class MemoryState implements StateStore {
  values = new Map<string, unknown>()
  async getState<T>(key: string) {
    return (this.values.get(key) as T | undefined) ?? null
  }
  async setState(key: string, value: unknown) {
    this.values.set(key, JSON.parse(JSON.stringify(value)))
  }
  cursor() {
    return this.values.get(RECONCILE_CURSOR_KEY) as ReconcileCursor | undefined
  }
}

let mock: MockPrintTrail
let client: PrintTrailClient
let state: MemoryState
let rows: MatchRow[]
let synced: { row: MatchRow; pt: PtOrder; hint?: string; listedAt?: Date }[]
let copies: { row: MatchRow; pt: PtOrder }[]
let flagged: { row: MatchRow; detail: string }[]
let errors: string[]
let deps: ReconcileDeps

beforeEach(async () => {
  mock = await startMockPrintTrail({ token: "t", channelId: "acme-medusa1", skus: { "978-A": 10 } })
  client = new PrintTrailClient({ baseUrl: mock.url, channelId: "acme-medusa1", apiToken: "t", retryDelays: [0] })
  state = new MemoryState()
  rows = []
  synced = []
  copies = []
  flagged = []
  errors = []
  const quiet = () => {}
  deps = {
    client,
    state,
    find: {
      byUuid: async (u) => rows.find((r) => r.pt_uuid === u) ?? null,
      byNumber: async (n) => rows.filter((r) => r.pt_order_number === n),
    },
    sync: async (row, pt, hint, listedAt) => void synced.push({ row, pt, hint, listedAt }),
    copySeen: async (row, pt) => void copies.push({ row, pt }),
    flag: async (row, _pt, detail) => void flagged.push({ row, detail }),
    logger: { info: quiet, warn: quiet, debug: quiet, error: (m: string) => void errors.push(m) },
    now: () => NOW,
    lookbackDays: 7,
  }
})

afterEach(() => mock.close())

// 45 known orders with distinct updatedAt seconds, in order.
async function seed(n = 45) {
  for (let i = 0; i < n; i++) {
    const number = `ORD-${1000 + i}`
    const o = await client.createOrder({ orderNumber: number, orderLines: [{ quantity: 1, lineNumber: "a", product: { sku: "978-A" } }] })
    mock.setUpdatedAt(o.uuid, new Date(Date.UTC(2026, 9, 19, 10, 0, i)).toISOString().replace(".000Z", "Z"))
    rows.push({ id: `ptord_${i}`, order_id: `order_${i}`, pt_uuid: o.uuid, pt_order_number: number })
  }
  return rows.map((r) => r.pt_uuid!)
}

const at = (i: number) => new Date(Date.UTC(2026, 9, 19, 10, 0, i)).toISOString().replace(".000Z", "Z")
const listCalls = () => mock.state.requests.filter((r) => r.method === "GET" && r.path.includes("/orders?"))

describe("cursor", () => {
  it("starts lookbackDays back", () => {
    expect(initialCursor(NOW, 7)).toBe("2026-10-12T12:00:00Z")
  })

  it("never goes backwards; a failure holds it at the failed order", () => {
    expect(advanceCursor("2026-10-19T10:00:05Z", [{ updatedAt: "2026-10-19T10:00:09Z" }, { updatedAt: null }], null)).toBe(
      "2026-10-19T10:00:09Z"
    )
    expect(advanceCursor("2026-10-19T10:00:05Z", [{ updatedAt: "2026-10-19T10:00:01Z" }], null)).toBe("2026-10-19T10:00:05Z")
    expect(advanceCursor("2026-10-19T10:00:05Z", [], null)).toBe("2026-10-19T10:00:05Z")
    expect(
      advanceCursor("2026-10-19T10:00:05Z", [{ updatedAt: "2026-10-19T10:00:09Z" }], "2026-10-19T10:00:07Z")
    ).toBe("2026-10-19T10:00:07Z")
  })
})

describe("runReconcile", () => {
  it("walks every page and stores the greatest updatedAt", async () => {
    await seed()
    const result = await runReconcile(deps)
    expect(result).toMatchObject({ pages: 3, synced: 45, ignored: 0, failed: 0, completed: true, cursor: at(44) })
    expect(state.cursor()).toEqual({ updatedSince: at(44), lastCompletedAt: NOW.toISOString() })
    expect(synced[0].pt.uuid).toBe(rows[0].pt_uuid)
    expect(synced[0].listedAt).toEqual(NOW)
  })

  it("stops at once when access is refused mid-run, holding the cursor", async () => {
    await seed(5)
    let refused = false
    deps.sync = async (row, pt) => {
      synced.push({ row, pt })
      // The first order's sync hears a 401.
      refused = true
    }
    deps.halt = async () => refused
    const result = await runReconcile(deps)
    expect(synced).toHaveLength(1)
    expect(result).toMatchObject({ synced: 1, completed: false })
    expect(result.cursor).toBe(at(0))
  })

  it("starts lookbackDays back on the first run", async () => {
    await runReconcile(deps)
    expect(listCalls()[0].path).toContain(`updated-since=${encodeURIComponent("2026-10-12T12:00:00Z")}`)
    await state.setState(RECONCILE_CURSOR_KEY, { updatedSince: "2026-10-19T10:00:00Z" })
    await runReconcile(deps)
    expect(listCalls()[1].path).toContain(`updated-since=${encodeURIComponent("2026-10-19T10:00:00Z")}`)
  })

  it("never loses an order updated during the walk", async () => {
    const uuids = await seed()
    let moved = false
    deps.sync = async (row, pt) => {
      synced.push({ row, pt })
      if (!moved) {
        moved = true
        mock.setUpdatedAt(uuids[30], "2026-10-19T11:00:00Z")
      }
    }
    const result = await runReconcile(deps)
    expect(new Set(synced.map((s) => s.pt.uuid)).size).toBe(45)
    expect(synced.filter((s) => s.pt.uuid === uuids[30])).toHaveLength(1)
    expect(synced.find((s) => s.pt.uuid === uuids[30])!.pt.updatedAt).toBe("2026-10-19T11:00:00Z")
    expect(result.cursor).toBe("2026-10-19T11:00:00Z")
  })

  it("syncs each order once per run even when it reappears", async () => {
    const uuids = await seed()
    deps.sync = async (row, pt) => {
      synced.push({ row, pt })
      // Changed at Print Trail after we applied it: it reappears at the end.
      if (pt.uuid === uuids[0]) mock.setUpdatedAt(uuids[0], "2026-10-19T11:00:00Z")
    }
    const result = await runReconcile(deps)
    expect(synced.filter((s) => s.pt.uuid === uuids[0])).toHaveLength(1)
    // The newer state wasn't applied: the cursor stays at or before it, so the
    // next run reads it again.
    expect(result.cursor).toBe(at(44))
    synced = []
    await runReconcile(deps)
    expect(synced.map((s) => s.pt.uuid)).toContain(uuids[0])
  })

  it("keeps the cursor at a failed order so it is read again", async () => {
    const uuids = await seed()
    deps.sync = async (row, pt) => {
      if (pt.uuid === uuids[5]) throw new Error("lock timeout")
      synced.push({ row, pt })
    }
    const result = await runReconcile(deps)
    // The walk carries on, so one stuck order can't stall reconcile.
    expect(result).toMatchObject({ pages: 3, synced: 44, failed: 1, completed: false, cursor: at(5) })
    expect(state.cursor()).toEqual({ updatedSince: at(5) })
  })

  it("stops on a Print Trail error and keeps the progress made", async () => {
    await seed()
    let calls = 0
    const pages = client.ordersUpdatedSincePages.bind(client)
    deps.client = {
      async *ordersUpdatedSincePages(since: string) {
        for await (const page of pages(since)) {
          yield page
          if (++calls === 1) mock.fail(/\/orders$/, 503, undefined, 9)
        }
      },
    }
    const result = await runReconcile(deps)
    expect(result).toMatchObject({ pages: 1, synced: 20, completed: false, cursor: at(19) })
    expect(state.cursor()).toEqual({ updatedSince: at(19) })
  })

  it("sends copies to copySeen and ignores unknown orders", async () => {
    const uuids = await seed(2)
    const copy = mock.copy(uuids[0])
    mock.setUpdatedAt(copy, at(10))
    const stranger = await client.createOrder({ orderNumber: "OTHER-1", orderLines: [{ quantity: 1, lineNumber: "a", product: { sku: "978-A" } }] })
    mock.setUpdatedAt(stranger.uuid, at(11))
    rows.push({ id: "ptord_x", order_id: "order_x", pt_uuid: null, pt_order_number: "ORD-2000" })
    const own = await client.createOrder({ orderNumber: "ORD-2000", orderLines: [{ quantity: 1, lineNumber: "a", product: { sku: "978-A" } }] })
    mock.setUpdatedAt(own.uuid, at(12))
    const result = await runReconcile(deps)
    // Two seeded, our own order (adopted) and the copy.
    expect(result).toMatchObject({ synced: 4, ignored: 1 })
    expect(copies.map((c) => c.pt.uuid)).toEqual([copy])
    expect(synced.find((s) => s.row.id === "ptord_x")?.hint).toBe(own.uuid)
  })

  it("flags draft after confirm found by the poll", async () => {
    const o = await client.createOrder({ orderNumber: "ORD-1001", orderLines: [{ quantity: 1, lineNumber: "a", product: { sku: "978-A" } }] })
    const confirmed = await client.confirmOrder(o.uuid, { defaultShippingMethod: "standard" })
    const row: PrintTrailOrderRow = {
      id: "ptord_1",
      order_id: "order_1",
      sequence: 1,
      pt_order_number: "ORD-1001",
      pt_uuid: o.uuid,
      confirmed_at: NOW,
      status: confirmed.status,
      fulfillable_status: confirmed.fulfillableStatus,
      fulfilments: confirmed.fulfilments,
      errors: [],
      attention: null,
      attempts: {},
    }
    rows.push(row as MatchRow)
    const store: SyncStore = {
      listPrintTrailOrders: async (f) => (f.id === row.id || f.order_id === row.order_id ? [{ ...row }] : []),
      updatePrintTrailOrders: async (d) => Object.assign(row, d),
      createPrintTrailOrderEvents: async () => [],
      listPrintTrailOrderEvents: async () => [],
      markPreOrderSeen: async () => {},
    }
    const port = { loadDispatchOrder: async () => null } as unknown as MedusaOrderPort
    const ctx = { store, client, options: resolvePluginOptions({}), medusa: port, teamCode: "acme", now: () => NOW }
    deps.sync = async (r, pt, hint) => {
      await refetch(ctx, { rowId: r.id, source: "reconcile", pt, ptUuidHint: hint })
    }
    mock.fullEdit(o.uuid)
    await runReconcile(deps)
    expect(row.attention).toBe("pt-draft-after-confirm")
    expect(mock.state.requests.filter((r) => r.path.endsWith(`/orders/${o.uuid}`))).toHaveLength(0)
  })
})

describe("withHeldLock", () => {
  it("holds the lock for its ttl, not one second, and skips while held", async () => {
    const locking = new InMemoryLockingProvider()
    let inner: unknown
    const outer = await withHeldLock(locking, "print-trail:reconcile", 600, async () => {
      await new Promise((r) => setTimeout(r, 1200))
      inner = await withHeldLock(locking, "print-trail:reconcile", 600, async () => "second")
      return "first"
    })
    expect(outer).toEqual({ ran: true, result: "first" })
    expect(inner).toEqual({ ran: false })
    expect(await withHeldLock(locking, "print-trail:reconcile", 600, async () => "again")).toEqual({
      ran: true,
      result: "again",
    })
  })
})

describe("reconcile hardening", () => {
  it("carries on when looking one order up fails", async () => {
    const uuids = await seed()
    const byUuid = deps.find.byUuid
    deps.find = {
      ...deps.find,
      byUuid: async (u) => {
        if (u === uuids[7]) throw new Error("connection reset")
        return byUuid(u)
      },
    }
    const result = await runReconcile(deps)
    expect(result).toMatchObject({ synced: 44, failed: 1, cursor: at(7) })
  })

  it("takes listedAt before requesting the page", async () => {
    await seed(3)
    let clock = 0
    deps.now = () => new Date(NOW.getTime() + clock * 1000)
    const pages = client.ordersUpdatedSincePages.bind(client)
    deps.client = {
      async *ordersUpdatedSincePages(since: string) {
        for await (const page of pages(since)) {
          clock++ // the request took a second
          yield page
        }
      },
    }
    await runReconcile(deps)
    expect(synced[0].listedAt).toEqual(NOW)
  })

  it("skips an order that has failed three runs running, and flags it", async () => {
    const uuids = await seed()
    deps.sync = async (row, pt) => {
      if (pt.uuid === uuids[5]) throw new Error("no stock location")
      synced.push({ row, pt })
    }
    for (let run = 1; run <= 2; run++) {
      const r = await runReconcile(deps)
      expect(r.cursor).toBe(at(5))
      expect(flagged).toEqual([])
    }
    const third = await runReconcile(deps)
    expect(third.cursor).toBe(at(44))
    expect(flagged).toEqual([{ row: rows[5], detail: "no stock location" }])
    // The skip is kept, keyed by the updatedAt it failed at.
    expect(state.values.get(RECONCILE_FAILURES_KEY)).toEqual({
      [uuids[5]]: expect.objectContaining({ updatedAt: at(5), runs: 3, skipped: true }),
    })
    // Recovered later: its count is dropped.
    deps.sync = async (row, pt) => void synced.push({ row, pt })
    mock.setUpdatedAt(uuids[5], "2026-10-19T11:00:00Z")
    await runReconcile(deps)
    expect(state.values.get(RECONCILE_FAILURES_KEY)).toEqual({})
  })

  it("logs a poison order it can't match at error level", async () => {
    const uuids = await seed(3)
    const byUuid = deps.find.byUuid
    deps.find = {
      ...deps.find,
      byUuid: async (u) => {
        if (u === uuids[1]) throw new Error("connection reset")
        return byUuid(u)
      },
    }
    for (let run = 0; run < 3; run++) await runReconcile(deps)
    expect(flagged).toEqual([])
    expect(errors).toEqual([expect.stringContaining(uuids[1])])
  })
})

describe("poison accounting", () => {
  it("treats most orders failing as a systemic fault and skips nothing", async () => {
    await seed(10)
    deps.sync = async () => {
      throw new Error("database is down")
    }
    for (let run = 0; run < 4; run++) {
      const r = await runReconcile(deps)
      expect(r).toMatchObject({ skipped: 0, failed: 10, cursor: "2026-10-12T12:00:00Z", completed: false })
      expect(state.values.get(RECONCILE_FAILURES_KEY) ?? {}).toEqual({})
    }
    expect(flagged).toEqual([])
    expect(state.values.get(RECONCILE_FAILURES_KEY) ?? {}).toEqual({})
    expect(errors.some((m) => m.includes("systemic"))).toBe(true)
  })

  it("starts the count again when the order has changed since it last failed", async () => {
    const uuids = await seed(10)
    deps.sync = async (row, pt) => {
      if (pt.uuid === uuids[4]) throw new Error("no stock location")
      synced.push({ row, pt })
    }
    await runReconcile(deps)
    await runReconcile(deps)
    mock.setUpdatedAt(uuids[4], at(30))
    const third = await runReconcile(deps)
    expect(third.skipped).toBe(0)
    expect(flagged).toEqual([])
    expect((state.values.get(RECONCILE_FAILURES_KEY) as Record<string, { runs: number }>)[uuids[4]].runs).toBe(1)
  })
})

describe("poison records keyed by updatedAt", () => {
  const poison = (bad: string[]) => {
    deps.sync = async (row, pt) => {
      if (bad.includes(pt.uuid)) throw new Error("no stock location")
      synced.push({ row, pt })
    }
  }
  const records = () => (state.values.get(RECONCILE_FAILURES_KEY) ?? {}) as Record<string, any>

  it("skips the newest poison order once and never re-flags or re-counts it while unchanged", async () => {
    const uuids = await seed(5)
    poison([uuids[4]])
    for (let run = 0; run < 3; run++) await runReconcile(deps)
    expect(flagged).toHaveLength(1)
    const after = await runReconcile(deps)
    const again = await runReconcile(deps)
    expect(after).toMatchObject({ skipped: 0, failed: 0, cursor: at(4) })
    expect(again).toMatchObject({ skipped: 0, failed: 0, cursor: at(4) })
    expect(flagged).toHaveLength(1)
    expect(records()[uuids[4]]).toMatchObject({ runs: 3, skipped: true, updatedAt: at(4) })
  })

  it("skips both poison orders of three after three runs", async () => {
    const uuids = await seed(3)
    poison([uuids[0], uuids[2]])
    await runReconcile(deps)
    await runReconcile(deps)
    const third = await runReconcile(deps)
    expect(third).toMatchObject({ skipped: 2, cursor: at(2) })
    expect(flagged.map((f) => f.row.pt_uuid).sort()).toEqual([uuids[0], uuids[2]].sort())
  })

  it("counts nothing when the only order fails through an outage", async () => {
    const uuids = await seed(1)
    poison([uuids[0]])
    for (let run = 0; run < 3; run++) {
      const r = await runReconcile(deps)
      expect(r).toMatchObject({ skipped: 0, failed: 1, cursor: "2026-10-12T12:00:00Z" })
    }
    expect(records()[uuids[0]]?.runs ?? 0).toBe(0)
    expect(records()[uuids[0]]?.skipped).toBeFalsy()
  })

  it("flags a poison order alone in its window and holds the cursor", async () => {
    const uuids = await seed(1)
    poison([uuids[0]])
    for (let run = 0; run < 4; run++) await runReconcile(deps)
    expect(flagged).toEqual([{ row: rows[0], detail: "no stock location" }])
    expect(state.cursor()?.updatedSince).toBe("2026-10-12T12:00:00Z")
  })

  it("retries a skipped order once it changes, and clears its record on success", async () => {
    const uuids = await seed(3)
    poison([uuids[1]])
    for (let run = 0; run < 3; run++) await runReconcile(deps)
    expect(records()[uuids[1]]).toMatchObject({ skipped: true })
    poison([])
    mock.setUpdatedAt(uuids[1], at(30))
    synced = []
    await runReconcile(deps)
    expect(synced.map((x) => x.pt.uuid)).toContain(uuids[1])
    expect(records()[uuids[1]]).toBeUndefined()
  })

  it("prunes records older than the lookback window", async () => {
    await seed(2)
    await state.setState(RECONCILE_FAILURES_KEY, {
      gone: { updatedAt: "2026-09-01T00:00:00Z", runs: 3, skipped: true, error: "x" },
    })
    await runReconcile(deps)
    expect(records()).toEqual({})
  })
})

describe("clearReconcileFailure", () => {
  it("drops the record of an order that synced through another path", async () => {
    await state.setState(RECONCILE_FAILURES_KEY, { u1: { updatedAt: at(1), runs: 3, skipped: true, error: "x" }, u2: { updatedAt: at(1), runs: 1, error: "y" } })
    await clearReconcileFailure(state, "u1")
    expect(state.values.get(RECONCILE_FAILURES_KEY)).toEqual({ u2: { updatedAt: at(1), runs: 1, error: "y" } })
  })
})

describe("what counts as a success", () => {
  it("doesn't count unknown orders, so a broken sync skips nothing", async () => {
    const uuids = await seed(2)
    for (let i = 0; i < 3; i++) {
      const o = await client.createOrder({ orderNumber: `OTHER-${i}`, orderLines: [{ quantity: 1, lineNumber: "a", product: { sku: "978-A" } }] })
      mock.setUpdatedAt(o.uuid, at(10 + i))
    }
    deps.sync = async () => {
      throw new Error("database is down")
    }
    for (let run = 0; run < 3; run++) {
      const r = await runReconcile(deps)
      expect(r).toMatchObject({ skipped: 0, failed: 2, ignored: 3 })
    }
    expect(flagged).toEqual([])
    expect((state.values.get(RECONCILE_FAILURES_KEY) ?? {}) as Record<string, unknown>).not.toHaveProperty(uuids[0])
  })
})

