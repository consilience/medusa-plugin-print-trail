import type { ILockingModule } from "@medusajs/framework/types"
import { setTimeout as sleep } from "node:timers/promises"
import { withHeldLock } from "./reconcile"
import { checkVariantSkus, type SkuCheckContext } from "./sku-check"

// SKU checks are queued, not run per event: a bulk import saves hundreds of
// variants at once, and each save fires product-variant.updated. One run at a
// time (the print-trail:sku-check lock) drains the queue, up to 250 variants
// (so at most 250 SKUs, one validate-skus call) per batch.

export const SKU_CHECK_LOCK_KEY = "print-trail:sku-check"
// print_trail_state keys `sku_check:<variant id>`, one row per queued variant.
export const SKU_CHECK_QUEUE_PREFIX = "sku_check:"
export const SKU_CHECK_LOCK_TTL_SECONDS = 300
export const SKU_CHECK_BATCH = 250
// Bounds one run so it ends well inside the lock's ttl (one batch is one
// validate-skus call, its retries, and up to 250 metadata writes); anything
// left waits for the next event or the sweep.
const MAX_BATCHES = 8
export const SKU_CHECK_RUN_BUDGET_MS = (SKU_CHECK_LOCK_TTL_SECONDS * 1000) / 2
// Lets a burst of save events finish queueing before the first batch.
export const SKU_CHECK_SETTLE_MS = 1000

export type SkuCheckQueue = {
  add(variantIds: string[]): Promise<void>
  // Removes and returns up to `limit` queued variant ids, oldest first.
  take(limit: number): Promise<string[]>
}

export type SkuCheckQueueContext = SkuCheckContext & {
  queue: SkuCheckQueue
  logger?: { warn(msg: string): void; error(msg: string): void }
}

export type DrainOutcome = { batches: number; checked: number; retry: number }

export async function drainSkuChecks(ctx: SkuCheckQueueContext, opts: { clock?: () => number } = {}): Promise<DrainOutcome> {
  const clock = opts.clock ?? Date.now
  const started = clock()
  const out: DrainOutcome = { batches: 0, checked: 0, retry: 0 }
  while (out.batches < MAX_BATCHES) {
    // A new batch only while the run is inside its budget.
    if (out.batches > 0 && clock() - started >= SKU_CHECK_RUN_BUDGET_MS) break
    const ids = await ctx.queue.take(SKU_CHECK_BATCH)
    if (!ids.length) break
    out.batches++
    let outcome
    try {
      outcome = await checkVariantSkus(ctx, { variantIds: ids })
    } catch (e) {
      // Nothing is lost: checks already written are current next time, and
      // their re-sends and refreshes were recorded before writing.
      await ctx.queue.add(ids)
      throw e
    }
    out.checked += outcome.checked.length
    if (outcome.retry.length) {
      // Print Trail unreachable: put them back and stop; the sweep or the
      // next save tries again.
      out.retry = outcome.retry.length
      await ctx.queue.add(outcome.retry)
      break
    }
  }
  return out
}

// Takes the lock (one try, with a real ttl) and drains. A held lock leaves the
// queue for the holder's next batch, the next save or the sweep.
export async function runSkuCheckQueue(
  locking: Pick<ILockingModule, "acquire" | "release">,
  ctx: SkuCheckQueueContext,
  opts: { settleMs?: number } = {}
): Promise<{ ran: false } | { ran: true; result: DrainOutcome }> {
  return withHeldLock(locking, SKU_CHECK_LOCK_KEY, SKU_CHECK_LOCK_TTL_SECONDS, async () => {
    const settle = opts.settleMs ?? SKU_CHECK_SETTLE_MS
    if (settle > 0) await sleep(settle)
    return drainSkuChecks(ctx)
  })
}
