// Cancels everything a run placed: each Medusa order (which cancels at Print
// Trail through the plugin), then any Print Trail order still open, directly.
// Every order and Print Trail order is handled on its own, so one failure
// never stops the rest; anything left open is a failure.
import type { PtOrder } from "../../../src/modules/printTrail/client/types"
import type { RunState } from "./run-state"

export type StoreSide = {
  order(id: string): Promise<any>
  cancelOrder(id: string): Promise<unknown>
  ptView(id: string): Promise<any>
  // Orders carrying the run's marker (placed, but perhaps never recorded).
  findRunOrders(runId: string, since: string): Promise<{ id: string; displayId: number | null }[]>
}

export type PtSide = {
  order(uuid: string): Promise<PtOrder>
  cancel(uuid: string): Promise<{ status: number }>
  // Mock mode: finish an accepted (202) cancel, as Print Trail would later.
  settle?(uuid: string): Promise<void>
}

export type CleanupResult = {
  orders: number
  settled: number
  leftShipped: number
  failed: number
  notes: string[]
}

export type CleanupOptions = {
  // How long to wait for the plugin's own cancel, and for a 202 to settle.
  waitMs?: number
  pollMs?: number
  sleep?: (ms: number) => Promise<void>
  describeError?: (e: unknown) => string
}

const FINAL = new Set(["cancelled", "complete", "partial"])
const DONE_FULFILMENT = new Set(["dispatched", "cancelled", "failed"])

export async function cleanupRun(
  state: RunState,
  store: StoreSide | null,
  pt: PtSide | null,
  opts: CleanupOptions = {}
): Promise<CleanupResult> {
  const waitMs = opts.waitMs ?? 90_000
  const pollMs = opts.pollMs ?? 3000
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)))
  const why = opts.describeError ?? ((e: unknown) => (e as Error)?.message ?? String(e))
  const result: CleanupResult = { orders: 0, settled: 0, leftShipped: 0, failed: 0, notes: [] }

  // Poll until fn is true or the wait runs out.
  const until = async (fn: () => Promise<boolean>) => {
    const deadline = Date.now() + waitMs
    for (;;) {
      if (await fn()) return true
      if (Date.now() >= deadline) return false
      await sleep(pollMs)
    }
  }

  const search = async () => {
    if (!store) return
    try {
      for (const o of await store.findRunOrders(state.data.runId, state.data.startedAt)) {
        if (!state.data.orders[o.id]) result.notes.push(`order #${o.displayId ?? o.id}: found by the run marker`)
        state.addOrder(o.id, o.displayId)
      }
    } catch (e) {
      result.failed++
      result.notes.push(`couldn't search the store for this run's orders: ${why(e)}`)
    }
  }
  if (!store) result.notes.push("the store isn't reachable: cancelling at Print Trail only")

  // Twice: an order placed while the first pass ran is found by the second.
  const handled = new Set<string>()
  for (let pass = 0; pass < 2; pass++) {
    await search()
    for (const orderId of state.orderIds) {
      if (handled.has(orderId)) continue
      handled.add(orderId)
      await cleanOne(orderId)
    }
    if (!store) break
  }
  return result

  async function cleanOne(orderId: string) {
    result.orders++
    const label = `order #${state.data.orders[orderId].displayId ?? orderId}`
    let ok = true
    const problem = (note: string) => {
      ok = false
      result.notes.push(`${label}: ${note}`)
    }
    let rows: any[] = []

    if (!store) problem("the Medusa order couldn't be cancelled (the store is down): cancel it there later")
    if (store) {
      try {
        const order = await store.order(orderId)
        let cancelledNow = false
        if (!order.canceled_at && order.status !== "canceled") {
          try {
            await store.cancelOrder(orderId)
            cancelledNow = true
          } catch (e) {
            // Expected once an order has fulfilments; the Print Trail side is still checked below.
            result.notes.push(`${label}: Medusa refused the cancel (${why(e)})`)
          }
        }
        // After a cancel the plugin records one on every sent row (null until
        // its subscriber runs): a direct cancel before then would race it.
        const recorded = (r: any) => !cancelledNow || !r.pt_uuid || r.cancel_status != null
        const settled = await until(async () => {
          rows = (await store.ptView(orderId)).rows ?? []
          return rows.every((r) => r.cancel_status !== "requested" && recorded(r))
        })
        for (const r of rows) state.addPtUuid(orderId, r.pt_uuid)
        if (!settled && rows.some((r) => r.cancel_status === "requested")) problem("the plugin's cancel is still requested")
        else if (!settled) problem("the plugin recorded no cancel after Medusa's: not cancelling at Print Trail directly")
      } catch (e) {
        problem(`couldn't read or cancel it in Medusa: ${why(e)}`)
      }
    }

    if (!pt) {
      if (ok) result.settled++
      else result.failed++
      return
    }

    // The plugin's cancel is unaccounted for: don't race it at Print Trail.
    if (store && !ok) {
      result.failed++
      return
    }
    for (const uuid of state.data.orders[orderId].ptUuids) {
      try {
        const row = rows.find((r) => r.pt_uuid === uuid)
        let current = await pt.order(uuid)
        const shipped = (current.fulfilments ?? []).some((f) => f.status === "dispatched")
        if (shipped) {
          result.leftShipped++
          for (const [i, f] of (current.fulfilments ?? []).entries()) {
            if (!DONE_FULFILMENT.has(f.status)) result.notes.push(`${label}: Print Trail fulfilment ${i + 1} left ${f.status}`)
          }
          continue
        }
        if (FINAL.has(current.status)) continue
        if (row?.cancel_status === "requested") {
          problem(`not cancelling ${current.orderNumber ?? uuid} directly: the plugin's cancel is still requested`)
          continue
        }
        if (row?.cancel_status !== "awaiting") {
          // Nobody has asked Print Trail yet (or Medusa refused): cancel there.
          const res = await pt.cancel(uuid)
          if (res.status === 200) continue
          result.notes.push(`${label}: Print Trail accepted the cancel of ${current.orderNumber ?? uuid} (202)`)
        }
        await pt.settle?.(uuid)
        const done = await until(async () => {
          current = await pt.order(uuid)
          return current.status === "cancelled"
        })
        if (!done) problem(`Print Trail order ${current.orderNumber ?? uuid} is still ${current.status}`)
      } catch (e) {
        problem(`Print Trail order ${uuid}: ${why(e)}`)
      }
    }
    if (ok) result.settled++
    else result.failed++
  }
}
