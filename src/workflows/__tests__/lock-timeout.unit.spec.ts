import { asValue } from "@medusajs/framework/awilix"
import { ContainerRegistrationKeys, createMedusaContainer, Modules } from "@medusajs/framework/utils"
import { sendOrderToPrintTrailWorkflow } from "../send-order-to-print-trail"
import { syncPrintTrailOrderWorkflow } from "../sync-print-trail-order"

jest.setTimeout(20000)

// A lock someone else holds: every acquire fails, as Medusa's providers do.
function heldLockContainer() {
  const acquires: unknown[] = []
  const container = createMedusaContainer()
  container.register({
    [Modules.LOCKING]: asValue({
      acquire: async (key: unknown) => {
        acquires.push(key)
        throw new Error(`Failed to acquire lock for key "${key}"`)
      },
      release: async () => true,
    }),
    [ContainerRegistrationKeys.LOGGER]: asValue({ info() {}, warn() {}, error() {}, debug() {} }),
  })
  return { container, acquires }
}

const timed = async (run: () => Promise<unknown>) => {
  const started = Date.now()
  const outcome = await run().then(
    () => "ran",
    (e: Error) => e.message
  )
  return { outcome, ms: Date.now() - started }
}

describe("lock_timeout on the per-order workflows", () => {
  it("send fails at once with lock_timeout 0, and keeps trying with a timeout", async () => {
    const fast = heldLockContainer()
    const r = await timed(() =>
      sendOrderToPrintTrailWorkflow(fast.container as never).run({ input: { order_id: "order_1", lock_timeout: 0 }, throwOnError: true })
    )
    expect(r.outcome).toMatch(/failed to acquire lock/i)
    expect(fast.acquires).toHaveLength(1)
    expect(r.ms).toBeLessThan(1000)

    const waiting = heldLockContainer()
    await timed(() =>
      sendOrderToPrintTrailWorkflow(waiting.container as never).run({ input: { order_id: "order_1", lock_timeout: 1 }, throwOnError: true })
    )
    expect(waiting.acquires.length).toBeGreaterThan(1)
  })

  it("sync fails at once with lock_timeout 0", async () => {
    const fast = heldLockContainer()
    const r = await timed(() =>
      syncPrintTrailOrderWorkflow(fast.container as never).run({
        input: { print_trail_order_id: "ptord_1", order_id: "order_1", source: "admin", lock_timeout: 0 },
        throwOnError: true,
      })
    )
    expect(r.outcome).toMatch(/failed to acquire lock/i)
    expect(fast.acquires).toHaveLength(1)
    expect(r.ms).toBeLessThan(1000)
  })
})
