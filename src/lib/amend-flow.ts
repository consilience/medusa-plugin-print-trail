import { ACCESS_REFUSED, PrintTrailApiError } from "../modules/printTrail/client/errors"
import type { PtOrder } from "../modules/printTrail/client/types"
import {
  desiredLines,
  interpretAmendError,
  planAmend,
  ptHasLines,
  ptLinesDiverged,
  type AmendAction,
} from "./amend-decisions"
import { printTrailAppUrl } from "./app-url"
import { cancelRow, requestCancel, type CancelContext } from "./cancel-flow"
import { linesOverLimits } from "./input-limits"
import type { ScopedLine } from "./lines"
import { releasesLines } from "./order-scope"
import {
  ACCESS_ATTENTION,
  deferralFor,
  refusalAttention,
  deferRetry,
  RETRY_CAPS,
  RETRY_DELAY_MS,
  scheduleRetry,
  uncount,
  zeroAttempts,
  type Deferral,
} from "./retry"
import {
  AMEND_CALLS_PER_ROW,
  rowsPerRun,
  SEND_LOCK_TTL_SECONDS,
  snapshotFields,
  type PrintTrailEvent,
  type PrintTrailOrderRow,
} from "./send-flow"
import { ptBackToDraft } from "./sync-decisions"
import { scheduleRefetch } from "./sync-flow"

// The logic behind amendPrintTrailOrder: carries a confirmed Medusa order
// edit to each Print Trail order of the Medusa order. A draft is re-sent by
// the caller (resend); a confirmed order is amended with PUT …/lines unless
// Print Trail's copy was changed in its app; an emptied order is blocked and
// cancelled, so a draft with no lines left is never confirmed later.

export type AmendContext = CancelContext

export type AmendOutcome = {
  rowId: string
  action: AmendAction["kind"]
  result: "amended" | "unchanged" | "refused" | "diverged" | "retry" | "cancelled" | "resend" | "none"
  events: PrintTrailEvent[]
  // Lines re-added to a row that gave them up: the caller sends them as a
  // new "-n" order (the send workflow's remainder).
  remainder?: boolean
}

type Entry = { kind: string; message: string; data?: Record<string, unknown> }

const AMEND_ATTENTION = new Set(["amend-refused", "amend-diverged", "amend-unsent-items", "retry-cap:amend"])
// Set by the amend intent when it replaced a pending refetch.
export const REFETCH_DISPLACED = "refetch_displaced"
// Print Trail refused an edit for stock (409 stock-held): { order_id,
// print_trail_order_id, pt_uuid, skus }. The shortfall subscriber refreshes
// those SKUs' stock.
export const STOCK_HELD_EVENT = "print_trail.order.stock_held"

const nowOf = (ctx: { now?: () => Date }) => (ctx.now ? ctx.now() : new Date())

const eventData = (row: PrintTrailOrderRow) => ({
  order_id: row.order_id,
  print_trail_order_id: row.id,
  pt_uuid: row.pt_uuid ?? null,
})

async function getRow(ctx: AmendContext, rowId: string) {
  const [row] = await ctx.store.listPrintTrailOrders({ id: rowId })
  return row ?? null
}

async function writeEntries(ctx: AmendContext, row: PrintTrailOrderRow, entries: Entry[]) {
  if (!entries.length) return
  const link = { pt_uuid: row.pt_uuid ?? null, pt_url: printTrailAppUrl(ctx.options, ctx.teamCode, row.pt_uuid) }
  await ctx.store.createPrintTrailOrderEvents(
    entries.map((e) => ({
      order_id: row.order_id,
      print_trail_order_id: row.id,
      kind: e.kind,
      message: e.message,
      data: { ...link, ...e.data },
    }))
  )
}

// Written once per row per key, as sync's dispatch entries are.
async function writeOnce(ctx: AmendContext, row: PrintTrailOrderRow, entry: Entry & { data: { key: string } }) {
  const existing = await ctx.store.listPrintTrailOrderEvents({ print_trail_order_id: row.id, kind: entry.kind })
  if (existing.some((e) => e.data?.key === entry.data.key)) return false
  await writeEntries(ctx, row, [entry])
  return true
}

// Ends the amend this run owns: clears an amend lease (and its count) and
// puts back a refetch the amend intent replaced. A retry keeps it.
async function settleLease(ctx: AmendContext, rowId: string, opts: { refetch?: boolean } = {}) {
  const row = await getRow(ctx, rowId)
  if (!row) return
  const attempts = { ...(row.attempts ?? {}) }
  const displaced = !!attempts[REFETCH_DISPLACED]
  zeroAttempts(attempts, [REFETCH_DISPLACED, "amend"])
  const ours = row.pending_action === "amend"
  if (ours || displaced) {
    await ctx.store.updatePrintTrailOrders({
      id: row.id,
      attempts,
      ...(ours ? { pending_action: null, next_attempt_at: null } : {}),
    })
  }
  if ((opts.refetch || displaced) && row.pt_uuid) {
    await scheduleRefetch(ctx.store, row.id, nowOf(ctx), null, { counted: !displaced || !!opts.refetch })
  }
}

// Amends every row of the order in sequence order. Each row is planned
// against the others as they are after the rows before it were amended, so
// rows that share a line never carry it twice (or cancel one that's live).
export async function amendRows(
  ctx: AmendContext,
  orderId: string,
  lines: ScopedLine[],
  orderCanceled: boolean,
  itemQuantities?: Map<string, number>,
  // Rows leaseAmends counted this run.
  opts: { leased?: string[] } = {}
): Promise<{ outcomes: AmendOutcome[]; resend: number[]; remainder: boolean }> {
  const list = async () =>
    ((await ctx.store.listPrintTrailOrders({ order_id: orderId })) as PrintTrailOrderRow[]).sort((a, b) => a.sequence - b.sequence)
  const outcomes: AmendOutcome[] = []
  const resend: number[] = []
  // Rows that call Print Trail, within what the lock's ttl allows; the rest
  // are left with a due amend for the sweep.
  const budget = rowsPerRun(SEND_LOCK_TTL_SECONDS, AMEND_CALLS_PER_ROW)
  let called = 0
  for (const { id } of await list()) {
    const rows = await list()
    const row = rows.find((r) => r.id === id)
    if (!row) continue
    const kind = planAmend(row, rows, lines, orderCanceled, itemQuantities).kind
    // A capped amend makes no call (amendRow skips it), so it takes no slot.
    const capped = kind === "put-lines" && row.attention === "retry-cap:amend"
    const calls = (kind === "put-lines" || kind === "cancel-emptied") && !capped
    if (calls && called >= budget) {
      const free = !row.pending_action || row.pending_action === "amend" || row.pending_action === "refetch"
      if (free && !row.cancel_status) {
        // Not tried this run: give back the attempt the lease counted.
        const attempts = opts.leased?.includes(row.id) ? { attempts: uncount(row.attempts, ["amend"]) } : {}
        await ctx.store.updatePrintTrailOrders({ id: row.id, pending_action: "amend", next_attempt_at: nowOf(ctx), ...attempts })
      }
      continue
    }
    if (calls) called++
    const outcome = await amendRow(ctx, row, rows, lines, orderCanceled, itemQuantities)
    outcomes.push(outcome)
    if (outcome.result === "resend") resend.push(row.sequence)
  }
  return { outcomes, resend, remainder: !orderCanceled && outcomes.some((o) => o.remainder) }
}

// The amend intent, written before the lock so an edit that can't get it is
// run by the sweep. Only confirmed rows need it: a draft is always re-posted
// with the current lines before it confirms. Never replaces a pending send,
// confirm or cancel; a replaced refetch is marked so the amend puts it back.
// A new edit starts the amend's count again (and clears a capped amend);
// a sweep retry keeps the count and only pushes the lease out, so a run that
// keeps failing comes back every 15 minutes, not every sweep.
export async function recordAmendIntent(
  store: AmendContext["store"],
  rows: PrintTrailOrderRow[],
  opts: { retry: boolean },
  now: Date
): Promise<string[]> {
  const due = new Date(now.getTime() + RETRY_DELAY_MS)
  const marked: string[] = []
  for (const row of rows) {
    if (opts.retry) {
      if (row.pending_action === "amend") {
        await store.updatePrintTrailOrders({ id: row.id, next_attempt_at: due })
        marked.push(row.id)
      }
      continue
    }
    const free = !row.pending_action || row.pending_action === "refetch" || row.pending_action === "amend"
    if (!row.confirmed_at || row.cancel_status || !free) continue
    const attempts = { ...(row.attempts ?? {}) }
    zeroAttempts(attempts, ["amend"])
    if (row.pending_action === "refetch") attempts[REFETCH_DISPLACED] = 1
    await store.updatePrintTrailOrders({
      id: row.id,
      pending_action: "amend",
      next_attempt_at: due,
      attempts,
      ...(row.attention === "retry-cap:amend" ? { attention: null } : {}),
    })
    marked.push(row.id)
  }
  return marked
}

// Right after the lock, before anything that can throw: each row with a
// pending amend counts this run's attempt (as a send's lease does), so a run
// that keeps failing (a throwing filterLines handler, say) still reaches the
// cap. A count already at the cap means the runs died: stop with attention
// until a new edit. A row a cancel owns is never leased.
// Only as many rows as one run takes to Print Trail (amendRows' cap) are
// counted, lowest sequence first; amendRows hands back the count of any it
// still defers, so no row is capped untried.
export async function leaseAmends(
  store: AmendContext["store"],
  orderId: string,
  now: Date
): Promise<{ events: PrintTrailEvent[]; leased: string[] }> {
  const rows = ((await store.listPrintTrailOrders({ order_id: orderId })) as PrintTrailOrderRow[]).sort((a, b) => a.sequence - b.sequence)
  const events: PrintTrailEvent[] = []
  const leased: string[] = []
  const budget = rowsPerRun(SEND_LOCK_TTL_SECONDS, AMEND_CALLS_PER_ROW)
  for (const row of rows) {
    if (row.pending_action !== "amend" || row.cancel_status) continue
    if (leased.length >= budget) break
    const made = row.attempts?.amend ?? 0
    if (made >= RETRY_CAPS.amend) {
      await store.updatePrintTrailOrders({ id: row.id, pending_action: null, next_attempt_at: null, attention: "retry-cap:amend" })
      await store.createPrintTrailOrderEvents([
        {
          order_id: row.order_id,
          print_trail_order_id: row.id,
          kind: "retry-capped",
          message: `Stopped retrying the Print Trail amend after ${made} attempts that didn't finish`,
          data: { pt_uuid: row.pt_uuid ?? null },
        },
      ])
      events.push({ name: "print_trail.order.attention", data: { ...eventData(row), attention: "retry-cap:amend" } })
      continue
    }
    await store.updatePrintTrailOrders({
      id: row.id,
      next_attempt_at: new Date(now.getTime() + RETRY_DELAY_MS),
      attempts: { ...(row.attempts ?? {}), amend: made + 1 },
    })
    leased.push(row.id)
  }
  return { events, leased }
}

// The row as it is now, unless a cancel has taken it over.
async function stillOurs(ctx: AmendContext, rowId: string) {
  const fresh = await getRow(ctx, rowId)
  return !!fresh && !fresh.cancel_status
}

const reopenMessage =
  'Print Trail doesn\'t reopen a cancelled order. Use "Resend as a new Print Trail order" to send these items again.'

export async function amendRow(
  ctx: AmendContext,
  input: PrintTrailOrderRow,
  rows: PrintTrailOrderRow[],
  lines: ScopedLine[],
  orderCanceled: boolean,
  itemQuantities?: Map<string, number>
): Promise<AmendOutcome> {
  const row = (await getRow(ctx, input.id)) ?? input
  const scopeRows = rows.map((r) => (r.id === row.id ? row : r))
  const plan = planAmend(row, scopeRows, lines, orderCanceled, itemQuantities)
  const out = (result: AmendOutcome["result"], events: PrintTrailEvent[] = [], action = plan.kind): AmendOutcome => ({
    rowId: row.id,
    action,
    result,
    events,
  })

  switch (plan.kind) {
    case "none":
      await settleLease(ctx, row.id)
      return out("none")
    case "resend":
      // The caller runs the send workflow after the lock is released; it
      // must find no amend lease, which it would never clear.
      await settleLease(ctx, row.id)
      return out("resend")
    case "closed": {
      await settleLease(ctx, row.id)
      await noteReopenRefused(ctx, row, plan.reAdded)
      const remainder = plan.reAdded.length > 0 && releasesLines(row)
      return { ...out("none"), ...(remainder ? { remainder } : {}) }
    }
    case "cancel-emptied":
      await settleLease(ctx, row.id)
      return cancelEmptied(ctx, row, plan.kind)
    case "put-lines":
      // Capped: no more attempts until a new edit clears it.
      if (row.attention === "retry-cap:amend") return out("none")
      return putLines(ctx, row, scopeRows, lines, plan, itemQuantities)
  }
}

async function noteReopenRefused(ctx: AmendContext, row: PrintTrailOrderRow, reAdded: string[]) {
  if (!reAdded.length) return
  const key = [...reAdded].sort().join(",")
  const message = releasesLines(row)
    ? `${row.pt_order_number} was cancelled at Print Trail, so the re-added items will be sent as a new Print Trail order.`
    : reopenMessage
  await writeOnce(ctx, row, { kind: "reopen-refused", message, data: { key, line_numbers: reAdded } })
}

// An emptied draft: blocked first, so a crash before the cancel still stops a
// confirm, then the cancel (direct: this already holds the order's lock).
async function cancelEmptied(ctx: AmendContext, row: PrintTrailOrderRow, action: AmendAction["kind"]): Promise<AmendOutcome> {
  await ctx.store.updatePrintTrailOrders({ id: row.id, block_reason: "no-pt-lines" })
  await writeEntries(ctx, row, [
    { kind: "blocked", message: "Confirmation blocked: no-pt-lines (every Print Trail item was removed in Medusa)" },
  ])
  const events: PrintTrailEvent[] = [{ name: "print_trail.order.blocked", data: { ...eventData(row), reason: "no-pt-lines" } }]
  const fresh = (await getRow(ctx, row.id)) ?? row
  await requestCancel(ctx.store, [fresh], "no-pt-lines", nowOf(ctx))
  const requested = await getRow(ctx, row.id)
  if (requested?.cancel_status === "requested") {
    const cancelled = await cancelRow(ctx, requested)
    events.push(...cancelled.events)
  }
  return { rowId: row.id, action, result: "cancelled", events }
}

async function putLines(
  ctx: AmendContext,
  row: PrintTrailOrderRow,
  rows: PrintTrailOrderRow[],
  lines: ScopedLine[],
  plan: Extract<AmendAction, { kind: "put-lines" }>,
  itemQuantities?: Map<string, number>
): Promise<AmendOutcome> {
  const { store, client } = ctx
  const now = nowOf(ctx)
  const result = (r: AmendOutcome["result"], events: PrintTrailEvent[] = []): AmendOutcome => ({
    rowId: row.id,
    action: "put-lines",
    result: r,
    events,
  })
  const desired = desiredLines(row, rows, lines, itemQuantities)
  const key = JSON.stringify(desired.map((l) => [l.lineNumber, l.quantity]))

  // leaseAmends counted this run's attempt; the outcome works from the
  // count before it (send's lease/uncount scheme).
  const leased = row.pending_action === "amend"
  const prior = { attempts: leased ? uncount(row.attempts, ["amend"]) : { ...(row.attempts ?? {}) } }
  const retry = async (detail: string): Promise<AmendOutcome> => {
    // A cancel that landed meanwhile owns the row: no amend retry.
    if (!(await stillOurs(ctx, row.id))) return result("none")
    const next = scheduleRetry(prior, "amend", now)
    await store.updatePrintTrailOrders({ id: row.id, ...next, attention: next.attention ?? row.attention ?? null, last_error: detail })
    if (next.attention) {
      await writeEntries(ctx, row, [
        { kind: "retry-capped", message: `Stopped retrying the Print Trail amend after ${next.attempts.amend} attempts: ${detail}` },
      ])
      return result("retry", [{ name: "print_trail.order.attention", data: { ...eventData(row), attention: next.attention } }])
    }
    return result("retry")
  }
  // Access refused, or the client's Retry-After pause: the amend stays
  // pending, with no attempt counted, and runs once access returns.
  const defer = async (d: Deferral, detail: string): Promise<AmendOutcome> => {
    if (!(await stillOurs(ctx, row.id))) return result("none")
    const attention = refusalAttention(row.attention, d.refusal)
    await store.updatePrintTrailOrders({
      id: row.id,
      ...deferRetry(prior, "amend", now, d.delayMs),
      last_error: detail,
      ...(attention ? { attention } : {}),
    })
    if (d.refusal) ctx.logger.warn(`Print Trail: amending order ${row.order_id} (${row.id}) waits: ${ACCESS_REFUSED[d.refusal]}`)
    return result(
      "retry",
      attention && row.attention !== attention ? [{ name: "print_trail.order.attention", data: { ...eventData(row), attention } }] : []
    )
  }
  const attention = async (code: string): Promise<PrintTrailEvent[]> => {
    if (row.attention === code) return []
    await store.updatePrintTrailOrders({ id: row.id, attention: code })
    return [{ name: "print_trail.order.attention", data: { ...eventData(row), attention: code } }]
  }

  const uncounted = () => {
    const attempts = { ...prior.attempts }
    zeroAttempts(attempts, ["amend"])
    return attempts
  }

  // 1. Print Trail's copy as it is now.
  let current: PtOrder
  try {
    current = await client.getOrder(row.pt_uuid!)
  } catch (e) {
    if (!(e instanceof PrintTrailApiError)) throw e
    const d = deferralFor(e)
    if (d) return defer(d, e.detail)
    if (e.isTransient) return retry(e.detail)
    await settleLease(ctx, row.id)
    if (e.status === 404) return result("refused", await attention("pt-order-missing"))
    ctx.logger.warn(`Print Trail: couldn't read order ${row.order_id} (${row.id}) to amend it: ${e.detail}`)
    return result("refused")
  }

  // 2. Never PUT over a change made in the Print Trail app.
  if (current.status === "cancelled") {
    await settleLease(ctx, row.id, { refetch: true })
    const submitted = new Set(desired.filter((l) => !l.added).map((l) => l.lineNumber))
    await noteReopenRefused(ctx, row, desired.filter((l) => l.quantity > 0 && (l.added || !submitted.has(l.lineNumber))).map((l) => l.lineNumber))
    return result("none")
  }
  const sending = plan.body.orderLines
  if ((row.confirmed_at && ptBackToDraft(current)) || (ptLinesDiverged(row.submitted_lines, current) && !ptHasLines(sending, current))) {
    await settleLease(ctx, row.id, { refetch: true })
    const events = await attention("amend-diverged")
    await writeOnce(ctx, row, {
      kind: "amend-diverged",
      message:
        "Print Trail's copy of this order was changed in the Print Trail app, so Medusa's edit wasn't sent. Make the change in Print Trail.",
      data: { key, lines: desired },
    })
    return result("diverged", events)
  }

  // 3. PUT …/lines: the full set, removed lines at 0. Not over a cancel
  // that landed while Print Trail was read.
  if (!(await stillOurs(ctx, row.id))) return result("none")
  const refuse = async (detail: string, reason: string | null, shortfall?: { sku: string }[]) => {
    await store.updatePrintTrailOrders({ id: row.id, last_error: detail })
    const unsent = plan.added.length > 0
    const events = await attention(unsent ? "amend-unsent-items" : "amend-refused")
    // Refused for stock: the store sold what Print Trail can't hold, so the
    // shortfall subscriber refreshes those SKUs, on every such refusal (the
    // attention event only comes once).
    const skus = [...new Set((shortfall ?? []).map((s) => s.sku).filter(Boolean))]
    if (skus.length) events.push({ name: STOCK_HELD_EVENT, data: { ...eventData(row), skus } })
    await writeOnce(ctx, row, {
      kind: "amend-refused",
      message: unsent
        ? `Print Trail refused Medusa's edit: ${detail}. The added items (${plan.added.join(", ")}) weren't sent; "Resend" will send them as a new Print Trail order.`
        : `Print Trail refused Medusa's edit: ${detail}`,
      data: { key: `${key}:${reason ?? ""}`, reason, unsent: plan.added },
    })
    try {
      const pt = await client.getOrder(row.pt_uuid!)
      await store.updatePrintTrailOrders({ id: row.id, ...snapshotFields(pt, now, row) })
    } catch (refresh) {
      ctx.logger.warn(`Print Trail: couldn't refresh order ${row.order_id} (${row.id}) after a refused amend: ${(refresh as Error).message}`)
    }
    await settleLease(ctx, row.id, { refetch: true })
    return result("refused", events)
  }
  // API 1.2.0 refuses these with a 422: never sent.
  const over = linesOverLimits(plan.body.orderLines)
  if (over.length) return refuse(`Over Print Trail's limits: ${over.join("; ")}`, "over-limits")
  try {
    const amended = await client.amendLines(row.pt_uuid!, plan.body)
    const pt = amended.order ?? (await client.getOrder(row.pt_uuid!).catch(() => null))
    const kept = sending.filter((l) => l.quantity > 0)
    const skuOf = new Map(desired.map((l) => [l.lineNumber, l.sku]))
    await store.updatePrintTrailOrders({
      id: row.id,
      ...(pt ? snapshotFields(pt, now, row) : {}),
      submitted_lines: kept.map((l) => ({ quantity: l.quantity, lineNumber: l.lineNumber, product: { sku: skuOf.get(l.lineNumber) } })),
      attempts: uncounted(),
      attention: row.attention && (AMEND_ATTENTION.has(row.attention) || ACCESS_ATTENTION.has(row.attention)) ? null : (row.attention ?? null),
      last_error: null,
    })
    if (amended.amendment?.result === "amended") {
      const changes = (amended.amendment.changes ?? [])
        .map((c) => `${c.lineNumber} ${c.change.replace("_", " ")} ${c.from} → ${c.to}`)
        .join(", ")
      await writeEntries(ctx, row, [
        {
          kind: "amended",
          message: `Print Trail: ${amended.amendment.message ?? "amended"}${changes ? ` (${changes})` : ""}`,
          data: { changes: amended.amendment.changes ?? [] },
        },
      ])
    }
    // 5. An amend sends no webhook: re-fetch so sync sees the new fulfilments.
    await settleLease(ctx, row.id, { refetch: true })
    return result(amended.amendment?.result === "unchanged" ? "unchanged" : "amended")
  } catch (e) {
    if (!(e instanceof PrintTrailApiError)) throw e
    const d = deferralFor(e)
    if (d) return defer(d, e.detail)
    const failure = interpretAmendError(e)
    switch (failure.kind) {
      case "retry":
        return retry(failure.detail)
      case "no-lines":
        await settleLease(ctx, row.id)
        return cancelEmptied(ctx, (await getRow(ctx, row.id)) ?? row, "put-lines")
      case "not-found":
        await settleLease(ctx, row.id)
        return result("refused", await attention("pt-order-missing"))
      case "auth-failed":
      case "channel-inactive":
        await settleLease(ctx, row.id)
        ctx.logger.warn(`Print Trail: amending order ${row.order_id} (${row.id}) was refused: ${ACCESS_REFUSED[failure.kind]}`)
        return result("refused")
      case "refused":
        return refuse(failure.detail, failure.reason, failure.shortfall)
    }
  }
}
