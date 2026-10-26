import { ADMIN_LOCK_TIMEOUT_SECONDS, orderLock } from "../order-lock"
import { SEND_LOCK_TIMEOUT_SECONDS, SEND_LOCK_TTL_SECONDS } from "../send-flow"

describe("the per-order lock", () => {
  it("waits for the lock by default and not at all for an admin action", () => {
    expect(orderLock("order_1")).toEqual({ key: "print-trail:order:order_1", timeout: SEND_LOCK_TIMEOUT_SECONDS, ttl: SEND_LOCK_TTL_SECONDS })
    expect(ADMIN_LOCK_TIMEOUT_SECONDS).toBe(0)
    expect(orderLock("order_1", ADMIN_LOCK_TIMEOUT_SECONDS, 60)).toEqual({ key: "print-trail:order:order_1", timeout: 0, ttl: 60 })
  })
})
