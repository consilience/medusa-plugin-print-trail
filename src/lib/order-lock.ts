import { SEND_LOCK_TIMEOUT_SECONDS, SEND_LOCK_TTL_SECONDS } from "./send-flow"

// Admin actions don't wait for a held lock: they answer "busy" at once, and
// anything they reset is left due for the sweep.
export const ADMIN_LOCK_TIMEOUT_SECONDS = 0

// The per-order lock every send, sync, cancel and amend run takes.
export function orderLock(orderId: string, timeout?: number, ttl: number = SEND_LOCK_TTL_SECONDS) {
  return { key: `print-trail:order:${orderId}`, timeout: timeout ?? SEND_LOCK_TIMEOUT_SECONDS, ttl }
}
