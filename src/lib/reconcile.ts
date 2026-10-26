import { randomUUID } from "node:crypto"
import type { ILockingModule, Logger } from "@medusajs/framework/types"
import type { PrintTrailClient } from "../modules/printTrail/client/client"
import { PrintTrailApiError } from "../modules/printTrail/client/errors"
import type { PtOrder } from "../modules/printTrail/client/types"
import { matchPrintTrailOrder, type MatchRow } from "./sync-decisions"
import type { StateStore } from "./team-code"

// The print-trail-reconcile poll, as the published GET /orders algorithm
// describes it: request updated-since=<cursor> (inclusive), apply the page,
// then persist the greatest updatedAt applied, and follow links.next until
// it's null. The listed resources are fetched orders, not payloads, so they
// are applied as they are.

export const RECONCILE_CURSOR_KEY = "reconcile_cursor"
export const RECONCILE_LOCK_KEY = "print-trail:reconcile"
// uuid → the failure record of that order at one updatedAt.
export const RECONCILE_FAILURES_KEY = "reconcile_failures"
// After this many counted failures an order is skipped, so one poison order
// can't hold the cursor (and re-walk everything after it) for ever.
export const RECONCILE_POISON_RUNS = 3

export type ReconcileFailure = {
  updatedAt: string | null
  // Failures in runs where another order synced, so the fault wasn't systemic.
  runs: number
  // Failures in runs where it was the only order listed (can't tell).
  lone?: number
  // Passed over until the order changes or syncs some other way.
  skipped?: boolean
  error: string
}
export type ReconcileFailures = Record<string, ReconcileFailure>

// A sync that worked by any path (webhook, refetch) ends the order's record.
export async function clearReconcileFailure(state: StateStore, uuid: string): Promise<void> {
  const failures = await state.getState<ReconcileFailures>(RECONCILE_FAILURES_KEY)
  if (failures?.[uuid]) {
    const { [uuid]: _gone, ...rest } = failures
    await state.setState(RECONCILE_FAILURES_KEY, rest)
  }
}
// Longer than the slowest run we expect (pages of 20, each sync bounded by
// the client's timeouts); a crashed run's lock lapses well before the next
// scheduled run.
export const RECONCILE_LOCK_TTL_SECONDS = 30 * 60

export type ReconcileCursor = { updatedSince: string; lastCompletedAt?: string }

const DAY_MS = 24 * 60 * 60 * 1000
const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z")
const time = (s: string) => Date.parse(s)

export function initialCursor(now: Date, lookbackDays: number): string {
  return iso(new Date(now.getTime() - lookbackDays * DAY_MS))
}

// Never moves backwards. A failed (or not-yet-applied) order holds the cursor
// at its updatedAt, which the next run reads again (the cursor is inclusive).
export function advanceCursor(
  current: string,
  applied: { updatedAt?: string | null }[],
  failedAt: string | null
): string {
  let next = current
  for (const o of applied) {
    if (o.updatedAt && time(o.updatedAt) > time(next)) next = o.updatedAt
  }
  if (failedAt && time(failedAt) < time(next)) {
    next = failedAt
  }
  return time(next) < time(current) ? current : next
}

export type ReconcileDeps = {
  client: Pick<PrintTrailClient, "ordersUpdatedSincePages">
  state: StateStore
  find: Parameters<typeof matchPrintTrailOrder>[1]
  // listedAt: when the page was read, so a newer local snapshot isn't rolled back.
  sync(row: MatchRow, pt: PtOrder, hint: string | undefined, listedAt: Date): Promise<void>
  copySeen(row: MatchRow, pt: PtOrder): Promise<void>
  // Marks a skipped poison order's row for attention.
  flag(row: MatchRow, pt: PtOrder, detail: string): Promise<void>
  logger: Pick<Logger, "info" | "warn" | "debug" | "error">
  now?: () => Date
  lookbackDays: number
  // Checked after each order: true stops the run (Print Trail refused access
  // during it, so every further request would be refused too).
  halt?: () => Promise<boolean>
}

export type ReconcileResult = {
  pages: number
  synced: number
  ignored: number
  failed: number
  // Poison orders skipped past this run.
  skipped: number
  completed: boolean
  cursor: string
}

const earliest = (a: string | null, b: string | null | undefined) =>
  !b ? a : !a || time(b) < time(a) ? b : a

export async function runReconcile(deps: ReconcileDeps): Promise<ReconcileResult> {
  const now = deps.now ? deps.now() : new Date()
  const stored = await deps.state.getState<ReconcileCursor>(RECONCILE_CURSOR_KEY)
  const start = stored?.updatedSince ?? initialCursor(now, deps.lookbackDays)
  const result: ReconcileResult = { pages: 0, synced: 0, ignored: 0, failed: 0, skipped: 0, completed: false, cursor: start }
  const persist = (extra: Partial<ReconcileCursor> = {}) =>
    deps.state.setState(RECONCILE_CURSOR_KEY, {
      updatedSince: result.cursor,
      ...(stored?.lastCompletedAt ? { lastCompletedAt: stored.lastCompletedAt } : {}),
      ...extra,
    })
  // uuid → the updatedAt this run applied.
  const seen = new Map<string, string | null>()
  const storedFailures = (await deps.state.getState<ReconcileFailures>(RECONCILE_FAILURES_KEY)) ?? {}
  const failures: ReconcileFailures = { ...storedFailures }
  const clock = () => (deps.now ? deps.now() : new Date())
  const applied: PtOrder[] = []
  const failedNow: { pt: PtOrder; row: MatchRow | null; detail: string }[] = []
  let reappearedAt: string | null = null
  let attempted = 0
  let succeeded = 0

  // Failures hold the cursor while walking; what they count for is decided
  // once the run shows whether anything else synced.
  const holdOf = (list: typeof failedNow) =>
    list.reduce<string | null>((at, f) => earliest(at, f.pt.updatedAt), reappearedAt)

  let stopped = false
  try {
    const pages = deps.client.ordersUpdatedSincePages(start)[Symbol.asyncIterator]()
    walk: while (true) {
      // Before the request: anything synced locally after this is newer.
      const listedAt = clock()
      const next = await pages.next()
      if (next.done) break
      const page = next.value
      result.pages++
      for (const pt of page) {
        if (seen.has(pt.uuid)) {
          // Synced once this run already. If it has changed since, hold the
          // cursor so the next run applies the newer state.
          if (pt.updatedAt && pt.updatedAt !== seen.get(pt.uuid)) reappearedAt = earliest(reappearedAt, pt.updatedAt)
          continue
        }
        seen.set(pt.uuid, pt.updatedAt ?? null)
        const record = failures[pt.uuid]
        if (record && record.updatedAt !== (pt.updatedAt ?? null)) {
          // The order has changed since it failed: start again.
          delete failures[pt.uuid]
        } else if (record?.skipped) {
          // A poison order still unchanged (re-listed by the inclusive
          // cursor): pass over it.
          applied.push(pt)
          continue
        }
        attempted++
        let match: Awaited<ReturnType<typeof matchPrintTrailOrder>> | null = null
        try {
          match = await matchPrintTrailOrder({ uuid: pt.uuid, orderNumber: pt.orderNumber }, deps.find)
          if (match.kind === "row" || match.kind === "adopt") {
            await deps.sync(match.row, pt, match.kind === "adopt" ? pt.uuid : undefined, listedAt)
            result.synced++
            // Only a real order that synced shows the fault isn't systemic.
            succeeded++
          } else if (match.kind === "copy") {
            await deps.copySeen(match.row, pt)
            result.synced++
          } else {
            deps.logger.debug(`Print Trail reconcile: ignoring order ${pt.uuid} (${pt.orderNumber ?? "no number"}): ${match.why}`)
            result.ignored++
          }
          applied.push(pt)
          delete failures[pt.uuid]
        } catch (e) {
          const detail = (e as Error).message
          result.failed++
          failedNow.push({ pt, row: match && match.kind !== "unknown" ? match.row : null, detail })
          deps.logger.warn(`Print Trail reconcile: order ${pt.uuid} failed: ${detail}`)
        }
        if (await deps.halt?.()) {
          deps.logger.warn("Print Trail reconcile stopped: Print Trail refused access during the run")
          stopped = true
          result.cursor = advanceCursor(result.cursor, applied, holdOf(failedNow))
          await persist()
          break walk
        }
      }
      result.cursor = advanceCursor(result.cursor, applied, holdOf(failedNow))
      await persist()
    }
  } catch (e) {
    if (!(e instanceof PrintTrailApiError)) {
      throw e
    }
    deps.logger.warn(`Print Trail reconcile stopped: ${e.message}`)
    stopped = true
  }

  const recordOf = (f: (typeof failedNow)[number]): ReconcileFailure =>
    failures[f.pt.uuid] ?? { updatedAt: f.pt.updatedAt ?? null, runs: 0, error: "" }
  const flagOrLog = async (f: (typeof failedNow)[number], runs: number) => {
    if (f.row) {
      await deps.flag(f.row, f.pt, f.detail).catch((flagError) =>
        deps.logger.error(`Print Trail reconcile: couldn't flag order ${f.pt.uuid}: ${(flagError as Error).message}`)
      )
    } else {
      deps.logger.error(`Print Trail reconcile: order ${f.pt.uuid} has failed ${runs} runs: ${f.detail}`)
    }
  }

  if (failedNow.length && attempted === 1) {
    // Alone in its window: no other order to show the fault isn't systemic.
    // Flag it after three runs, but don't skip it; the re-walk is just it.
    const f = failedNow[0]
    const record = recordOf(f)
    const lone = (record.lone ?? 0) + 1
    failures[f.pt.uuid] = { ...record, lone, error: f.detail.slice(0, 300) }
    if (lone === RECONCILE_POISON_RUNS) await flagOrLog(f, lone)
  } else if (failedNow.length && !succeeded) {
    deps.logger.error(
      `Print Trail reconcile: none of ${attempted} orders synced; treating it as a systemic fault and counting none`
    )
  } else if (failedNow.length) {
    const skippedNow: PtOrder[] = []
    for (const f of failedNow) {
      const record = recordOf(f)
      const runs = record.runs + 1
      const skipped = runs >= RECONCILE_POISON_RUNS
      failures[f.pt.uuid] = { ...record, runs, skipped, error: f.detail.slice(0, 300) }
      if (skipped) {
        skippedNow.push(f.pt)
        result.skipped++
        result.failed--
        await flagOrLog(f, runs)
      }
    }
    if (skippedNow.length) {
      const held = failedNow.filter((f) => !skippedNow.includes(f.pt))
      result.cursor = advanceCursor(start, [...applied, ...skippedNow], holdOf(held))
      await persist()
    }
  }

  // Bounded: records older than the lookback window behind the cursor go.
  const oldest = time(result.cursor) - deps.lookbackDays * DAY_MS
  for (const [uuid, record] of Object.entries(failures)) {
    if (record.updatedAt && time(record.updatedAt) < oldest) delete failures[uuid]
  }
  if (JSON.stringify(failures) !== JSON.stringify(storedFailures)) {
    await deps.state.setState(RECONCILE_FAILURES_KEY, failures)
  }

  if (stopped || result.failed) {
    return result
  }
  result.completed = true
  await persist({ lastCompletedAt: now.toISOString() })
  return result
}

// The Locking Module's execute() uses its timeout as the lock's expiry too
// before Medusa 2.21 (in-memory and Redis providers; 2.21.0's
// medusajs/medusa#16768 renews the lease instead), so a long job would
// outlive its lock. This takes the lock with a real ttl and skips when it's
// held, which is right for both.
export async function withHeldLock<T>(
  locking: Pick<ILockingModule, "acquire" | "release">,
  key: string,
  ttlSeconds: number,
  fn: () => Promise<T>
): Promise<{ ran: true; result: T } | { ran: false }> {
  const ownerId = randomUUID()
  try {
    await locking.acquire(key, { ownerId, expire: ttlSeconds })
  } catch {
    return { ran: false }
  }
  try {
    return { ran: true, result: await fn() }
  } finally {
    await locking.release(key, { ownerId })
  }
}
