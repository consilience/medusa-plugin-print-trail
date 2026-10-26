import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { cleanupRun, type PtSide, type StoreSide } from "../lib/cleanup"
import { RunState } from "../lib/run-state"

const newState = () =>
  RunState.create(mkdtempSync(join(tmpdir(), "ck-")), {
    runId: "ckt",
    mode: "staging",
    store: "https://store.example.com",
    printTrail: "https://printtrail-core.consilstaging.com",
    startedAt: "2026-10-19T00:00:00Z",
  })

type Order = { canceled: boolean; rows: any[]; refuse?: boolean }
function fakes(orders: Record<string, Order>, pt: Record<string, any>, opts: { found?: { id: string; displayId: number }[]; cancel202?: Set<string>; settleOnPoll?: boolean } = {}) {
  const ptCancels: string[] = []
  const store: StoreSide = {
    order: async (id) => {
      if (!orders[id]) throw new Error("404")
      return { id, canceled_at: orders[id].canceled ? "x" : null, status: orders[id].canceled ? "canceled" : "pending" }
    },
    cancelOrder: async (id) => {
      if (orders[id].refuse) throw new Error("400: has fulfilments")
      orders[id].canceled = true
    },
    ptView: async (id) => ({ rows: orders[id].rows }),
    findRunOrders: async () => opts.found ?? [],
  }
  const side: PtSide = {
    order: async (uuid) => {
      if (opts.settleOnPoll && pt[uuid].status === "processing") pt[uuid].status = "cancelled"
      return pt[uuid]
    },
    cancel: async (uuid) => {
      ptCancels.push(uuid)
      if (opts.cancel202?.has(uuid)) {
        pt[uuid].status = "processing"
        return { status: 202 }
      }
      pt[uuid].status = "cancelled"
      return { status: 200 }
    },
  }
  return { store, side, ptCancels }
}

const fast = { waitMs: 30, pollMs: 1, sleep: async () => undefined }

describe("checklist cleanup", () => {
  it("cancels in Medusa, and directly at Print Trail when Medusa refused", async () => {
    const state = newState()
    state.addOrder("o1", 1)
    state.addOrder("o2", 2)
    const { store, side, ptCancels } = fakes(
      {
        o1: { canceled: false, rows: [{ pt_uuid: "u1", cancel_status: "cancelled" }] },
        o2: { canceled: false, refuse: true, rows: [{ pt_uuid: "u2", cancel_status: null }] },
      },
      { u1: { status: "cancelled", fulfilments: [] }, u2: { status: "queued", fulfilments: [] } }
    )
    const r = await cleanupRun(state, store, side, fast)
    expect(r).toMatchObject({ orders: 2, settled: 2, failed: 0 })
    expect(ptCancels).toEqual(["u2"])
    expect(r.notes.join("\n")).toMatch(/order #2: Medusa refused the cancel/)
  })

  it("merges orders found by the run marker and records Print Trail uuids", async () => {
    const state = newState()
    const { store, side } = fakes({ o9: { canceled: false, rows: [{ pt_uuid: "u9", cancel_status: "cancelled" }] } }, { u9: { status: "cancelled" } }, { found: [{ id: "o9", displayId: 9 }] })
    const r = await cleanupRun(state, store, side, fast)
    expect(r.orders).toBe(1)
    expect(JSON.parse(readFileSync(state.file, "utf8")).orders.o9.ptUuids).toEqual(["u9"])
  })

  it("never cancels directly while the plugin's cancel is still requested", async () => {
    const state = newState()
    state.addOrder("o1", 1)
    const { store, side, ptCancels } = fakes({ o1: { canceled: true, rows: [{ pt_uuid: "u1", cancel_status: "requested" }] } }, { u1: { status: "queued" } })
    const r = await cleanupRun(state, store, side, fast)
    expect(ptCancels).toEqual([])
    expect(r.failed).toBe(1)
  })

  it("waits for a 202 cancel to settle, and fails one that doesn't", async () => {
    const settles = newState()
    settles.addPtUuid("o1", "u1")
    const a = fakes({ o1: { canceled: true, rows: [{ pt_uuid: "u1", cancel_status: "awaiting" }] } }, { u1: { status: "processing" } }, { settleOnPoll: true })
    expect((await cleanupRun(settles, a.store, a.side, fast)).failed).toBe(0)

    const stuck = newState()
    stuck.addPtUuid("o1", "u1")
    const b = fakes({ o1: { canceled: true, rows: [{ pt_uuid: "u1", cancel_status: null }] } }, { u1: { status: "queued" } }, { cancel202: new Set(["u1"]) })
    const r = await cleanupRun(stuck, b.store, b.side, fast)
    expect(r.failed).toBe(1)
    expect(r.notes.join("\n")).toMatch(/still processing/)
  })

  it("leaves dispatched orders and reports live fulfilments; one failure doesn't stop the rest", async () => {
    const state = newState()
    state.addOrder("bad", 1)
    state.addPtUuid("o2", "u2")
    const { store, side } = fakes(
      { o2: { canceled: false, refuse: true, rows: [{ pt_uuid: "u2" }] } },
      { u2: { status: "partial", fulfilments: [{ status: "dispatched" }, { status: "back-order" }] } }
    )
    const r = await cleanupRun(state, store, side, fast)
    expect(r).toMatchObject({ orders: 2, failed: 1, settled: 1, leftShipped: 1 })
    expect(r.notes.join("\n")).toMatch(/fulfilment 2 left back-order/)
  })

  it("cancels at Print Trail alone when the store is down", async () => {
    const state = newState()
    state.addPtUuid("o1", "u1")
    const { side, ptCancels } = fakes({}, { u1: { status: "queued" } })
    const r = await cleanupRun(state, null, side, fast)
    expect(ptCancels).toEqual(["u1"])
    // The Medusa order itself is still open: not settled.
    expect(r).toMatchObject({ settled: 0, failed: 1 })
    expect(r.notes.join("\n")).toMatch(/store is down/)
  })

  it("waits for the plugin to record its cancel before cancelling directly", async () => {
    const state = newState()
    state.addPtUuid("o1", "u1")
    const orders = { o1: { canceled: false, rows: [{ pt_uuid: "u1", cancel_status: null as string | null }] } }
    const pt = { u1: { status: "queued" } as any }
    const { store, side, ptCancels } = fakes(orders, pt)
    let polls = 0
    const view = store.ptView
    store.ptView = async (id) => {
      // The subscriber lands on the third look, and cancels at Print Trail.
      if (++polls === 3) {
        orders.o1.rows[0].cancel_status = "cancelled"
        pt.u1.status = "cancelled"
      }
      return view(id)
    }
    const r = await cleanupRun(state, store, side, { ...fast, waitMs: 1000 })
    expect(ptCancels).toEqual([])
    expect(r).toMatchObject({ settled: 1, failed: 0 })
  })

  it("doesn't cancel directly when the plugin never records its cancel", async () => {
    const state = newState()
    state.addPtUuid("o1", "u1")
    const { store, side, ptCancels } = fakes({ o1: { canceled: false, rows: [{ pt_uuid: "u1", cancel_status: null }] } }, { u1: { status: "queued" } })
    const r = await cleanupRun(state, store, side, fast)
    expect(ptCancels).toEqual([])
    expect(r.failed).toBe(1)
    expect(r.notes.join("\n")).toMatch(/recorded no cancel/)
  })

  it("fails a cancel still requested on a row with nothing sent", async () => {
    const state = newState()
    state.addOrder("o1", 1)
    const { store, side } = fakes({ o1: { canceled: true, rows: [{ pt_uuid: null, cancel_status: "requested" }] } }, {})
    const r = await cleanupRun(state, store, side, fast)
    expect(r.failed).toBe(1)
    expect(r.notes.join("\n")).toMatch(/still requested/)
  })

  it("finds an order placed while the cleanup ran", async () => {
    const state = newState()
    const { store, side } = fakes({ o7: { canceled: true, rows: [] } }, {})
    let calls = 0
    store.findRunOrders = async () => (++calls === 2 ? [{ id: "o7", displayId: 7 }] : [])
    const r = await cleanupRun(state, store, side, fast)
    expect(r.orders).toBe(1)
  })
})
