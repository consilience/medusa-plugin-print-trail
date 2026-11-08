import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { resolvePluginOptions } from "../../config"
import { PRINT_TRAIL_MODULE } from "../../modules/printTrail"

const run = jest.fn(async () => ({ result: {} }))
jest.mock("../../workflows/send-order-to-print-trail", () => ({
  sendOrderToPrintTrailWorkflow: () => ({ run }),
}))
jest.mock("../../workflows/run-follow-ups", () => ({ runPrintTrailFollowUps: jest.fn() }))
jest.mock("../../workflows/record-print-trail-order-change", () => ({ recordPrintTrailOrderChangeWorkflow: () => ({ run: jest.fn() }) }))

// eslint-disable-next-line @typescript-eslint/no-require-imports
const handler = require("../print-trail-payment").default

const NOW = Date.now()
const container = (createdAt: string) => {
  const logs: string[] = []
  const registry: Record<string, unknown> = {
    [PRINT_TRAIL_MODULE]: {
      isConnected: async () => true,
      getOptions: async () => resolvePluginOptions({ confirmOn: "payment.captured" }),
      listPrintTrailOrders: async () => [],
    },
    [ContainerRegistrationKeys.LOGGER]: { info: (m: string) => logs.push(m), error: (m: string) => logs.push(m), warn() {} },
    [ContainerRegistrationKeys.QUERY]: {
      graph: async ({ entity }: { entity: string }) => ({
        data:
          entity === "payment"
            ? [{ id: "pay_1", payment_collection: { order: { id: "order_1" } } }]
            : [{ id: "order_1", created_at: createdAt }],
      }),
    },
  }
  return { container: { resolve: (k: string) => registry[k] }, logs }
}

describe("payment.captured with no Print Trail rows", () => {
  beforeEach(() => run.mockClear())

  it("sends a recent order", async () => {
    const { container: c } = container(new Date(NOW - 86_400_000).toISOString())
    await handler({ event: { name: "payment.captured", data: { id: "pay_1" } }, container: c })
    expect(run).toHaveBeenCalledWith({ input: { order_id: "order_1" } })
  })

  it("doesn't send an order older than the lookback, and says so", async () => {
    const { container: c, logs } = container(new Date(NOW - 30 * 86_400_000).toISOString())
    await handler({ event: { name: "payment.captured", data: { id: "pay_1" } }, container: c })
    expect(run).not.toHaveBeenCalled()
    expect(logs.join(" ")).toContain("older than 7 days")
  })
})

describe("payment.captured while this process's cached confirmOn is stale", () => {
  it("re-runs the send of the rows waiting for it: the gate decides by the setting as saved now", async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { runPrintTrailFollowUps } = require("../../workflows/run-follow-ups") as { runPrintTrailFollowUps: jest.Mock }
    runPrintTrailFollowUps.mockClear()
    const { container: c } = container(new Date(NOW - 86_400_000).toISOString())
    const service = c.resolve(PRINT_TRAIL_MODULE) as Record<string, unknown>
    // Switched to confirming on payment in the admin a moment ago; this
    // process still holds order.placed.
    service.getOptions = async () => resolvePluginOptions({ confirmOn: "order.placed" })
    service.getFreshOptions = async () => resolvePluginOptions({ confirmOn: "payment.captured" })
    service.listPrintTrailOrders = async () => [
      { order_id: "order_1", sequence: 1, confirmed_at: null, block_reason: "awaiting-payment", status: "draft" },
      { order_id: "order_1", sequence: 2, confirmed_at: new Date(NOW), status: "holding" },
      { order_id: "order_1", sequence: 3, confirmed_at: null, pending_action: "confirm", status: "draft" },
    ]
    await handler({ event: { name: "payment.captured", data: { id: "pay_1" } }, container: c })
    expect(runPrintTrailFollowUps).toHaveBeenCalledWith(c, "order_1", [1, 3])
  })
})

describe("payment.captured while orders are confirmed when placed", () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { runPrintTrailFollowUps } = require("../../workflows/run-follow-ups") as { runPrintTrailFollowUps: jest.Mock }
  const setup = (rows: Record<string, unknown>[]) => {
    runPrintTrailFollowUps.mockClear()
    run.mockClear()
    const { container: c } = container(new Date(NOW - 86_400_000).toISOString())
    const service = c.resolve(PRINT_TRAIL_MODULE) as Record<string, unknown>
    service.getOptions = async () => resolvePluginOptions({ confirmOn: "order.placed" })
    service.getFreshOptions = async () => resolvePluginOptions({ confirmOn: "order.placed" })
    service.listPrintTrailOrders = async () => rows
    return c
  }

  it("skips at once when the row is confirmed, a send is in flight, or there is no row yet (capture at checkout)", async () => {
    for (const rows of [
      [],
      [{ order_id: "order_1", sequence: 1, confirmed_at: new Date(NOW), status: "holding" }],
      [{ order_id: "order_1", sequence: 1, confirmed_at: null, pending_action: "confirm", status: "draft" }],
    ]) {
      const c = setup(rows)
      await handler({ event: { name: "payment.captured", data: { id: "pay_1" } }, container: c })
      expect(run).not.toHaveBeenCalled()
      expect(runPrintTrailFollowUps).not.toHaveBeenCalled()
    }
  })

  it("re-runs a row held for payment before a switch: now paid, the gate confirms it", async () => {
    const c = setup([
      { order_id: "order_1", sequence: 1, confirmed_at: null, block_reason: "awaiting-payment", pending_action: null, status: "draft" },
      { order_id: "order_1", sequence: 2, confirmed_at: null, block_reason: "unmatched-skus", pending_action: null, status: "draft" },
    ])
    await handler({ event: { name: "payment.captured", data: { id: "pay_1" } }, container: c })
    expect(runPrintTrailFollowUps).toHaveBeenCalledWith(c, "order_1", [1])
  })

  it("takes the full path when the settings can't be read", async () => {
    const c = setup([{ order_id: "order_1", sequence: 1, confirmed_at: null, pending_action: "confirm", status: "draft" }])
    ;(c.resolve(PRINT_TRAIL_MODULE) as Record<string, unknown>).getFreshOptions = async () => {
      throw new Error("db down")
    }
    await handler({ event: { name: "payment.captured", data: { id: "pay_1" } }, container: c })
    expect(runPrintTrailFollowUps).toHaveBeenCalledWith(c, "order_1", [1])
  })
})
