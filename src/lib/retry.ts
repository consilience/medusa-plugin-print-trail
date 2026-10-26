import { PrintTrailApiError, type AccessRefusal } from "../modules/printTrail/client/errors"

export type RetryAction = "send" | "confirm" | "cancel" | "amend" | "refetch"

export const RETRY_CAPS: Record<RetryAction, number> = {
  send: 3,
  confirm: 4,
  cancel: 3,
  amend: 3,
  refetch: 3,
}

export const RETRY_DELAY_MS = 15 * 60 * 1000
const REFETCH_DELAYS_MS = [60_000, 300_000, 900_000]

type RetryRow = { attempts?: Record<string, number> | null }

// Retries are stored state run by the print-trail-sweep job. `attempts`
// counts attempts made, including the one that just failed.
export function scheduleRetry(row: RetryRow, action: RetryAction, now: Date) {
  const made = (row.attempts?.[action] ?? 0) + 1
  const attempts = { ...(row.attempts ?? {}), [action]: made }
  // Refetch's cap counts retries (60/300/900 s, then stop: three retries);
  // the others count attempts.
  const capped = action === "refetch" ? made > RETRY_CAPS.refetch : made >= RETRY_CAPS[action]
  if (capped) {
    return {
      pending_action: null,
      attempts,
      next_attempt_at: null,
      attention: `retry-cap:${action}`,
    }
  }
  const delay =
    action === "refetch"
      ? REFETCH_DELAYS_MS[Math.min(made - 1, REFETCH_DELAYS_MS.length - 1)]
      : RETRY_DELAY_MS
  return {
    pending_action: action,
    attempts,
    next_attempt_at: new Date(now.getTime() + delay),
    attention: null,
  }
}

// Work that waits without costing an attempt: Print Trail refused access
// (a 401, the API token or channel ID; or the channel is inactive), which
// fixing the credentials or reactivating the channel undoes, or the client's
// own Retry-After pause stopped the request before it was sent. An access
// refusal waits the usual retry delay; while it's recorded, the sweep makes
// one probe per run and runs nothing else (Print Trail limits failed
// requests per IP address), so the work runs on the first sweep after access
// returns. A pause waits for its Retry-After.
export type Deferral = { delayMs: number; refusal: AccessRefusal | null }
const MIN_DEFER_MS = 1000
export const ACCESS_ATTENTION: ReadonlySet<string> = new Set<AccessRefusal>(["auth-failed", "channel-inactive"])

export function deferralFor(e: unknown): Deferral | null {
  if (!(e instanceof PrintTrailApiError)) return null
  const refusal = e.accessRefusal
  if (refusal) return { delayMs: RETRY_DELAY_MS, refusal }
  if (e.notSent) return { delayMs: Math.max(e.retryAfterMs ?? 0, MIN_DEFER_MS), refusal: null }
  return null
}

// The attention a deferral writes: its refusal, but only over no attention
// or an earlier refusal. Attention another flow raised (a capped retry, a
// shortfall, a missing order) is never overwritten; null: write nothing.
export function refusalAttention(current: string | null | undefined, refusal: AccessRefusal | null): AccessRefusal | null {
  if (!refusal) return null
  return !current || ACCESS_ATTENTION.has(current) ? refusal : null
}

// The pending action again, its count as it was before this run's lease
// (written even when 0: updates merge JSON, so a missing key keeps the lease's).
export function deferRetry(row: RetryRow, action: RetryAction, now: Date, delayMs: number) {
  return {
    pending_action: action,
    attempts: { ...(row.attempts ?? {}), [action]: row.attempts?.[action] ?? 0 },
    next_attempt_at: new Date(now.getTime() + delayMs),
  }
}

// Written before a Print Trail call, so a run that dies before recording its
// outcome is picked up by the sweep. The lease counts the attempt up front, so
// runs that keep dying still reach the cap; the outcome step takes the count
// back (uncount) and then schedules or clears as it always has.
export function lease(row: RetryRow, action: "send" | "confirm", now: Date) {
  return {
    pending_action: action,
    next_attempt_at: new Date(now.getTime() + RETRY_DELAY_MS),
    attempts: { ...(row.attempts ?? {}), [action]: (row.attempts?.[action] ?? 0) + 1 },
  }
}

// Retry counts are reset to 0, never deleted: Medusa's service update
// merges a JSON object into the stored one, so a removed key would keep its
// old count (src/modules/printTrail/__tests__/service.spec.ts).
export function zeroAttempts(attempts: Record<string, number>, keys: string[]): Record<string, number> {
  for (const key of keys) {
    attempts[key] = 0
  }
  return attempts
}

export function uncount(attempts: Record<string, number> | null | undefined, counted: RetryAction[]) {
  const out = { ...(attempts ?? {}) }
  for (const action of counted) {
    if (out[action] > 1) out[action] -= 1
    else if (action in out) out[action] = 0
  }
  return out
}

export function clearRetry(row: RetryRow, action: RetryAction) {
  const attempts = { ...(row.attempts ?? {}) }
  // Always written: a lease since this copy was read may have stored one.
  attempts[action] = 0
  return { pending_action: null, attempts, next_attempt_at: null }
}
