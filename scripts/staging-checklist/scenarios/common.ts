// What every scenario gets, and the steps several of them share.
import type { MockPrintTrail } from "../../../dev/mock-print-trail"
import type { PtOrder } from "../../../src/modules/printTrail/client/types"
import type { Config } from "../lib/config"
import { HttpError, type Medusa } from "../lib/medusa"
import type { Driver, PrintTrailReader, PtRef } from "../lib/print-trail"
import type { RunState } from "../lib/run-state"
import { expect, fail, manual, Outcome, Recorder, waitFor } from "../lib/runner"

export type VariantRef = { id: string; productId: string; sku: string }
export type SkuRole = "stocked" | "second" | "preOrderUnlimited" | "preOrderLimited"

export type Placed = { orderId: string; displayId: number; row: any; ref: PtRef }

export type Ctx = {
  config: Config
  medusa: Medusa
  pt: PrintTrailReader
  driver: Driver
  mock: MockPrintTrail | null
  recorder: Recorder
  regionId: string
  shippingOptionIds: Set<string>
  variants: Record<SkuRole, VariantRef | null>
  // The connection view read at the start (options, notifications).
  connection: any
  preOrder: { supported: boolean; why: string }
  // What this run placed, on disk, for the cleanup.
  state: RunState
  // Undo steps (a variant's metadata) run at the end, newest first.
  undo: { what: string; run: () => Promise<void> }[]
  shared: Map<string, Placed>
  // Orders being placed right now: the cleanup waits for them.
  inflight: Set<Promise<unknown>>
  // Set once Print Trail has been seen to hold an order the store sent.
  proved: boolean
  aborted: boolean
}

export type Scenario = {
  id: string
  title: string
  // Runs only when named in --include or --only (it changes staging for good).
  optIn?: boolean
  // A reason to skip the whole scenario, or null to run it.
  needs?: (ctx: Ctx) => string | null
  run: (t: T) => Promise<void>
}

// Ends a scenario after a failed (or a non-soft skipped/manual) check.
export class EndScenario extends Error {}

// Ends the whole run: going on would be unsafe or meaningless.
export class StopRun extends Error {}

export class T {
  constructor(
    readonly ctx: Ctx,
    readonly scenario: string
  ) {}

  // Runs one check. The function's string result is the pass detail. A fail
  // ends the scenario; so does a skip or manual, unless soft (later checks
  // don't depend on this one).
  async check(name: string, fn: () => Promise<string | void>, opts: { soft?: boolean } = {}): Promise<void> {
    if (this.ctx.aborted) throw new EndScenario("aborted")
    const started = Date.now()
    try {
      const detail = await fn()
      this.ctx.recorder.add(this.scenario, name, "pass", detail ?? "", Date.now() - started)
    } catch (e) {
      const ms = Date.now() - started
      if (e instanceof StopRun) {
        this.ctx.recorder.add(this.scenario, name, "fail", e.message, ms)
        throw e
      }
      if (e instanceof Outcome) {
        this.ctx.recorder.add(this.scenario, name, e.status, e.detail, ms)
        if (e.status === "fail" || !opts.soft) throw new EndScenario(e.detail)
        return
      }
      const detail = e instanceof HttpError ? e.message : `error: ${(e as Error)?.message ?? String(e)}`
      this.ctx.recorder.add(this.scenario, name, "fail", detail, ms)
      throw new EndScenario(detail)
    }
  }
}

// Against staging with --non-interactive, a scenario that needs a person is
// recorded as manual before it places any order.
export async function needsPerson(t: T, what: string): Promise<void> {
  if (t.ctx.driver.kind !== "human" || t.ctx.config.interactive) return
  await t.check(what, async () => manual(`needs a person: ${what} (run without --non-interactive)`))
}

// Places an order through the store and records it before anything else.
export async function placeOrder(ctx: Ctx, lines: { variantId: string; quantity: number }[]) {
  if (ctx.aborted) fail("aborted")
  const placing = ctx.medusa
    .placeOrder({
      regionId: ctx.regionId,
      email: ctx.config.customerEmail,
      runId: ctx.config.runId,
      countryCode: ctx.config.countryCode,
      lines,
      shippingOptionIds: ctx.shippingOptionIds,
    })
    .then((order) => {
      ctx.state.addOrder(order.id, order.displayId)
      return order
    })
  ctx.inflight.add(placing)
  try {
    return await placing
  } finally {
    ctx.inflight.delete(placing)
  }
}

// The first order also proves the worker sends to the Print Trail this run
// reads: a split server and worker with different settings would send
// elsewhere, and every later check would be about the wrong system.
async function provePrintTrail(ctx: Ctx, uuid: string) {
  if (ctx.proved) return
  try {
    await ctx.pt.order(uuid)
  } catch (e) {
    if ((e as any)?.status === 404) {
      throw new StopRun(
        "Print Trail doesn't know the order the store sent: the worker may use another PRINT_TRAIL_BASE_URL or channel than the server. Stopping."
      )
    }
    throw e
  }
  ctx.proved = true
}

export const firstRow = (view: any) => [...(view?.rows ?? [])].sort((a: any, b: any) => a.sequence - b.sequence)[0] ?? null

export const liveFulfilments = (order: any) => (order.fulfillments ?? []).filter((f: any) => !f.canceled_at)

export const shipped = (order: any) =>
  liveFulfilments(order).filter((f: any) => f.shipped_at && (f.labels ?? []).some((l: any) => l.tracking_number))

export const trackingNumbers = (pt: PtOrder) =>
  (pt.fulfilments ?? []).flatMap((f) => (f.trackingDetails ?? []).map((d) => d.trackingNumber ?? d.number)).filter(Boolean) as string[]

export function requireVariant(ctx: Ctx, role: SkuRole): VariantRef {
  const v = ctx.variants[role]
  expect(v, `no variant in a Print Trail shipping profile resolves to the ${role} SKU`)
  return v
}

export async function waitForRow(t: T, orderId: string, what: string, pred: (row: any, view: any) => boolean, timeoutMs: number) {
  return waitFor(
    what,
    async () => {
      const view = await t.ctx.medusa.ptView(orderId)
      const row = firstRow(view)
      return row && pred(row, view) ? { row, view } : null
    },
    { timeoutMs }
  )
}

// Places an order and waits until the plugin has sent and confirmed it.
export async function placeAndConfirm(t: T, lines: { role: SkuRole; quantity: number }[]): Promise<Placed> {
  const { ctx } = t
  let placed!: Placed
  let orderId = ""
  let displayId = 0
  await t.check("order placed in the store", async () => {
    const resolved = lines.map((l) => ({ variantId: requireVariant(ctx, l.role).id, quantity: l.quantity }))
    const order = await placeOrder(ctx, resolved)
    orderId = order.id
    displayId = order.displayId
    return `order #${order.displayId}`
  })
  await t.check("sent to Print Trail and confirmed", async () => {
    const { row } = await waitForRow(
      t,
      orderId,
      "the plugin to confirm the order at Print Trail",
      (r) => !!r.pt_uuid && (!!r.confirmed_at || !!r.attention || !!r.block_reason),
      ctx.config.timeouts.send
    )
    ctx.state.addPtUuid(orderId, row.pt_uuid)
    await provePrintTrail(ctx, row.pt_uuid)
    expect(row.confirmed_at, `not confirmed: attention ${row.attention ?? "none"}, block ${row.block_reason ?? "none"}, last error ${row.last_error ?? "none"}`)
    placed = { orderId, displayId, row, ref: { uuid: row.pt_uuid, number: row.pt_order_number } }
    return `Print Trail order ${row.pt_order_number}`
  })
  return placed
}

// One confirmed order shared by the scenarios that don't change it much.
export async function sharedOrder(t: T, key = "stocked"): Promise<Placed> {
  const have = t.ctx.shared.get(key)
  if (have) return have
  const placed = await placeAndConfirm(t, [{ role: "stocked", quantity: 1 }])
  t.ctx.shared.set(key, placed)
  return placed
}

// Medusa's template ids for the plugin's two emails, or null when off.
export const emailTemplate = (ctx: Ctx, which: "shipment" | "cancelTooLate"): string | null => {
  const v = ctx.connection?.options?.notifications?.[which]
  return typeof v === "string" && v ? v : null
}

export async function emailsFor(ctx: Ctx, template: string, orderId: string): Promise<number> {
  const list = await ctx.medusa.notifications(template)
  return list.filter((n) => n.data?.order?.id === orderId).length
}
