import type { PrintTrailClient } from "../modules/printTrail/client/client"
import type { PtSkuResult } from "../modules/printTrail/client/types"
import { isNumericOverride, normaliseSku } from "./sku"
import { mergeUnmatched, STATE_KEYS } from "./stock"
import type { StateStore } from "./team-code"

// The SKU check run when a variant or product is saved: validate the resolved
// SKU with POST /products/validate-skus and record the result in variant
// metadata. Compare-before-call and compare-before-write keep the plugin's own
// write-back (which fires product-variant.updated again) from looping.

export type SkuCheckStatus = "matched" | "inactive" | "pre-order" | "not-found" | "no-sku" | "error"
export type SkuCheck = {
  sku: string | null
  status: SkuCheckStatus
  checked_at: string
  matched_sku?: string
  // "numeric-override": print_trail_sku was saved as a number, so leading
  // zeros may have been lost.
  note?: "numeric-override"
}
export const SKU_CHECK_KEY = "print_trail_sku_check"

type StoredCheck = { sku?: unknown; status?: unknown; matched_sku?: unknown; note?: unknown }

const asCheck = (check: unknown): StoredCheck | null =>
  check && typeof check === "object" && !Array.isArray(check) ? (check as StoredCheck) : null

// "error" (couldn't check) is never current, so a later save re-checks.
export function isCheckCurrent(
  resolvedSku: string | null,
  check: unknown,
  opts: { numericOverride?: boolean } = {}
): boolean {
  const c = asCheck(check)
  if (!c || c.status === "error") return false
  if (opts.numericOverride && c.note !== "numeric-override") return false
  if (!normaliseSku(resolvedSku)) return c.status === "no-sku"
  if (c.status === "no-sku") return false
  return normaliseSku(c.sku as string | null) === normaliseSku(resolvedSku)
}

export function checkFromResult(sku: string, result: PtSkuResult | undefined, now: Date): SkuCheck {
  const checked_at = now.toISOString()
  if (!result || result.state !== "matched") {
    return { sku, status: "not-found", checked_at }
  }
  const status: SkuCheckStatus =
    result.status === "inactive" ? "inactive" : result.status === "pre-order" ? "pre-order" : "matched"
  const check: SkuCheck = { sku, status, checked_at }
  if (result.matchedSku && normaliseSku(result.matchedSku) !== normaliseSku(sku)) {
    check.matched_sku = result.matchedSku
  }
  return check
}

// Same result as what's stored, ignoring checked_at.
const sameResult = (stored: unknown, next: SkuCheck) => {
  const c = asCheck(stored)
  return (
    !!c &&
    normaliseSku(c.sku as string | null) === normaliseSku(next.sku) &&
    c.status === next.status &&
    (c.matched_sku ?? null) === (next.matched_sku ?? null) &&
    (c.note ?? null) === (next.note ?? null)
  )
}

export type CheckVariant = { id: string; sku: string | null; metadata: Record<string, unknown> | null; profileId: string | null }

export type SkuCheckPort = {
  ptProfileIds(): Promise<string[]>
  loadVariants(input: { variantIds?: string[]; productId?: string }): Promise<CheckVariant[]>
  // Writes only metadata.print_trail_sku_check.
  writeCheck(variantId: string, check: SkuCheck): Promise<void>
  // Rows with block_reason "unmatched-skus" and confirmed_at null, with the
  // SKUs Print Trail refused (null for rows blocked before they were recorded).
  blockedRows(): Promise<{ id: string; order_id: string; sequence: number; unmatchedSkus: string[] | null }[]>
  orderVariants(orderIds: string[]): Promise<{ orderId: string; canceled: boolean; variantIds: string[] }[]>
  // Logs its own failures.
  resend(orderId: string, sequence: number): Promise<void>
}

export type SkuCheckContext = {
  client: Pick<PrintTrailClient, "validateSkus">
  state: StateStore
  port: SkuCheckPort
  now?: () => Date
  logger?: { warn(msg: string): void }
  // A SKU-only stock sync, so a newly matched SKU gets its stock (and leaves
  // the stock sync's unmatched list) without waiting for the daily run.
  refreshStock?: (skus: string[]) => Promise<void>
}

export type SkuCheckOutcome = {
  checked: { variantId: string; check: SkuCheck }[]
  skipped: string[] // variant ids whose check was current
  resent: string[] // print_trail_order row ids
  // A retryable failure (429, 5xx, network): not checked, nothing written;
  // check again later.
  retry: string[]
  // SKUs that really changed to matched or pre-order in this call.
  newlyMatched: string[]
}

// Retryable failures in a row before the check records couldn't-check.
export const SKU_CHECK_FAILURE_CAP = 3

type Failures = { count: number; lastError: string; at: string }
// Re-sends and stock refreshes owed for checks that changed to matched or
// pre-order. Recorded before the checks are written, so a write that fails
// part-way can't lose them: the retry finds those checks current.
type FollowUps = { skus: string[]; variantIds: string[] }

const RESEND_STATUSES: readonly string[] = ["matched", "pre-order"]
const KNOWN_STATUSES: SkuCheckStatus[] = ["matched", "inactive", "pre-order"]

// The client's 429, 5xx and network errors are transient; so is anything
// unexpected. A Print Trail refusal (other 4xx) is not.
const isRetryable = (e: unknown) => {
  const transient = (e as { isTransient?: unknown } | null)?.isTransient
  return typeof transient === "boolean" ? transient : true
}

const unionSkus = (a: string[], b: string[]) => [...new Map([...a, ...b].map((s) => [normaliseSku(s), s])).values()]

export async function checkVariantSkus(
  ctx: SkuCheckContext,
  input: { variantIds?: string[]; productId?: string }
): Promise<SkuCheckOutcome> {
  const now = ctx.now ? ctx.now() : new Date()
  const outcome: SkuCheckOutcome = { checked: [], skipped: [], resent: [], retry: [], newlyMatched: [] }

  const profiles = new Set(await ctx.port.ptProfileIds())
  if (!profiles.size) return outcome
  const variants = (await ctx.port.loadVariants(input)).filter((v) => v.profileId && profiles.has(v.profileId))

  const due: CheckVariant[] = []
  for (const v of variants) {
    if (isCheckCurrent(v.sku, v.metadata?.[SKU_CHECK_KEY], { numericOverride: isNumericOverride(v.metadata) })) {
      outcome.skipped.push(v.id)
    } else {
      due.push(v)
    }
  }
  if (due.length) {
    await checkDue(ctx, due, now, outcome)
  }
  await runFollowUps(ctx, outcome)
  return outcome
}

async function checkDue(ctx: SkuCheckContext, due: CheckVariant[], now: Date, outcome: SkuCheckOutcome) {
  // The stored checks as they were before this call writes any.
  const previous = new Map(due.map((v) => [v.id, asCheck(v.metadata?.[SKU_CHECK_KEY])]))

  // One call for every distinct SKU (the client chunks above 250).
  const distinct = new Map<string, string>()
  for (const v of due) {
    const k = normaliseSku(v.sku)
    if (k && !distinct.has(k)) distinct.set(k, v.sku!.trim())
  }
  let results: Map<string, PtSkuResult> | null = new Map()
  if (distinct.size) {
    const failures = await ctx.state.getState<Failures>(STATE_KEYS.skuCheckFailures)
    try {
      const validation = await ctx.client.validateSkus([...distinct.values()])
      for (const r of validation.results) {
        const k = normaliseSku(r.sku)
        if (!results.has(k)) results.set(k, r)
      }
      if (failures) await ctx.state.setState(STATE_KEYS.skuCheckFailures, null)
    } catch (e) {
      const message = String((e as Error)?.message ?? e).slice(0, 300)
      const count = (failures?.count ?? 0) + 1
      if (isRetryable(e) && count < SKU_CHECK_FAILURE_CAP) {
        // Nothing is written as couldn't-check; the caller queues them again.
        ctx.logger?.warn(`Print Trail SKU check: couldn't reach Print Trail for ${distinct.size} SKUs (${message}); will retry`)
        await ctx.state.setState(STATE_KEYS.skuCheckFailures, { count, lastError: message, at: now.toISOString() })
        outcome.retry = due.filter((v) => normaliseSku(v.sku)).map((v) => v.id)
      } else {
        ctx.logger?.warn(`Print Trail SKU check: couldn't check ${distinct.size} SKU${distinct.size === 1 ? "" : "s"}: ${message}`)
        if (failures) await ctx.state.setState(STATE_KEYS.skuCheckFailures, null)
      }
      results = null
    }
  }

  const retrying = new Set(outcome.retry)
  for (const v of due) {
    if (retrying.has(v.id)) continue
    const check: SkuCheck = !normaliseSku(v.sku)
      ? { sku: null, status: "no-sku", checked_at: now.toISOString() }
      : results === null
        ? { sku: v.sku!.trim(), status: "error", checked_at: now.toISOString() }
        : checkFromResult(v.sku!.trim(), results.get(normaliseSku(v.sku)), now)
    if (isNumericOverride(v.metadata)) check.note = "numeric-override"
    outcome.checked.push({ variantId: v.id, check })
  }

  // Checks that really changed to matched or pre-order (not a re-check of an
  // already matched SKU), against the snapshot.
  const changed = outcome.checked.filter(({ variantId, check }) => {
    if (!RESEND_STATUSES.includes(check.status)) return false
    const prev = previous.get(variantId) ?? null
    return !(
      prev &&
      RESEND_STATUSES.includes(prev.status as SkuCheckStatus) &&
      normaliseSku(prev.sku as string | null) === normaliseSku(check.sku)
    )
  })
  outcome.newlyMatched = [...new Map(changed.map((c) => [normaliseSku(c.check.sku), c.check.sku!])).values()]
  if (changed.length) {
    const stored = await ctx.state.getState<FollowUps>(STATE_KEYS.skuCheckFollowUps)
    const skus = changed.flatMap((c) => [c.check.sku, c.check.matched_sku].filter((x): x is string => !!x))
    await ctx.state.setState(STATE_KEYS.skuCheckFollowUps, {
      skus: unionSkus(stored?.skus ?? [], skus),
      variantIds: [...new Set([...(stored?.variantIds ?? []), ...changed.map((c) => c.variantId)])],
    })
  }

  for (const { variantId, check } of outcome.checked) {
    // An identical stored result (a repeated couldn't-check) isn't rewritten,
    // so its write-back event can't start another round.
    if (!sameResult(previous.get(variantId), check)) {
      await ctx.port.writeCheck(variantId, check)
    }
  }

  // The unmatched list (a changed SKU forgets the old one).
  const forget: string[] = []
  const add: string[] = []
  for (const { variantId, check } of outcome.checked) {
    const prior = previous.get(variantId) ?? null
    const prevSku = typeof prior?.sku === "string" ? prior.sku : null
    if (prevSku && normaliseSku(prevSku) !== normaliseSku(check.sku)) forget.push(prevSku)
    if (check.sku && KNOWN_STATUSES.includes(check.status)) {
      forget.push(check.sku)
      if (check.matched_sku) forget.push(check.matched_sku)
    } else if (check.sku && check.status === "not-found") {
      add.push(check.sku)
    }
  }
  if (forget.length || add.length) {
    // The SKU check's own key: unmatched_skus belongs to the stock sync.
    const stored = await ctx.state.getState<{ skus: string[] }>(STATE_KEYS.skuCheckUnmatched)
    const current = stored?.skus ?? []
    // Added SKUs win over forgotten ones (an old SKU another variant still
    // lacks is re-added by its own check).
    const next = mergeUnmatched(mergeUnmatched(current, { forget }), { add })
    if (!stored || next.join("\n") !== current.join("\n")) {
      await ctx.state.setState(STATE_KEYS.skuCheckUnmatched, { skus: next, updatedAt: now.toISOString() })
    }
  }
}

// Runs the recorded follow-ups: re-send orders blocked on those SKUs, then a
// SKU-only stock refresh. Cleared once done; a failed refresh keeps them.
async function runFollowUps(ctx: SkuCheckContext, outcome: SkuCheckOutcome) {
  const pending = await ctx.state.getState<FollowUps>(STATE_KEYS.skuCheckFollowUps)
  if (!pending?.skus?.length && !pending?.variantIds?.length) return
  const skus = new Set(pending.skus.map((s) => normaliseSku(s)).filter(Boolean))
  const variantIds = new Set(pending.variantIds)

  const rows = await ctx.port.blockedRows()
  if (rows.length) {
    const orders = await ctx.port.orderVariants([...new Set(rows.map((r) => r.order_id))])
    const byId = new Map(orders.map((o) => [o.orderId, o]))
    const done = new Set<string>()
    for (const row of rows) {
      const order = byId.get(row.order_id)
      if (done.has(row.id) || !order || order.canceled) continue
      // The SKUs Print Trail refused, when recorded; otherwise the variants.
      const relevant = row.unmatchedSkus
        ? row.unmatchedSkus.some((s) => skus.has(normaliseSku(s)))
        : order.variantIds.some((id) => variantIds.has(id))
      if (!relevant) continue
      done.add(row.id)
      try {
        await ctx.port.resend(row.order_id, row.sequence)
        outcome.resent.push(row.id)
      } catch {
        // The port logs it; carry on with the rest.
      }
    }
  }
  if (ctx.refreshStock && pending.skus.length) {
    try {
      await ctx.refreshStock(pending.skus)
    } catch (e) {
      ctx.logger?.warn(`Print Trail SKU check: stock refresh for newly matched SKUs failed: ${(e as Error)?.message ?? e}`)
      return
    }
  }
  // Clear only what this run handled; a concurrent call may have added more.
  const now = await ctx.state.getState<FollowUps>(STATE_KEYS.skuCheckFollowUps)
  const left = {
    skus: (now?.skus ?? []).filter((s) => !skus.has(normaliseSku(s))),
    variantIds: (now?.variantIds ?? []).filter((id) => !variantIds.has(id)),
  }
  await ctx.state.setState(STATE_KEYS.skuCheckFollowUps, left.skus.length || left.variantIds.length ? left : null)
}

// Row id → the SKUs of its latest "blocked" timeline entry that recorded them.
export function unmatchedSkusFromEvents(
  events: { print_trail_order_id?: string | null; kind: string; created_at?: Date | string | null; data?: unknown }[]
): Map<string, string[]> {
  const latest = new Map<string, { at: number; skus: string[] | null }>()
  for (const e of events) {
    if (e.kind !== "blocked" || !e.print_trail_order_id) continue
    const at = e.created_at ? new Date(e.created_at).getTime() : 0
    const prev = latest.get(e.print_trail_order_id)
    if (prev && prev.at > at) continue
    const skus = (e.data as { unmatched_skus?: unknown } | null)?.unmatched_skus
    latest.set(e.print_trail_order_id, {
      at,
      skus: Array.isArray(skus) ? skus.filter((s): s is string => typeof s === "string") : null,
    })
  }
  const out = new Map<string, string[]>()
  for (const [id, { skus }] of latest) if (skus) out.set(id, skus)
  return out
}
